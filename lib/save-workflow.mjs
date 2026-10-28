// community-service/save-workflow.ts
import { mkdir as mkdir2, open as open2, rm as rm3, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// community-service/save-github.ts
import { createHash as createHash2 } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import { Readable as Readable2 } from "node:stream";

// community-service/github.ts
import { createHash, createSign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
function jwt(config) {
  const now = Math.floor(Date.now() / 1e3);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })).toString("base64url");
  const body = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(body).sign(config.privateKey).toString("base64url");
  return `${body}.${signature}`;
}
var GitHubGateway = class {
  token = null;
  catalogCache = null;
  config;
  send;
  constructor(config, send = fetch) {
    this.config = config;
    this.send = send;
  }
  async installationToken() {
    if (this.token && this.token.expires > Date.now() + 6e4) return this.token.value;
    const response = await this.send(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt(this.config)}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ repositories: [this.config.repo], permissions: this.config.permissions ?? { contents: "write", pull_requests: "write" } })
    });
    if (!response.ok) throw new Error(`GITHUB_INSTALLATION_TOKEN_${response.status}`);
    const data = await response.json();
    this.token = { value: data.token, expires: Date.parse(data.expires_at) };
    return data.token;
  }
  async api(method, pathname, body) {
    const url = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${pathname}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.send(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${await this.installationToken()}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...body !== void 0 ? { "Content-Type": "application/json" } : {}
        },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      if (response.status === 404) return null;
      if (response.ok) return await response.json();
      if ((response.status === 429 || response.status >= 500 || response.status === 403 && response.headers.has("retry-after")) && attempt < 3) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1e3, 3e4) : 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`GITHUB_API_${method}_${response.status}`);
    }
    throw new Error("GITHUB_RETRY_EXHAUSTED");
  }
  tag(row) {
    return `guide-${row.guideId}-v${row.version}`;
  }
  branch(row) {
    return `submissions/${row.id}`;
  }
  async ensureDraft(row) {
    const tag = encodeURIComponent(this.tag(row));
    const existing = await this.api("GET", `/releases/tags/${tag}`);
    if (existing) {
      if (!existing.draft) throw new Error("GUIDE_VERSION_ALREADY_PUBLISHED");
      return existing.id;
    }
    const created = await this.api("POST", "/releases", {
      tag_name: this.tag(row),
      target_commitish: this.config.baseBranch,
      draft: true,
      prerelease: false,
      make_latest: "false",
      name: `${row.manifest.guide.title} v${row.version}`,
      body: `\u5F85\u5BA1\u6838\u653B\u7565\u3002\u6295\u7A3F ID: ${row.id}
SHA-256: ${row.packageSha256}`
    });
    if (!created) throw new Error("GITHUB_DRAFT_CREATE");
    return created.id;
  }
  async ensureAsset(row, packagePath) {
    if (!row.draftReleaseId) throw new Error("DRAFT_REQUIRED");
    const packageStat = await stat(packagePath);
    if (!packageStat.isFile()) throw new Error("PACKAGE_MISSING");
    const name = `${row.guideId}-v${row.version}.aeguide`;
    const release = await this.api("GET", `/releases/${row.draftReleaseId}`);
    if (!release) throw new Error("GITHUB_DRAFT_MISSING");
    const existing = release.assets.find((asset) => asset.name === name);
    if (existing) {
      if (existing.size !== packageStat.size || existing.digest && existing.digest !== `sha256:${row.packageSha256}`) throw new Error("GITHUB_ASSET_CONFLICT");
      return existing.id;
    }
    const base = release.upload_url.replace(/\{.*$/, "");
    const upload = new URL(base);
    if (upload.hostname !== "uploads.github.com" || upload.protocol !== "https:") throw new Error("GITHUB_UPLOAD_URL");
    upload.searchParams.set("name", name);
    const body = Readable.toWeb(createReadStream(packagePath));
    const response = await this.send(upload, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await this.installationToken()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(packageStat.size)
      },
      body,
      duplex: "half"
    });
    if (!response.ok) throw new Error(`GITHUB_ASSET_UPLOAD_${response.status}`);
    return (await response.json()).id;
  }
  async ensureReviewPr(row) {
    if (!row.draftReleaseId || !row.assetId) throw new Error("ASSET_REQUIRED");
    if (!row.changes?.length) throw new Error("COMMUNITY_CHANGES_REQUIRED");
    const branch = this.branch(row);
    const pulls = await this.api("GET", `/pulls?state=open&head=${encodeURIComponent(`${this.config.owner}:${branch}`)}`);
    if (pulls?.length) return pulls[0].number;
    const base = await this.api("GET", `/git/ref/heads/${encodeURIComponent(this.config.baseBranch)}`);
    if (!base) throw new Error("GITHUB_BASE_BRANCH_MISSING");
    try {
      await this.api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: base.object.sha });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("_422")) throw error;
    }
    const groups = /* @__PURE__ */ new Map();
    for (const change of row.changes) {
      const key = `${change.entityType}:${change.entityId}`;
      groups.set(key, [...groups.get(key) || [], change]);
    }
    const changeFiles = [...groups.entries()].map(([key, changes]) => {
      const [entityType, ...idParts] = key.split(":");
      const entityId = idParts.join(":");
      const body = JSON.stringify({ entityType, entityId, changes }, null, 2) + "\n";
      if (Buffer.byteLength(body) > 9e5) throw new Error("COMMUNITY_UNIT_TOO_LARGE");
      const digest = createHash("sha256").update(body).digest("hex");
      return {
        path: `submissions/${row.id}/units/${entityType}-${createHash("sha256").update(entityId).digest("hex").slice(0, 20)}.json`,
        body,
        sha256: digest
      };
    });
    if (changeFiles.length > 2500) throw new Error("COMMUNITY_UNIT_COUNT");
    for (const item of changeFiles) {
      const existing = await this.api("GET", `/contents/${item.path}?ref=${encodeURIComponent(branch)}`);
      if (existing) {
        if (existing.encoding !== "base64" || createHash("sha256").update(Buffer.from(existing.content.replace(/\s/g, ""), "base64")).digest("hex") !== item.sha256)
          throw new Error("COMMUNITY_PR_UNIT_CONFLICT");
        continue;
      }
      await this.api("PUT", `/contents/${item.path}`, {
        message: `Add guide unit ${item.path.split("/").at(-1)}`,
        content: Buffer.from(item.body).toString("base64"),
        branch
      });
    }
    const submitted = {
      submissionId: row.id,
      guideId: row.guideId,
      version: row.version,
      packageSha256: row.packageSha256,
      draftReleaseId: row.draftReleaseId,
      assetId: row.assetId,
      manifest: row.manifest,
      submittedAt: row.createdAt,
      baseRevision: row.baseRevision || null,
      contributor: { userId: row.userId, githubLogin: row.githubLogin },
      changeFiles: changeFiles.map(({ path: path3, sha256 }) => ({ path: path3, sha256 }))
    };
    const filename = `submissions/${row.id}.json`;
    const file = await this.api("GET", `/contents/${filename}?ref=${encodeURIComponent(branch)}`);
    if (!file) await this.api("PUT", `/contents/${filename}`, {
      message: `Submit guide ${row.guideId} v${row.version}`,
      content: Buffer.from(JSON.stringify(submitted, null, 2)).toString("base64"),
      branch
    });
    const created = await this.api("POST", "/pulls", {
      title: `\u653B\u7565\u6295\u7A3F\uFF1A${row.manifest.guide.title} v${row.version}`,
      head: branch,
      base: this.config.baseBranch,
      body: `\u63D0\u4EA4\u4EBA\uFF1A@${row.githubLogin}

\u653B\u7565\uFF1A${row.manifest.guide.title} v${row.version}
\u6E38\u620F\uFF1A${row.manifest.game.title}
\u57FA\u7840\u4FEE\u8BA2\uFF1A${row.baseRevision || "\u65B0\u5EFA\u72EC\u7ACB\u793E\u533A\u653B\u7565"}
\u53D8\u66F4\u5355\u5143\uFF1A${changeFiles.length} \u4E2A
\u8D44\u6E90\uFF1A${row.manifest.assets.length} \u5F20
\u5305 SHA-256\uFF1A\`${row.packageSha256}\`
\u8349\u7A3F Release ID\uFF1A${row.draftReleaseId}

\u8BF7\u5148\u68C0\u67E5\u5177\u4F53\u653B\u7565\u5355\u5143\uFF0C\u518D\u7531\u7EF4\u62A4\u8005\u6279\u51C6\u5408\u5E76\u3002`,
      draft: false
    });
    if (!created) throw new Error("GITHUB_PR_CREATE");
    return created.number;
  }
  async reviewState(number2) {
    const pr = await this.api("GET", `/pulls/${number2}`);
    if (!pr) throw new Error("GITHUB_PR_MISSING");
    return pr.merged ? "merged" : pr.state === "open" ? "open" : "closed";
  }
  async catalog(force = false) {
    if (!force && this.catalogCache && this.catalogCache.expires > Date.now()) return this.catalogCache.value;
    const file = await this.api("GET", `/contents/catalog/index.json?ref=${encodeURIComponent(this.config.baseBranch)}`);
    if (!file || file.encoding !== "base64") throw new Error("GITHUB_CATALOG_MISSING");
    const data = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (data.schemaVersion !== 1 || !Array.isArray(data.entries)) throw new Error("GITHUB_CATALOG_SCHEMA");
    this.catalogCache = { value: data, expires: Date.now() + 6e4 };
    return data;
  }
  async downloadAssetToFile(assetId, maxBytes, outputPath) {
    if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new Error("ASSET_ID_INVALID");
    const response = await this.send(`https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/releases/assets/${assetId}`, {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${await this.installationToken()}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok || !response.body) throw new Error(`GITHUB_ASSET_DOWNLOAD_${response.status}`);
    const declaredHeader = response.headers.get("content-length");
    const declaredSize = declaredHeader ? Number(declaredHeader) : void 0;
    if (declaredSize !== void 0 && (!Number.isSafeInteger(declaredSize) || declaredSize > maxBytes))
      throw new Error("ASSET_TOO_LARGE");
    let total = 0;
    const hash = createHash("sha256");
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error("ASSET_TOO_LARGE"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(
        Readable.from(response.body),
        limiter,
        createWriteStream(outputPath, { flags: "wx" })
      );
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => void 0);
      throw error;
    }
    if (declaredSize !== void 0 && total !== declaredSize) {
      await rm(outputPath, { force: true });
      throw new Error("GITHUB_ASSET_LENGTH_MISMATCH");
    }
    return { size: total, sha256: hash.digest("hex") };
  }
};

// src/utils/aesave-rules.ts
var AESAVE_LIMITS = {
  archiveBytes: 256 * 1024 ** 2,
  totalBytes: 256 * 1024 ** 2,
  entryBytes: 256 * 1024 ** 2,
  entries: 502,
  files: 500,
  metadataBytes: 1024 ** 2,
  depth: 24
};
var COMMUNITY_SAVES_REPOSITORY = "dxydjl0521-maker/achievement-engine-saves";
var SAVE_PURPOSES = ["pre_unlock", "branch_point", "chapter_start", "manual_checkpoint", "general_progress", "other"];
var SAVE_ORIGINS = ["automatic", "manual", "external", "community"];
var SHA256 = /^[a-f0-9]{64}$/;
var SAVE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function saveGameKey(value) {
  if (typeof value !== "string" || !/^steam:[1-9]\d{0,9}$/.test(value) || !Number.isSafeInteger(Number(value.slice(6)))) throw new Error("GAME_KEY_INVALID");
  return value;
}
function safeSaveRelative(value) {
  if (typeof value !== "string" || !value || value.length > 240 || value !== value.normalize("NFC") || /[\\\x00-\x1f\x7f:]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= AESAVE_LIMITS.depth && parts.every((part) => !!part && part !== "." && part !== ".." && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part));
}
function safeAesaveEntry(name) {
  return name === "manifest.json" || name === "checksums.json" || /^files\/root-(?:0|[1-9]\d*)\//.test(name) && safeSaveRelative(name.slice(6));
}
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("MANIFEST_FIELDS");
  return value;
}
function text(value, max, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max || !allowEmpty && !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error("MANIFEST_TEXT");
}
function validateSaveCompatibility(value) {
  const item = object(value, ["gameBuild", "dlcIds", "saveSlot", "accountPortability"]);
  for (const key of ["gameBuild", "saveSlot"]) if (item[key] !== null) text(item[key], 120);
  if (!Array.isArray(item.dlcIds) || item.dlcIds.length > 100 || item.dlcIds.some((id) => typeof id !== "string" || !/^[1-9]\d{0,9}$/.test(id)) || new Set(item.dlcIds).size !== item.dlcIds.length || !["unknown", "portable", "bound"].includes(String(item.accountPortability))) throw new Error("COMPATIBILITY_INVALID");
  return item;
}
function validateAesaveManifest(value) {
  const manifest = object(value, ["format", "schemaVersion", "resourceId", "game", "save", "compatibility", "achievements", "roots", "files"]);
  if (manifest.format !== "aesave" || manifest.schemaVersion !== 1 || !(manifest.resourceId === null || typeof manifest.resourceId === "string" && SAVE_UUID.test(manifest.resourceId))) throw new Error("AESAVE_FORMAT");
  const game = object(manifest.game, ["platform", "platformGameId"]);
  if (game.platform !== "steam" || typeof game.platformGameId !== "string") throw new Error("GAME_PLATFORM_INVALID");
  saveGameKey(`steam:${game.platformGameId}`);
  const save = object(manifest.save, ["title", "purpose", "origin", "capturedAtUtc", "contentFingerprint"]);
  text(save.title, 160);
  if (!SAVE_PURPOSES.includes(save.purpose) || !SAVE_ORIGINS.includes(save.origin) || typeof save.contentFingerprint !== "string" || !SHA256.test(save.contentFingerprint)) throw new Error("SAVE_METADATA_INVALID");
  if (save.capturedAtUtc !== null && (typeof save.capturedAtUtc !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(save.capturedAtUtc) || !Number.isFinite(Date.parse(save.capturedAtUtc)) || new Date(save.capturedAtUtc).toISOString() !== save.capturedAtUtc)) throw new Error("SAVE_TIME_INVALID");
  validateSaveCompatibility(manifest.compatibility);
  if (!Array.isArray(manifest.roots) || !manifest.roots.length || manifest.roots.length > 16) throw new Error("SAVE_ROOTS_INVALID");
  const roots = /* @__PURE__ */ new Set();
  for (const [index, source] of manifest.roots.entries()) {
    const root = object(source, ["id", "label"]);
    if (root.id !== `root-${index}` || root.label !== `\u5B58\u6863\u76EE\u5F55 ${index + 1}`) throw new Error("SAVE_ROOTS_INVALID");
    roots.add(root.id);
  }
  if (!Array.isArray(manifest.achievements) || manifest.achievements.length > 500) throw new Error("SAVE_ACHIEVEMENTS_INVALID");
  const achievements = /* @__PURE__ */ new Set();
  for (const source of manifest.achievements) {
    const link = object(source, ["platformAchievementId", "relation"]);
    text(link.platformAchievementId, 160);
    if (!["candidate", "reference"].includes(String(link.relation)) || achievements.has(link.platformAchievementId)) throw new Error("SAVE_ACHIEVEMENTS_INVALID");
    achievements.add(link.platformAchievementId);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > AESAVE_LIMITS.files) throw new Error("SAVE_FILES_INVALID");
  const paths = /* @__PURE__ */ new Set();
  let total = 0;
  for (const source of manifest.files) {
    const file = object(source, ["root", "path", "size", "sha256"]);
    if (!roots.has(String(file.root)) || !safeSaveRelative(file.path) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > AESAVE_LIMITS.entryBytes || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) throw new Error("SAVE_FILE_INVALID");
    const key = `${file.root}/${file.path}`.toLowerCase();
    if (paths.has(key)) throw new Error("SAVE_PATH_COLLISION");
    paths.add(key);
    if ((total += Number(file.size)) > AESAVE_LIMITS.totalBytes) throw new Error("SAVE_TOTAL_SIZE");
  }
  for (const key of paths) {
    const parts = key.split("/");
    for (let at = 1; at < parts.length; at++) if (paths.has(parts.slice(0, at).join("/"))) throw new Error("SAVE_PATH_COLLISION");
  }
  return manifest;
}
function canonicalSaveFiles(files) {
  return JSON.stringify([...files].sort((a, b) => `${a.root}/${a.path}` < `${b.root}/${b.path}` ? -1 : `${a.root}/${a.path}` === `${b.root}/${b.path}` ? 0 : 1).map((file) => [file.root, file.path, file.size, file.sha256]));
}
function canonicalSaveCompatibility(value) {
  return JSON.stringify({ gameBuild: value.gameBuild, dlcIds: [...value.dlcIds].sort(), saveSlot: value.saveSlot, accountPortability: value.accountPortability });
}
function validateCommunitySaveResource(value, expectedGame) {
  const item = object(value, [
    "id",
    "versionId",
    "gameKey",
    "title",
    "description",
    "purpose",
    "origin",
    "achievements",
    "compatibility",
    "contributor",
    "verification",
    "achievementEvidence",
    "loadEvidence",
    "packageSha256",
    "contentFingerprint",
    "bytes",
    "fileCount",
    "publishedAt",
    "repository",
    "assetId",
    "tag",
    "assetName",
    "status"
  ]);
  if (typeof item.id !== "string" || !SAVE_UUID.test(item.id) || typeof item.versionId !== "string" || !SAVE_UUID.test(item.versionId) || saveGameKey(item.gameKey) !== (expectedGame ?? item.gameKey) || !SHA256.test(String(item.packageSha256)) || !SHA256.test(String(item.contentFingerprint)) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 22 || Number(item.bytes) > AESAVE_LIMITS.archiveBytes || !Number.isSafeInteger(item.fileCount) || Number(item.fileCount) < 1 || Number(item.fileCount) > AESAVE_LIMITS.files || !Number.isSafeInteger(item.assetId) || Number(item.assetId) <= 0 || item.repository !== COMMUNITY_SAVES_REPOSITORY || item.tag !== `save-${item.id}-${item.versionId}` || item.assetName !== `${item.id}-${item.versionId}.aesave` || !["published", "delisted", "withdrawn", "deprecated"].includes(String(item.status))) throw new Error("RESOURCE_INVALID");
  text(item.title, 160);
  text(typeof item.description === "string" ? item.description.replace(/[\r\n\t]/g, " ") : item.description, 4e3, true);
  if (!SAVE_PURPOSES.includes(item.purpose) || !SAVE_ORIGINS.includes(item.origin) || !["submitted", "file_verified", "load_verified", "achievement_reproduced"].includes(String(item.verification))) throw new Error("RESOURCE_INVALID");
  const contributor = object(item.contributor, ["id", "login"]);
  if (!Number.isSafeInteger(contributor.id) || Number(contributor.id) <= 0 || !/^[a-z0-9-]{1,39}$/i.test(String(contributor.login))) throw new Error("RESOURCE_CONTRIBUTOR");
  if (!Array.isArray(item.achievements) || item.achievements.length > 500 || item.achievements.some((id) => typeof id !== "string" || !id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id)) || new Set(item.achievements).size !== item.achievements.length) throw new Error("RESOURCE_ACHIEVEMENTS");
  const evidence = item.achievementEvidence;
  if (item.loadEvidence !== void 0) text(item.loadEvidence, 2e3);
  if (item.verification === "load_verified" && !item.loadEvidence) throw new Error("RESOURCE_LOAD_EVIDENCE");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.entries(evidence).some(([id, note]) => !item.achievements.includes(id) || typeof note !== "string" || !note.trim() || note.length > 2e3)) throw new Error("RESOURCE_EVIDENCE");
  if (item.verification === "achievement_reproduced" && !item.achievements.some((id) => Object.hasOwn(evidence, id))) throw new Error("RESOURCE_EVIDENCE");
  if (typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt))) throw new Error("RESOURCE_TIME");
  validateSaveCompatibility(item.compatibility);
  return item;
}

// community-service/save-github.ts
var API = `https://api.github.com/repos/${COMMUNITY_SAVES_REPOSITORY}`;
var SaveGitHubGateway = class {
  constructor(config, send = fetch, tokenOverride) {
    this.send = send;
    this.tokenOverride = tokenOverride;
    const [owner, repo] = COMMUNITY_SAVES_REPOSITORY.split("/");
    this.branch = config.baseBranch || "main";
    if (!/^[a-z0-9/_-]+$/i.test(this.branch) || this.branch.includes("..")) throw new Error("SAVE_BRANCH_INVALID");
    this.tokens = new GitHubGateway({ ...config, owner, repo, baseBranch: this.branch, permissions: { contents: "write" } }, send);
  }
  send;
  tokenOverride;
  tokens;
  branch;
  token() {
    return this.tokenOverride ? this.tokenOverride() : this.tokens.installationToken();
  }
  async request(method, route, body) {
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("SAVE_GITHUB_PATH");
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.send(API + route, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(6e4),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${await this.token()}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...body === void 0 ? {} : { "Content-Type": "application/json" }
        },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
      if (response.status === 404) return null;
      if (response.ok) return response.status === 204 ? null : await response.json();
      if (attempt < 3 && (response.status === 429 || response.status >= 500 || response.status === 403 && response.headers.has("retry-after"))) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, seconds > 0 ? Math.min(3e4, seconds * 1e3) : 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`SAVE_GITHUB_${method}_${response.status}`);
    }
    throw new Error("SAVE_GITHUB_RETRY");
  }
  async json(file, ref) {
    let result = await this.request("GET", `/contents/${file}?ref=${encodeURIComponent(ref)}`);
    if (!result) return null;
    if (result.encoding === "none" && result.sha && /^[a-f0-9]{40}$/.test(result.sha)) result = await this.request("GET", `/git/blobs/${result.sha}`);
    if (!result) throw new Error("SAVE_CATALOG_MISSING");
    if (result.encoding !== "base64" || result.size > 20 * 1024 ** 2 || typeof result.content !== "string") throw new Error("SAVE_CATALOG_SIZE");
    return JSON.parse(Buffer.from(result.content, "base64").toString("utf8"));
  }
  async updateMetadata(resource) {
    await this.catalogCommit(resource, true);
  }
  async readCatalog(gameKey) {
    saveGameKey(gameKey);
    const value = await this.json(`catalog/games/steam/${gameKey.slice(6)}.json`, this.branch);
    if (!value) return [];
    if (value.schemaVersion !== 1 || !Array.isArray(value.resources) || value.resources.length > 1e4) throw new Error("SAVE_CATALOG_INVALID");
    return value.resources.map((item) => validateCommunitySaveResource(item, gameKey));
  }
  async catalogCommit(resource, onlyExisting = false) {
    validateCommunitySaveResource(resource);
    for (let attempt = 0; attempt < 4; attempt++) {
      const ref = await this.request("GET", `/git/ref/heads/${encodeURIComponent(this.branch)}`);
      if (!ref) throw new Error("SAVE_REPOSITORY_NOT_INITIALIZED");
      const base = await this.request("GET", `/git/commits/${ref.object.sha}`);
      if (!base) throw new Error("SAVE_BASE_MISSING");
      const file = `catalog/games/steam/${resource.gameKey.slice(6)}.json`, resourceFile = `resources/${resource.id}.json`;
      const original = await this.json(resourceFile, ref.object.sha);
      if (onlyExisting && !original) return;
      const game = await this.json(file, ref.object.sha);
      const index = await this.json("catalog/index.json", ref.object.sha);
      if (!index || index.schemaVersion !== 1 || !Array.isArray(index.games) || original && (!Array.isArray(original.versions) || original.id !== resource.id) || game && (game.schemaVersion !== 1 || game.gameKey !== resource.gameKey || !Array.isArray(game.resources))) throw new Error("SAVE_CATALOG_INVALID");
      const versions = (original?.versions || []).map((item) => validateCommunitySaveResource(item, resource.gameKey));
      if (versions.some((item) => item.contributor.id !== resource.contributor.id)) throw new Error("SAVE_RESOURCE_OWNER_IMMUTABLE");
      const current = versions.find((item) => item.versionId === resource.versionId);
      if (current && current.packageSha256 !== resource.packageSha256) throw new Error("SAVE_VERSION_IMMUTABLE");
      const nextVersions = [...versions.filter((item) => item.versionId !== resource.versionId), resource];
      const resources = [...(game?.resources || []).map((item) => validateCommunitySaveResource(item, resource.gameKey)).filter((item) => item.id !== resource.id || item.versionId !== resource.versionId), resource];
      const published = resources.filter((item) => item.status === "published");
      const nextIndex = { schemaVersion: 1, games: [
        ...index.games.filter((item) => item.gameKey !== resource.gameKey),
        { gameKey: resource.gameKey, publishedCount: published.length, coveredAchievements: new Set(published.flatMap((item) => item.achievements)).size }
      ] };
      const contents = [
        { path: "catalog/index.json", value: nextIndex },
        { path: file, value: { schemaVersion: 1, gameKey: resource.gameKey, resources } },
        { path: resourceFile, value: { schemaVersion: 1, id: resource.id, gameKey: resource.gameKey, currentVersionId: resource.versionId, versions: nextVersions } }
      ];
      const tree = await this.request("POST", "/git/trees", { base_tree: base.tree.sha, tree: contents.map((item) => ({ path: item.path, mode: "100644", type: "blob", content: JSON.stringify(item.value, null, 2) + "\n" })) });
      if (!tree) throw new Error("SAVE_TREE_CREATE");
      const commit = await this.request("POST", "/git/commits", { message: `${resource.status === "published" ? "Publish" : "Delist"} reviewed save ${resource.id}`, tree: tree.sha, parents: [ref.object.sha] });
      if (!commit) throw new Error("SAVE_COMMIT_CREATE");
      try {
        await this.request("PATCH", `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
        return;
      } catch (error) {
        if (attempt === 3 || !String(error).match(/_(?:409|422)$/)) throw error;
      }
    }
  }
  async verifyRemoteAsset(asset, expected) {
    if (asset.size !== expected.bytes) throw new Error("SAVE_ASSET_SIZE");
    if (asset.digest) {
      if (asset.digest !== `sha256:${expected.packageSha256}`) throw new Error("SAVE_ASSET_HASH");
      return;
    }
    let url = `${API}/releases/assets/${asset.id}`, authorization = true;
    const hash = createHash2("sha256");
    let bytes = 0;
    for (let hop = 0; hop < 5; hop++) {
      const response = await this.send(url, { redirect: "manual", signal: AbortSignal.timeout(12e4), headers: { Accept: "application/octet-stream", ...authorization ? { Authorization: `Bearer ${await this.token()}` } : {} } });
      if (response.status >= 300 && response.status < 400) {
        const target = new URL(response.headers.get("location") || "", url);
        if (target.protocol !== "https:" || target.username || target.password || !["release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"].includes(target.hostname)) throw new Error("SAVE_ASSET_REDIRECT");
        authorization = false;
        url = target.href;
        continue;
      }
      if (!response.ok || !response.body) throw new Error("SAVE_ASSET_READ");
      for await (const chunk of Readable2.fromWeb(response.body)) {
        bytes += chunk.length;
        if (bytes > expected.bytes) throw new Error("SAVE_ASSET_SIZE");
        hash.update(chunk);
      }
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.packageSha256) throw new Error("SAVE_ASSET_HASH");
      return;
    }
    throw new Error("SAVE_ASSET_REDIRECT_LIMIT");
  }
  async publish(resource, packagePath) {
    validateCommunitySaveResource(resource);
    const info = await stat2(packagePath);
    if (info.size !== resource.bytes || !info.isFile()) throw new Error("SAVE_PACKAGE_MISSING");
    const original = await this.json(`resources/${resource.id}.json`, this.branch);
    if (original) {
      if (!Array.isArray(original.versions)) throw new Error("SAVE_CATALOG_INVALID");
      for (const item of original.versions) {
        validateCommunitySaveResource(item, resource.gameKey);
        if (item.contributor.id !== resource.contributor.id) throw new Error("SAVE_RESOURCE_OWNER_IMMUTABLE");
        if (item.versionId === resource.versionId) {
          if (item.status !== "published" || item.packageSha256 !== resource.packageSha256) throw new Error("SAVE_VERSION_REVOKED_OR_CHANGED");
          resource = item;
        }
      }
    }
    if (await this.json(`withdrawals/${resource.id}/${resource.versionId}.json`, this.branch)) throw new Error("SAVE_VERSION_WITHDRAWN");
    let release = await this.request("GET", `/releases/tags/${resource.tag}`);
    if (!release) release = await this.request("POST", "/releases", {
      tag_name: resource.tag,
      target_commitish: this.branch,
      draft: true,
      prerelease: false,
      make_latest: "false",
      name: resource.title,
      body: `Reviewed achievement save
Resource: ${resource.id}
Version: ${resource.versionId}
SHA-256: ${resource.packageSha256}
Contributor GitHub ID: ${resource.contributor.id}`
    });
    if (!release) throw new Error("SAVE_RELEASE_CREATE");
    let asset = release.assets.find((item) => item.name === resource.assetName);
    if (!asset) {
      if (!release.draft) throw new Error("SAVE_VERSION_IMMUTABLE");
      const url = new URL(release.upload_url.replace(/\{.*$/, ""));
      if (url.protocol !== "https:" || url.hostname !== "uploads.github.com" || url.username || url.password || !url.pathname.startsWith(`/repos/${COMMUNITY_SAVES_REPOSITORY}/releases/`)) throw new Error("SAVE_UPLOAD_URL");
      url.searchParams.set("name", resource.assetName);
      const response = await this.send(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10 * 6e4), headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/vnd.achievement-engine.save+zip",
        "Content-Length": String(info.size)
      }, body: Readable2.toWeb(createReadStream2(packagePath)), duplex: "half" });
      if (!response.ok) throw new Error(`SAVE_ASSET_UPLOAD_${response.status}`);
      asset = await response.json();
    }
    await this.verifyRemoteAsset(asset, resource);
    const published = { ...resource, assetId: asset.id };
    if (release.draft) await this.request("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "false" });
    await this.catalogCommit(published);
    return published;
  }
  async delist(resource) {
    validateCommunitySaveResource(resource);
    const release = await this.request("GET", `/releases/tags/${resource.tag}`);
    if (release) await this.request("DELETE", `/releases/${release.id}`);
    await this.catalogCommit(resource, true);
  }
};

// community-service/save-package.ts
import { createHash as createHash3 } from "node:crypto";
import { createReadStream as createReadStream3, createWriteStream as createWriteStream2 } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm as rm2, stat as stat3 } from "node:fs/promises";
import path from "node:path";

// src/utils/aesave-zip.ts
var encoder = new TextEncoder();
async function writeAesaveZipEntriesTo(entries, write) {
  if (entries.length > AESAVE_LIMITS.entries) throw new Error("ZIP_FILE_COUNT");
  const central = [];
  const prepared = [];
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    if (!safeAesaveEntry(entry.name)) throw new Error(`ZIP_PATH: ${entry.name}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > AESAVE_LIMITS.entryBytes)
      throw new Error(`ZIP_ENTRY_SIZE: ${entry.name}`);
    total += entry.size;
    if (total > AESAVE_LIMITS.totalBytes) throw new Error("ZIP_TOTAL_SIZE");
    const filename = encoder.encode(entry.name);
    const header = new Uint8Array(30 + filename.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 67324752, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 2048, true);
    h.setUint32(14, entry.crc32, true);
    h.setUint32(18, entry.size, true);
    h.setUint32(22, entry.size, true);
    h.setUint16(26, filename.length, true);
    header.set(filename, 30);
    const record = new Uint8Array(46 + filename.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 33639248, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 2048, true);
    c.setUint32(16, entry.crc32, true);
    c.setUint32(20, entry.size, true);
    c.setUint32(24, entry.size, true);
    c.setUint16(28, filename.length, true);
    c.setUint32(42, offset, true);
    record.set(filename, 46);
    central.push(record);
    prepared.push({ name: filename, entry, offset, header });
    offset += header.length + entry.size;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const archiveSize = offset + centralSize + 22;
  if (archiveSize > AESAVE_LIMITS.archiveBytes) throw new Error("ZIP_ARCHIVE_SIZE");
  for (const item of prepared) {
    await write(item.header);
    let written = 0;
    await item.entry.writeData(async (chunk) => {
      if (!(chunk instanceof Uint8Array) || !chunk.length || written + chunk.length > item.entry.size)
        throw new Error(`ZIP_ENTRY_LENGTH: ${item.entry.name}`);
      written += chunk.length;
      await write(chunk);
    });
    if (written !== item.entry.size) throw new Error(`ZIP_ENTRY_LENGTH: ${item.entry.name}`);
  }
  for (const record of central) await write(record);
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 101010256, true);
  footer.setUint16(8, entries.length, true);
  footer.setUint16(10, entries.length, true);
  footer.setUint32(12, centralSize, true);
  footer.setUint32(16, offset, true);
  await write(end);
  return archiveSize;
}

// community-service/save-package.ts
var decoder = new TextDecoder("utf-8", { fatal: true });
var AESAVE_CHUNK_BYTES = 256 * 1024;
async function readAt(file, position, length) {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(result, offset, length - offset, position + offset);
    if (!read.bytesRead) throw new Error("ZIP_TRUNCATED");
    offset += read.bytesRead;
  }
  return result;
}
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
var savePackageFingerprint = (files) => createHash3("sha256").update(canonicalSaveFiles(files)).digest("hex");
async function hashAesaveFile(filePath, guard = () => {
}) {
  const hash = createHash3("sha256");
  for await (const chunk of createReadStream3(filePath, { highWaterMark: AESAVE_CHUNK_BYTES })) {
    guard();
    hash.update(chunk);
  }
  guard();
  return hash.digest("hex");
}
var ACTIVE_EXTENSIONS = /\.(?:exe|dll|com|scr|bat|cmd|ps1|psm1|psd1|js|mjs|cjs|jse|vbs|vbe|hta|html?|svg|url|lnk|sh|py|pyc|lua|rb|jar|class|msi|msix|reg|sys|ocx|chm|docm|xlsm|zip|7z|rar|aesave)$/i;
var CREDENTIAL_NAMES = /(?:^|\/)(?:loginusers\.vdf|ssfn\d+|config\.vdf|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|cookies(?:\..*)?|login data)$/i;
var PERSONAL = /(?:7656119\d{10}|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|(?:access[_-]?token|refresh[_-]?token|password|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s"',}{]{8,})/i;
async function privacyFindings(filePath, entries, manifest, guard) {
  const findings = [];
  const add = (code, severity, message) => {
    if (!findings.some((item) => item.code === code)) findings.push({ code, severity, message });
  };
  if (PERSONAL.test(JSON.stringify(manifest))) add("PERSONAL_METADATA", "block", "\u516C\u5F00\u5B57\u6BB5\u6216\u6587\u4EF6\u540D\u5305\u542B\u7591\u4F3C\u4E2A\u4EBA\u8D26\u53F7\u3001\u7EDD\u5BF9\u8DEF\u5F84\u6216\u51ED\u636E");
  if (manifest.compatibility.accountPortability !== "portable") add("PORTABILITY_UNCONFIRMED", "review", "\u8D26\u53F7\u53EF\u79FB\u690D\u6027\u5C1A\u672A\u786E\u8BA4\u6216\u660E\u786E\u53D7\u9650");
  if (!manifest.compatibility.gameBuild) add("BUILD_UNCONFIRMED", "review", "\u5C1A\u672A\u8BB0\u5F55\u7ECF\u8FC7\u9A8C\u8BC1\u7684\u6E38\u620F\u7248\u672C");
  for (const item of manifest.files) {
    guard();
    if (ACTIVE_EXTENSIONS.test(item.path) || CREDENTIAL_NAMES.test(item.path)) add("ACTIVE_OR_CREDENTIAL_FILE", "block", "\u5305\u542B\u4E3B\u52A8\u5185\u5BB9\u3001\u538B\u7F29\u5BB9\u5668\u6216\u7591\u4F3C\u8BA4\u8BC1\u6587\u4EF6");
    if (!/\.(?:json|txt|xml|ini|cfg)$/i.test(item.path)) add("GAME_FORMAT_REVIEW", "review", "\u4E13\u6709\u6216\u672A\u77E5\u5B58\u6863\u683C\u5F0F\u9700\u8981\u6E38\u620F\u9002\u914D\u4E0E\u4EBA\u5DE5\u5BA1\u6838");
    const entry = entries.get(`files/${item.root}/${item.path}`);
    let tail = "", first = true;
    if (!entry.size) continue;
    for await (const chunk of createReadStream3(filePath, { start: entry.dataStart, end: entry.dataStart + entry.size - 1, highWaterMark: AESAVE_CHUNK_BYTES })) {
      guard();
      const bytes = chunk;
      if (first && (bytes.subarray(0, 2).toString("ascii") === "MZ" || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes.subarray(0, 2).toString("ascii") === "#!" || ["cafebabe", "feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(bytes.subarray(0, 4).toString("hex")))) add("ACTIVE_MAGIC", "block", "\u5B58\u6863\u6587\u4EF6\u5305\u542B\u7A0B\u5E8F\u6216\u811A\u672C\u7B7E\u540D");
      first = false;
      const text2 = tail + bytes.toString("utf8").replace(/\0/g, "");
      if (PERSONAL.test(text2)) add("PERSONAL_PAYLOAD", "block", "\u5B58\u6863\u5185\u5BB9\u5305\u542B\u7591\u4F3C\u4E2A\u4EBA\u8D26\u53F7\u3001\u8DEF\u5F84\u6216\u51ED\u636E\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u6539\u5199\u539F\u6587\u4EF6");
      tail = text2.slice(-2048);
    }
  }
  return findings;
}
function updateCrc(crc, bytes) {
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
  }
  return crc;
}
async function hashEntry(filePath, entry, guard = () => {
}) {
  const hash = createHash3("sha256");
  let crc = -1;
  if (entry.size) {
    for await (const chunk of createReadStream3(filePath, {
      start: entry.dataStart,
      end: entry.dataStart + entry.size - 1,
      highWaterMark: AESAVE_CHUNK_BYTES
    })) {
      guard();
      const bytes = chunk;
      hash.update(bytes);
      crc = updateCrc(crc, bytes);
    }
  }
  if ((crc ^ -1) >>> 0 !== entry.crc) throw new Error(`ZIP_CRC: ${entry.name}`);
  return hash.digest("hex");
}
async function readEntry(file, entry, limit) {
  if (entry.size > limit) throw new Error(`ZIP_ENTRY_SIZE: ${entry.name}`);
  return readAt(file, entry.dataStart, entry.size);
}
async function inspectZip(filePath, guard) {
  guard();
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error("PACKAGE_SYMLINK");
  guard();
  if (!info.isFile() || info.size < 22 || info.size > AESAVE_LIMITS.archiveBytes) throw new Error("ZIP_ARCHIVE_SIZE");
  const file = await open(filePath, "r");
  try {
    const end = await readAt(file, info.size - 22, 22);
    const footer = view(end);
    if (footer.getUint32(0, true) !== 101010256 || footer.getUint16(4, true) !== 0 || footer.getUint16(6, true) !== 0 || footer.getUint16(20, true) !== 0) throw new Error("ZIP_END");
    const count = footer.getUint16(10, true);
    const centralSize = footer.getUint32(12, true);
    const centralStart = footer.getUint32(16, true);
    if (count > AESAVE_LIMITS.entries || count !== footer.getUint16(8, true)) throw new Error("ZIP_FILE_COUNT");
    if (centralStart + centralSize !== info.size - 22 || centralSize > AESAVE_LIMITS.entries * 1200)
      throw new Error("ZIP_CENTRAL_BOUNDS");
    const central = await readAt(file, centralStart, centralSize);
    const centralView = view(central);
    const entries = /* @__PURE__ */ new Map();
    const localRanges = [];
    let at = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      guard();
      if (at + 46 > central.length || centralView.getUint32(at, true) !== 33639248) throw new Error("ZIP_CENTRAL_ENTRY");
      const flags = centralView.getUint16(at + 8, true);
      const method = centralView.getUint16(at + 10, true);
      const crc = centralView.getUint32(at + 16, true);
      const compressed = centralView.getUint32(at + 20, true);
      const size = centralView.getUint32(at + 24, true);
      const nameLength = centralView.getUint16(at + 28, true);
      const extraLength = centralView.getUint16(at + 30, true);
      const commentLength = centralView.getUint16(at + 32, true);
      const externalAttrs = centralView.getUint32(at + 38, true);
      const localOffset = centralView.getUint32(at + 42, true);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || nameLength > 1024) throw new Error("ZIP_CENTRAL_BOUNDS");
      const name = decoder.decode(central.subarray(at + 46, at + 46 + nameLength));
      if (!safeAesaveEntry(name) || entries.has(name)) throw new Error(`ZIP_PATH: ${name}`);
      if (flags !== 2048 || method !== 0 || compressed !== size) throw new Error(`ZIP_UNSUPPORTED: ${name}`);
      if (![0, 32768].includes(externalAttrs >>> 16 & 61440) || externalAttrs & 1040) throw new Error(`ZIP_SPECIAL_FILE: ${name}`);
      if (extraLength || commentLength) throw new Error("ZIP_EXTRA_FIELDS");
      if (size > AESAVE_LIMITS.entryBytes || (total += size) > AESAVE_LIMITS.totalBytes) throw new Error("ZIP_SIZE");
      if (localOffset + 30 > centralStart) throw new Error("ZIP_LOCAL_BOUNDS");
      const local = await readAt(file, localOffset, 30);
      const localView = view(local);
      const localNameLength = localView.getUint16(26, true);
      const localExtraLength = localView.getUint16(28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (localExtraLength || localNameLength !== nameLength) throw new Error("ZIP_EXTRA_FIELDS");
      if (localView.getUint32(0, true) !== 67324752 || localView.getUint16(6, true) !== flags || localView.getUint16(8, true) !== method || localView.getUint32(14, true) !== crc || localView.getUint32(18, true) !== size || localView.getUint32(22, true) !== size || dataStart + size > centralStart) throw new Error("ZIP_LOCAL_BOUNDS");
      const localName = decoder.decode(await readAt(file, localOffset + 30, localNameLength));
      if (localName !== name) throw new Error("ZIP_LOCAL_BOUNDS");
      entries.set(name, { name, size, crc, dataStart });
      localRanges.push({ start: localOffset, end: dataStart + size });
      at = next;
    }
    if (at !== central.length || entries.size < 3) throw new Error("ZIP_CENTRAL_TRAILING");
    localRanges.sort((a, b) => a.start - b.start);
    let expectedStart = 0;
    for (const range of localRanges) {
      if (range.start !== expectedStart) throw new Error("ZIP_LOCAL_GAP");
      expectedStart = range.end;
    }
    if (expectedStart !== centralStart) throw new Error("ZIP_LOCAL_GAP");
    return entries;
  } finally {
    await file.close();
  }
}
async function inspectAesaveFile(filePath, guard = () => {
}) {
  const entries = await inspectZip(filePath, guard);
  const manifestEntry = entries.get("manifest.json"), checksumsEntry = entries.get("checksums.json");
  if (!manifestEntry || !checksumsEntry) throw new Error("AESAVE_REQUIRED_FILES");
  const file = await open(filePath, "r");
  let manifest, checksums;
  try {
    guard();
    manifest = validateAesaveManifest(JSON.parse(decoder.decode(await readEntry(file, manifestEntry, AESAVE_LIMITS.metadataBytes))));
    guard();
    const value = JSON.parse(decoder.decode(await readEntry(file, checksumsEntry, AESAVE_LIMITS.metadataBytes)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CHECKSUMS_INVALID");
    checksums = value;
  } finally {
    await file.close();
  }
  const expected = /* @__PURE__ */ new Set(["manifest.json", ...manifest.files.map((item) => `files/${item.root}/${item.path}`)]);
  if (entries.size !== expected.size + 1 || Object.keys(checksums).length !== expected.size || Object.keys(checksums).some((name) => !expected.has(name) || !SHA256.test(String(checksums[name])))) throw new Error("CHECKSUMS_INVALID");
  for (const name of expected) {
    guard();
    const entry = entries.get(name);
    if (!entry || await hashEntry(filePath, entry, guard) !== checksums[name]) throw new Error("AESAVE_HASH_MISMATCH");
  }
  await hashEntry(filePath, checksumsEntry, guard);
  for (const item of manifest.files) {
    const name = `files/${item.root}/${item.path}`;
    if (entries.get(name).size !== item.size || checksums[name] !== item.sha256) throw new Error("AESAVE_FILE_INDEX_MISMATCH");
  }
  if (savePackageFingerprint(manifest.files) !== manifest.save.contentFingerprint) throw new Error("AESAVE_FINGERPRINT_MISMATCH");
  const findings = await privacyFindings(filePath, entries, manifest, guard);
  const sha256 = await hashAesaveFile(filePath, guard), info = await stat3(filePath);
  guard();
  if (info.size > AESAVE_LIMITS.archiveBytes) throw new Error("ZIP_ARCHIVE_SIZE");
  return { manifest, entries, sha256, bytes: info.size, findings };
}
async function assertPlainSource(target) {
  const resolved = path.resolve(target), actual = await realpath(resolved);
  if ((process.platform === "win32" ? actual.toLowerCase() !== resolved.toLowerCase() : actual !== resolved) || (await lstat(resolved)).isSymbolicLink()) throw new Error("SAVE_SOURCE_LINK");
}
async function writeAesaveFile(outputPath, appId, sources, metadata, origin, capturedAtUtc, guard = () => {
}) {
  if (!sources.length || sources.length > AESAVE_LIMITS.files) throw new Error("SAVE_SOURCE_LIMIT");
  const files = [], payloads = [];
  let total = 0;
  for (const source of sources) {
    guard();
    await assertPlainSource(source.absolutePath);
    guard();
    const before = await stat3(source.absolutePath);
    if (!before.isFile() || (total += before.size) > AESAVE_LIMITS.totalBytes) throw new Error("SAVE_SOURCE_LIMIT");
    let crc = -1;
    const hash = createHash3("sha256");
    for await (const chunk of createReadStream3(source.absolutePath, { highWaterMark: AESAVE_CHUNK_BYTES })) {
      guard();
      hash.update(chunk);
      crc = updateCrc(crc, chunk);
    }
    const after = await stat3(source.absolutePath);
    guard();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("SAVE_SOURCE_CHANGED");
    const sha256 = hash.digest("hex"), root = `root-${source.rootIndex}`;
    files.push({ root, path: source.relativePath, size: before.size, sha256 });
    payloads.push({
      name: `files/${root}/${source.relativePath}`,
      size: before.size,
      crc32: (crc ^ -1) >>> 0,
      async writeData(write) {
        const check = createHash3("sha256");
        for await (const chunk of createReadStream3(source.absolutePath, { highWaterMark: AESAVE_CHUNK_BYTES })) {
          guard();
          check.update(chunk);
          await write(chunk);
        }
        guard();
        if (check.digest("hex") !== sha256) throw new Error("SAVE_SOURCE_CHANGED");
      }
    });
  }
  const rootCount = Math.max(...sources.map((source) => source.rootIndex)) + 1;
  const manifest = validateAesaveManifest({
    format: "aesave",
    schemaVersion: 1,
    resourceId: null,
    game: { platform: "steam", platformGameId: String(appId) },
    save: {
      title: metadata.title,
      purpose: metadata.purpose,
      origin,
      capturedAtUtc,
      contentFingerprint: savePackageFingerprint(files)
    },
    compatibility: metadata.compatibility,
    achievements: metadata.achievements.map((id) => ({ platformAchievementId: id, relation: "candidate" })),
    roots: Array.from({ length: rootCount }, (_, index) => ({ id: `root-${index}`, label: `\u5B58\u6863\u76EE\u5F55 ${index + 1}` })),
    files
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const checksums = Object.fromEntries([
    ["manifest.json", createHash3("sha256").update(manifestBytes).digest("hex")],
    ...files.map((file) => [`files/${file.root}/${file.path}`, file.sha256])
  ]);
  const metadataEntry = (name, bytes) => ({
    name,
    size: bytes.length,
    crc32: (updateCrc(-1, bytes) ^ -1) >>> 0,
    writeData: (write) => write(bytes)
  });
  const output = await open(outputPath, "wx");
  try {
    await writeAesaveZipEntriesTo([metadataEntry("manifest.json", manifestBytes), metadataEntry("checksums.json", Buffer.from(JSON.stringify(checksums))), ...payloads], async (chunk) => {
      guard();
      let offset = 0;
      while (offset < chunk.length) {
        const written = await output.write(chunk, offset, chunk.length - offset);
        if (!written.bytesWritten) throw new Error("SAVE_WRITE_FAILED");
        offset += written.bytesWritten;
      }
    });
    await output.close();
    guard();
    return await inspectAesaveFile(outputPath, guard);
  } catch (error) {
    await output.close().catch(() => {
    });
    await rm2(outputPath, { force: true });
    throw error;
  }
}

// community-service/save-submission.ts
function validateGithubSaveSubmission(value, author, sourceRepository) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SUBMISSION_INVALID");
  const record = value;
  const keys = ["schemaVersion", "id", "resourceId", "versionId", "packageSha256", "bytes", "manifest", "description", "contributor", "submittedAt", "agreement", "package"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || record.schemaVersion !== 1 || ![record.id, record.resourceId, record.versionId].every((id) => typeof id === "string" && SAVE_UUID.test(id)) || typeof record.packageSha256 !== "string" || !SHA256.test(record.packageSha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 22 || record.bytes > AESAVE_LIMITS.archiveBytes || record.agreement !== "community-save-public-fork-v1" || !record.contributor || record.contributor.id !== author.id || record.contributor.login !== author.login || typeof record.description !== "string" || !record.description.trim() || record.description.length > 4e3 || !Number.isFinite(Date.parse(record.submittedAt))) throw new Error("SUBMISSION_INVALID");
  if (/(?:[c-z]:[\\/]|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|-----BEGIN .*PRIVATE KEY|7656119\d{10}|(?:password|access_token)\s*[:=])/i.test(record.description)) throw new Error("SUBMISSION_PRIVACY");
  validateAesaveManifest(record.manifest);
  const source = record.package;
  if (!source || source.repository.toLowerCase() !== sourceRepository.toLowerCase() || sourceRepository.toLowerCase() !== `${author.login}/achievement-engine-saves`.toLowerCase() || !Number.isSafeInteger(source.releaseId) || source.releaseId <= 0 || !Number.isSafeInteger(source.assetId) || source.assetId <= 0 || source.tag !== `submission-${record.id}` || source.name !== `${record.id}.aesave`) throw new Error("SUBMISSION_SOURCE");
  return record;
}
async function inspectGithubSaveSubmission(record, file) {
  const parsed = await inspectAesaveFile(file);
  if (parsed.sha256 !== record.packageSha256 || parsed.bytes !== record.bytes || JSON.stringify(parsed.manifest) !== JSON.stringify(record.manifest)) throw new Error("SUBMISSION_PACKAGE_MISMATCH");
  if (parsed.findings.some((item) => item.severity === "block")) throw new Error("SUBMISSION_SAFETY_BLOCK");
}
function githubSubmissionResource(record, publishedAt) {
  return {
    id: record.resourceId,
    versionId: record.versionId,
    gameKey: `steam:${record.manifest.game.platformGameId}`,
    title: record.manifest.save.title,
    description: record.description,
    purpose: record.manifest.save.purpose,
    origin: record.manifest.save.origin,
    achievements: record.manifest.achievements.map((item) => item.platformAchievementId),
    compatibility: record.manifest.compatibility,
    contributor: record.contributor,
    verification: "file_verified",
    achievementEvidence: {},
    packageSha256: record.packageSha256,
    contentFingerprint: record.manifest.save.contentFingerprint,
    bytes: record.bytes,
    fileCount: record.manifest.files.length,
    publishedAt,
    repository: COMMUNITY_SAVES_REPOSITORY,
    assetId: 1,
    tag: `save-${record.resourceId}-${record.versionId}`,
    assetName: `${record.resourceId}-${record.versionId}.aesave`,
    status: "published"
  };
}

// community-service/save-workflow.ts
var repository = COMMUNITY_SAVES_REPOSITORY;
var api = "https://api.github.com";
var env = process.env;
var token = () => {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN_REQUIRED");
  return env.GH_TOKEN;
};
async function request(method, route, body) {
  if (!route.startsWith("/repos/" + repository + "/") && !/^\/repos\/[a-z0-9-]+\/achievement-engine-saves(?:\/|$)/i.test(route)) throw new Error("API_ROUTE");
  const response = await fetch(api + route, { method, redirect: "error", headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...body === void 0 ? {} : { "Content-Type": "application/json" } }, signal: AbortSignal.timeout(6e4), ...body === void 0 ? {} : { body: JSON.stringify(body) } });
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  return response.status === 204 ? void 0 : await response.json();
}
function number(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("NUMBER_INVALID");
  return parsed;
}
async function json(repo, file, ref) {
  const data = await request("GET", `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`);
  if (data.size > 1024 ** 2 || data.encoding !== "base64") throw new Error("JSON_LIMIT");
  return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
}
function gateway() {
  return new SaveGitHubGateway({ appId: "", installationId: "", privateKey: "" }, fetch, async () => token());
}
async function submission(publish) {
  const pr = await request("GET", `/repos/${repository}/pulls/${number(env.PR_NUMBER)}`);
  if (!/^[a-f0-9]{40}$/.test(env.PR_HEAD_SHA || "") || pr.head.sha !== env.PR_HEAD_SHA || pr.base.ref !== "main" || pr.base.repo.full_name !== repository || pr.user.type !== "User") throw new Error("PR_IDENTITY_OR_REVISION");
  const files = await request("GET", `/repos/${repository}/pulls/${pr.number}/files?per_page=100`);
  if (files.length !== 1 || files[0].status !== "added" || !/^submissions\/[a-f0-9-]{36}\.json$/.test(files[0].filename)) throw new Error("ONLY_NEW_SUBMISSION_METADATA_ALLOWED");
  const source = pr.head.repo.full_name, repo = await request("GET", `/repos/${source}`);
  if (repo.owner.id !== pr.user.id || source !== repository && (!repo.fork || repo.parent?.full_name !== repository)) throw new Error("SOURCE_REPOSITORY_IDENTITY");
  const record = validateGithubSaveSubmission(await json(source, files[0].filename, pr.head.sha), pr.user, source);
  if (files[0].filename !== `submissions/${record.id}.json`) throw new Error("SUBMISSION_FILENAME");
  if (publish) {
    if (!pr.merged_at) throw new Error("MERGED_REVIEW_REQUIRED");
    const reviews = await request("GET", `/repos/${repository}/pulls/${pr.number}/reviews?per_page=100`);
    const latest = /* @__PURE__ */ new Map();
    for (const review of reviews) latest.set(review.user.id, review);
    let approved = false;
    for (const review of latest.values()) if (review.user.id !== pr.user.id && review.state === "APPROVED" && review.commit_id === pr.head.sha) {
      const permission = await request("GET", `/repos/${repository}/collaborators/${review.user.login}/permission`);
      if (["admin", "maintain", "write"].includes(permission.permission)) approved = true;
    }
    if (!approved) throw new Error("INDEPENDENT_MAINTAINER_APPROVAL_REQUIRED");
  }
  const release = await request("GET", `/repos/${source}/releases/${record.package.releaseId}`);
  const asset = release.assets.find((item) => item.id === record.package.assetId);
  if (release.author.id !== pr.user.id || release.tag_name !== record.package.tag || !asset || asset.name !== record.package.name || asset.size !== record.bytes) throw new Error("SOURCE_ASSET_IDENTITY");
  const directory = path2.resolve(".save-validation");
  await mkdir2(directory, { recursive: true });
  const file = path2.join(directory, "package.aesave");
  await rm3(file, { force: true });
  let address = new URL(`${api}/repos/${source}/releases/assets/${asset.id}`), response;
  for (let redirect = 0; redirect < 6; redirect++) {
    const isApi = address.origin === api, allowed = isApi || ["release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"].includes(address.hostname) && address.protocol === "https:" && !address.username && !address.password;
    if (!allowed) throw new Error("ASSET_REDIRECT");
    response = await fetch(address, { redirect: "manual", headers: { Accept: "application/octet-stream", ...isApi ? { Authorization: `Bearer ${token()}` } : {} }, signal: AbortSignal.timeout(18e4) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      address = new URL(response.headers.get("location") || "", address);
      await response.body?.cancel();
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error("ASSET_DOWNLOAD");
  let bytes = 0;
  const output = await open2(file, "wx", 384);
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > record.bytes) throw new Error("ASSET_LIMIT");
      let at = 0;
      while (at < chunk.length) {
        const result = await output.write(chunk, at, chunk.length - at);
        if (!result.bytesWritten) throw new Error("WRITE_FAILED");
        at += result.bytesWritten;
      }
    }
  } finally {
    await output.close();
  }
  await inspectGithubSaveSubmission(record, file);
  await promisify(execFile)("clamscan", ["--no-summary", "--max-filesize=256M", "--max-scansize=512M", "--max-recursion=5", "--alert-exceeds-max=yes", file], { timeout: 24e4, maxBuffer: 1024 ** 2 });
  if (publish) {
    const port = gateway(), catalog = await port.readCatalog(`steam:${record.manifest.game.platformGameId}`);
    const duplicate = catalog.find((item) => item.status === "published" && item.contentFingerprint === record.manifest.save.contentFingerprint && canonicalSaveCompatibility(item.compatibility) === canonicalSaveCompatibility(record.manifest.compatibility) && item.versionId !== record.versionId);
    if (duplicate) throw new Error("DUPLICATE_CONTENT_AND_COMPATIBILITY");
    await port.publish(githubSubmissionResource(record, new Date(pr.merged_at).toISOString()), file);
  }
  console.log(publish ? "Reviewed save published" : "Save package, GitHub identity, privacy and malware checks passed; gameplay review still required");
}
async function manage() {
  const issue = await request("GET", `/repos/${repository}/issues/${number(env.ISSUE_NUMBER)}`);
  if (issue.body.length > 12e3) throw new Error("ISSUE_LIMIT");
  let action;
  try {
    action = JSON.parse(issue.body);
  } catch {
    console.log("Ordinary issue; no automatic action");
    return;
  }
  if (action.schemaVersion !== 1 || !SAVE_UUID.test(action.resourceId) || !["withdraw", "delist", "verify_load", "verify_achievement"].includes(action.action)) {
    console.log("No resource-management action");
    return;
  }
  let file = await json(repository, `resources/${action.resourceId}.json`, "main").catch((error) => {
    if (error instanceof Error && error.message === "GITHUB_404") return null;
    throw error;
  });
  if (!file && action.action === "withdraw" && SAVE_UUID.test(action.submissionId || "")) {
    const record = await json(repository, `submissions/${action.submissionId}.json`, "main");
    validateGithubSaveSubmission(record, record.contributor, record.package.repository);
    if (record.resourceId !== action.resourceId || record.versionId !== action.versionId) throw new Error("WITHDRAW_SUBMISSION_IDENTITY");
    file = { id: record.resourceId, versions: [githubSubmissionResource(record, record.submittedAt)] };
  }
  if (!file) throw new Error("RESOURCE_NOT_FOUND");
  const resources = file.versions.map((item) => validateCommunitySaveResource(item));
  if (file.id !== action.resourceId || !resources.length) throw new Error("RESOURCE_IDENTITY");
  const permission = await request("GET", `/repos/${repository}/collaborators/${issue.user.login}/permission`).catch((error) => {
    if (error instanceof Error && error.message === "GITHUB_404") return { permission: "none" };
    throw error;
  });
  const maintainer = ["admin", "write", "maintain"].includes(permission.permission);
  const selected = resources.filter((item) => !action.versionId || item.versionId === action.versionId);
  if (!selected.length) throw new Error("VERSION_NOT_FOUND");
  if (action.action === "withdraw" && !selected.every((item) => item.contributor.id === issue.user.id) && !maintainer) throw new Error("WITHDRAW_AUTHOR_REQUIRED");
  if (action.action !== "withdraw" && !maintainer) throw new Error("MAINTAINER_REQUIRED");
  const port = gateway();
  if (["withdraw", "delist"].includes(action.action)) {
    for (const item of selected) {
      const file2 = `withdrawals/${item.id}/${item.versionId}.json`;
      try {
        await json(repository, file2, "main");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "GITHUB_404") throw error;
        await request("PUT", `/repos/${repository}/contents/${file2}`, { message: `Revoke save version ${item.versionId}`, content: Buffer.from(JSON.stringify({ schemaVersion: 1, resourceId: item.id, versionId: item.versionId, actorId: issue.user.id, issueNumber: issue.number, at: (/* @__PURE__ */ new Date()).toISOString() })).toString("base64") });
      }
      await port.delist({ ...item, status: action.action === "withdraw" ? "withdrawn" : "delisted" });
    }
  } else {
    if (selected.length !== 1 || !action.versionId || typeof action.note !== "string" || action.note.trim().length < 12 || action.note.length > 1500 || typeof action.gameBuild !== "string" || !action.gameBuild.trim()) throw new Error("VERIFICATION_FIELDS");
    if (/(?:7656119\d{10}|[c-z]:[\\/]|gh[pousr]_[a-z0-9]{20,}|password\s*[:=])/i.test(action.note)) throw new Error("VERIFICATION_PRIVACY");
    const resource = selected[0];
    if (resource.contributor.id === issue.user.id || resource.status !== "published" || resource.compatibility.gameBuild !== action.gameBuild) throw new Error("INDEPENDENT_VERSION_SPECIFIC_VERIFICATION_REQUIRED");
    const evidence = `${action.gameBuild} \xB7 reviewer #${issue.user.id} \xB7 ${(/* @__PURE__ */ new Date()).toISOString()} \xB7 issue #${issue.number} \xB7 ${action.note.trim()}`;
    if (action.action === "verify_achievement") {
      if (!action.achievementId || !resource.achievements.includes(action.achievementId)) throw new Error("ACHIEVEMENT_NOT_LINKED");
      resource.achievementEvidence[action.achievementId] = evidence;
      resource.verification = "achievement_reproduced";
      resource.loadEvidence ??= evidence;
    } else {
      resource.loadEvidence = evidence;
      if (resource.verification !== "achievement_reproduced") resource.verification = "load_verified";
    }
    await port.updateMetadata(resource);
  }
  await request("POST", `/repos/${repository}/issues/${issue.number}/comments`, { body: ["withdraw", "delist"].includes(action.action) ? "\u5DF2\u9A8C\u8BC1\u8BF7\u6C42\u8005\u8EAB\u4EFD\u5E76\u505C\u6B62\u65B0\u4E0B\u8F7D\uFF1B\u672C\u5730\u526F\u672C\u548C\u516C\u5171\u7F13\u5B58\u65E0\u6CD5\u64A4\u9500\u3002" : "\u5DF2\u8BB0\u5F55\u72EC\u7ACB\u7EF4\u62A4\u8005\u9488\u5BF9\u56FA\u5B9A\u6E38\u620F\u7248\u672C\u7684\u9A8C\u8BC1\u8BF4\u660E\uFF1B\u9010\u6210\u5C31\u8BC1\u636E\u4EC5\u5E94\u7528\u4E8E\u6240\u5217\u6210\u5C31\u3002" });
  await request("PATCH", `/repos/${repository}/issues/${issue.number}`, { state: "closed" });
  console.log("Resource delisted with retained catalog tombstone");
}
var mode = env.AE_SAVE_MODE;
async function selfTest() {
  const directory = await mkdtemp(path2.join(os.tmpdir(), "aesave-format-check-"));
  if (!path2.resolve(directory).startsWith(path2.resolve(os.tmpdir()) + path2.sep)) throw new Error("TEMP_PATH");
  try {
    const source = path2.join(directory, "slot.json"), file = path2.join(directory, "synthetic.aesave");
    await writeFile(source, '{"checkpoint":1}');
    const parsed = await writeAesaveFile(file, 10, [{ rootIndex: 0, relativePath: "slot.json", absolutePath: source }], { title: "Synthetic format validation", description: "Temporary format test only", purpose: "manual_checkpoint", achievements: [], compatibility: { gameBuild: "test", dlcIds: [], saveSlot: null, accountPortability: "portable" } }, "external", null);
    if (parsed.manifest.files.length !== 1 || parsed.findings.some((item) => item.severity === "block") || JSON.stringify(parsed.manifest).includes(directory)) throw new Error("SELF_TEST_FAILED");
    console.log("aesave schema, streaming ZIP, hashes and logical paths: PASS; no user saves used");
  } finally {
    await rm3(directory, { recursive: true, force: true });
  }
}
if (mode === "self-test") void selfTest().catch((error) => {
  console.error(error instanceof Error ? error.message : "SELF_TEST_FAILED");
  process.exitCode = 1;
});
else if (mode === "validate" || mode === "publish") void submission(mode === "publish").catch((error) => {
  console.error(error instanceof Error ? error.message : "VALIDATION_FAILED");
  process.exitCode = 1;
});
else if (mode === "manage") void manage().catch((error) => {
  console.error(error instanceof Error ? error.message : "MANAGEMENT_FAILED");
  process.exitCode = 1;
});
else throw new Error("AE_SAVE_MODE_INVALID");
