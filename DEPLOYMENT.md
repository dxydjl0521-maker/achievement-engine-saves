# 维护部署

首版按作者选择采用与社区攻略相同的 GitHub 模式：客户端 OAuth Device Flow → 个人公开 fork 的待审 Release → 元数据 PR → Actions 校验 → 独立维护者审核合并 → 正式 Release 与目录。无需服务器、域名或 App 私钥。

客户端仅包含公开 OAuth Client ID，普通用户授权 `public_repo`，不需要官方仓库权限。待审包在个人 fork 中已经公开，上传前须同意 `community-save-public-fork-v1`。这不能提供私有隔离的保密性，敏感或不能确认的文件不得上传。

维护者保留 Actions 并允许 fork PR 工作流；首次贡献者的运行可能需要人工批准。建议 main Ruleset 要求 `save-validation` 和一位审核者批准。普通人工审核要求同一 head SHA 具有**非投稿者的维护者批准**，作者不能人工自审。下述受限自动通道允许任意登录投稿者提交符合条件的系统自动存档。

校验只读运行基础分支的 `lib/save-workflow.mjs`，不执行投稿分支代码。扫描器、病毒库或任何校验失败均不得发布。合并后发布工作流重新验证身份、摘要、扫描和审批，再发布资产并原子更新目录。失败可用 workflow_dispatch 提供同一 PR 号和精确 head SHA 重试。账号可移植性、游戏版本是否记录和存档格式是否已适配不再产生审核提示或阻止自动审核；这些兼容信息仍作为资源元数据供下载者查看。来源证明、包摘要、隐私与主动内容检查、恶意内容扫描等门槛保持有效。

官方仓库所有者向自己的仓库投稿时，源 Release 保持 **draft**，不把待审文件公开为正式资源。GitHub 读取草稿需要 push 权限，因此校验分为公开 fork 的只读任务和仅限“源仓库等于官方仓库且 PR 作者 numeric ID 等于仓库所有者”的草稿任务；后者的 contents: write 仅用于读取草稿，validate 模式拒绝所有非 GET 请求。两者均固定检出基础分支代码，最终 `save-validation` 必须恰有一个任务成功，另一个跳过。独立审批、扫描和正式发布门禁不变。

手动重跑所有者的草稿时，workflow_dispatch 还需将 `owner_draft` 设为 true，并提供精确 PR head SHA。脚本再次验证来源和作者，不能用此选项读取普通 fork 的私有资产。直接重跑修复前的旧 run 会继续使用旧工作流；需要从最新 main 手动启动，或重新打开未合并 PR 触发新的检查。

客户端撤回会关闭未合并 PR、删除个人待审 Release；已发布资源通过结构化 Issue 请求撤回。工作流核对 Issue 作者 numeric ID 与贡献者 ID 后移除正式资产并保留目录标记。管理员可提交 `action: delist`。举报也是公开 Issue，不得附带隐私内容。已经下载的副本和公共缓存无法撤销。

```json
{"schemaVersion":1,"action":"withdraw","resourceId":"UUID","versionId":"UUID","reason":"作者请求撤回"}
```

可选私有隔离服务可由源码 `npm run build:community` 构建为 `dist-community/save-server.mjs`，供未来使用。该服务不是首版 GitHub 模式的前提。不要将客户端源码、用户资料、密钥或真实测试存档复制到公开仓库。

## 批量人工审核与系统自动审核

升级时一起部署 `lib/save-workflow.mjs`、`save-review-policy.json`、`validate-save.yml`、`publish-save.yml` 和新增的 `.github/workflows/review-saves.yml`。不要先单独部署能力标记；旧版严格解析器不认识新的 `automaticCapture` 投稿字段。`.aesave` 格式没有变化，旧客户端仍可下载使用。没有来源声明的旧投稿继续人工审核。

在仓库 Settings → Actions → General 允许 **Allow GitHub Actions to create and approve pull requests**。`GITHUB_TOKEN` 需要 contents: write、pull-requests: write、actions: read。保留分支保护；工作流不绕过必需检查、独立审批数或要求最新基础分支的规则。若保护规则不接受机器人批准，应由维护者补充独立审批，不能降低保护来强行合并。

维护者在软件的社区存档页打开 GitHub 账号菜单 → **批量审核存档投稿**，查看详情、勾选最多 25 条，填写至少 12 字的公开审核说明并确认。客户端固定每条 PR 的 head SHA，云端重新校验作者、单文件变更、资产身份、完整摘要、隐私和恶意内容后，逐条批准、合并、发布。手动备份和社区导入也可使用人工批量审核；复核提示需要审核人检查，阻断风险和扫描失败不能放行。无法人工审核自己的投稿。界面“已提交”只表示工作流进入队列，最终逐条结果见 Actions 摘要。

自动审核默认关闭。部署完模板后，在仓库 Settings → Secrets and variables → Actions → Variables 添加 **`AE_SAVE_AUTO_REVIEW=true`** 即可启用。对所有登录投稿者开放，不设投稿者白名单。仅当来源声明指向由系统自动采集的完整、已校验快照，且包摘要、内容指纹、采集时间、manifest、隐私检查与病毒扫描全部通过时，才自动批准合并并发布。**不要求是系统当前绑定的成就存档，也不要求绑定任何成就**；同一成就有多个自动存档时，可选其中任意一份。手动备份、恢复前备份、外部导入、社区下载和来源缺失仍保留人工审核；账号可移植性、游戏版本和专有或未知存档格式不再触发人工审核。独立实机载入/成就复现验证仍另行进行。

来源声明由客户端主进程读取原始快照记录后生成，绑定具体包 SHA-256、内容指纹和采集时间；它不写入可再次导入的存档包，因此导出再导入不会继承自动审核资格。**这是客户端来源声明，并非不可伪造的游戏运行证明**。开源本地客户端没有服务器签发的采集凭证；恶意投稿者仍可能自行构造元数据。自动审核只标记 `file_verified`，绝不表示实机载入或成就复现通过。若运营要求抵抗主动伪造，应保持自动通道关闭，直到部署受信采集证明机制。

自动工作流由校验成功的 `workflow_run` 触发，始终只检出官方 `main`，不执行 PR 代码、不读取上游构建产物，并重新下载扫描原始包。机器人审批必须附带绑定 head SHA 和包摘要的回执；发布时核对官方审核工作流运行身份。由 `GITHUB_TOKEN` 合并的 PR 通常不会再次触发 Actions，因此同一工作流显式调用发布门禁。[GitHub 触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

每条失败独立记录，其他条目继续；重复内容不重复发布。已合并但发布失败时，可重跑原审核任务，或在 Publish save 工作流中填写原 PR 号与原 head SHA 重试。合并前版本发生变化时必须刷新并重新选择；因保护规则需要更新基础分支时，更新后重新运行校验。撤回和下架仍具有优先权。关闭自动通道后，新启动的发布任务不再接受自动回执；如需立即停止正在运行的任务，请同时在 Actions 取消该任务。

可选隔离服务支持 `/v1/saves/review-access`、`/v1/saves/review-queue` 和 `/v1/saves/review-batch`；开启同一来源策略使用服务环境变量 `AE_SAVES_AUTO_REVIEW=true`。扫描器缺失或报错时不自动通过，服务重启后只重试已持久化的批准和发布任务。

## 独立游戏验证

具有写权限且不是贡献者本人的维护者可提交以下结构化 Issue，由管理工作流记录 numeric ID、时间、Issue 号与具体游戏版本。`verify_load` 记录载入结果；`verify_achievement` 只为所列的已关联成就记录复现证据，不会把整包所有成就都标为复现。`gameBuild` 必须与资源声明一致，`note` 至少 12 字，需写清槽位、DLC、实际步骤与结果。

```json
{"schemaVersion":1,"action":"verify_achievement","resourceId":"UUID","versionId":"UUID","gameBuild":"1.0","achievementId":"STEAM_API_NAME","note":"在相同版本与声明 DLC 下成功载入，按说明完成步骤并观察到该成就解锁。"}
```
