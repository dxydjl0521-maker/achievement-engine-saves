# 维护部署

首版按作者选择采用与社区攻略相同的 GitHub 模式：客户端 OAuth Device Flow → 个人公开 fork 的待审 Release → 元数据 PR → Actions 校验 → 独立维护者审核合并 → 正式 Release 与目录。无需服务器、域名或 App 私钥。

客户端仅包含公开 OAuth Client ID，普通用户授权 `public_repo`，不需要官方仓库权限。待审包在个人 fork 中已经公开，上传前须同意 `community-save-public-fork-v1`。这不能提供私有隔离的保密性，敏感或不能确认的文件不得上传。

维护者保留 Actions 并允许 fork PR 工作流；首次贡献者的运行可能需要人工批准。建议 main Ruleset 要求 `save-validation` 和一位审核者批准。发布脚本要求同一 head SHA 具有**非投稿者的维护者批准**，因此需要至少一位独立协作者；作者不能自审自发。

校验只读运行基础分支的 `lib/save-workflow.mjs`，不执行投稿分支代码。扫描器、病毒库或任何校验失败均不得发布。合并后发布工作流重新验证身份、摘要、扫描和审批，再发布资产并原子更新目录。失败可用 workflow_dispatch 提供同一 PR 号和精确 head SHA 重试。未知存档格式、账号绑定、版本、DLC 和槽位仍须人工核查。

客户端撤回会关闭未合并 PR、删除个人待审 Release；已发布资源通过结构化 Issue 请求撤回。工作流核对 Issue 作者 numeric ID 与贡献者 ID 后移除正式资产并保留目录标记。管理员可提交 `action: delist`。举报也是公开 Issue，不得附带隐私内容。已经下载的副本和公共缓存无法撤销。

```json
{"schemaVersion":1,"action":"withdraw","resourceId":"UUID","versionId":"UUID","reason":"作者请求撤回"}
```

可选私有隔离服务可由源码 `npm run build:community` 构建为 `dist-community/save-server.mjs`，供未来使用。该服务不是首版 GitHub 模式的前提。不要将客户端源码、用户资料、密钥或真实测试存档复制到公开仓库。

## 独立游戏验证

具有写权限且不是贡献者本人的维护者可提交以下结构化 Issue，由管理工作流记录 numeric ID、时间、Issue 号与具体游戏版本。`verify_load` 记录载入结果；`verify_achievement` 只为所列的已关联成就记录复现证据，不会把整包所有成就都标为复现。`gameBuild` 必须与资源声明一致，`note` 至少 12 字，需写清槽位、DLC、实际步骤与结果。

```json
{"schemaVersion":1,"action":"verify_achievement","resourceId":"UUID","versionId":"UUID","gameBuild":"1.0","achievementId":"STEAM_API_NAME","note":"在相同版本与声明 DLC 下成功载入，按说明完成步骤并观察到该成就解锁。"}
```
