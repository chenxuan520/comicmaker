# AGENTS.md

## 项目结构

- 产品名为“页间”，项目名为 `comicmaker`。使用现有 TypeScript ESM、Commander、React/Vite、Zod、Handlebars、OpenAI SDK 与 `node:sqlite`，遵循所在文件的风格及 `.js` 导入约定。
- `src/core/` 是 CLI 与 Web 共用的业务流水线、提示词、审查和预算逻辑；通过 `src/core/ports.ts` 抽象 I/O。保持可移植：不得导入 Node 内置模块、`src/adapters/` 或 `src/cli/`，不得使用 `process`、`Buffer`。
- `src/adapters/` 负责 SQLite、文件系统、三级配置与模板、`WorkspaceRuntime` 和回环 HTTP 服务。`src/cli/` 提供 CLI；`web/` 是 React UI，通过本地 HTTP API 使用同一核心，不另写生成流水线。
- `schemas/` 提供共享 Zod 数据与配置校验；`config.default.yaml` 与 `prompts/` 是仓库默认层，工作区和项目覆盖层优先。

## 修改与验证

- 要求 Node.js >=22.13、pnpm 8.15.5。先读相关源码、配置、测试与 README 核实行为，不声称未实现功能或把单章验收推广到所有小说。
- 只做当前需求所需的小范围改动；遵循现有依赖、命名与风格，不做无关重构、格式清理、额外抽象或添加代码注释。
- 修改后在仓库根目录执行：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- 测试使用 `tests/helpers.ts` 的隔离临时工作区与 `MockAi`，或 `tests/mockOpenai.ts` 的回环模拟服务。CLI 子进程设置独立 `COMIC_WORKSPACE` 与测试密钥；不得复用用户工作区、真实 token 或进行真实收费请求。mock 成功不等于付费 API 或生成质量已验证。
- 用户已授权：本项目代码改动完成审查与验证后，直接 `commit`、`push` 本次相关文件，不再逐次确认；提交前检查完整 diff 与敏感文件，不夹带无关改动。该授权不改变收费、预算和服务操作边界。

## 数据与费用边界

- API key 只放工作区 `.env` 或进程环境，不写入 YAML、提示词、文档或日志。不要输出密钥值；示例仅用占位值。
- 不提交真实 token、`.env`、`workspace/`（或外部工作区）、`dist/`、`node_modules/`、私人小说原稿，以及生成的 PNG、PDF、SQLite 数据库和日志。
- `project.db` 是项目状态权威，`ledger.db` 是费用账本，JSON 是镜像。产品操作走 CLI/Web，不手改用户数据库或镜像绕过状态。
- `refs/` 与 `chapters/*/attempts/` 的原图是 immutable originals，只追加、不覆盖、不删除，包含 rejected 候选。锁定必须由人选择，不能自动锁定、替换或解除；`--force` 不解除锁定、不清空历史。重做仅更新确定后的最终 `pages/` 副本和派生导出。
- 收费调用必须经过账本预占、结算和工作区/项目预算检查；不得关闭记账或自动绕过预算。`--ignore-limit` 仅在用户明确批准本次调用时使用；超时或取消后费用未知的请求保留估算。

## 本地服务与资源

- Web 只监听 `127.0.0.1`、`localhost` 或 `::1`。保留整个工作区的一任务闸门及修改操作互斥；不要同时运行同一工作区的多个 CLI 生成进程、多个服务或 CLI/Web 生成任务。`image.concurrency` 仅控制同章页并发。
- 中断后先查 `status` / `budget`，用相同的 `run` / `render` 无 `--force` 续跑；重新 `redo` 会开启新周期。取消不保证已发出的请求免费。
- 不通过 Playwright 下载或安装浏览器；缺少浏览器时跳过相关检查并说明，只用系统已有浏览器或 Chrome DevTools。
- 不主动停止用户要求保留的本地服务，不为测试抢占现有端口。仅清理本次自行创建且未要求保留的临时页面、隔离测试资源和服务。
