---
name: comic
description: 操作 comicmaker 本地小说转漫画 CLI 时使用，包括项目与章节运行、参考图候选、代理选图与锁定、flagged 页诊断与带说明重做、预算闸处理、配置及提示词模板查看与预览；不用于普通漫画剧情创作、通用画图或无关项目。
---

# comic CLI 操作员

在 comicmaker 项目目录执行 `pnpm --silent comic`。`--silent` 去掉 pnpm 横幅，保证 `--json` 标准输出只有 JSON；下文示例中的 `pnpm comic` 在机器执行时统一使用此安静前缀。使用 Node.js >=22.13、pnpm 8.15.5；工作区由 `COMIC_WORKSPACE` 或启动目录的 `./workspace` 确定，不擅自切换工作区。完整背景与默认值见仓库 [README.md](../../README.md)，行为决策见 [DECISIONS.md](../../docs/DECISIONS.md)。

## 操作护栏

- 项目制作与状态变更只通过 CLI，不直接调用 HTTP API，不编辑 project.db、ledger.db、小说原稿、JSON 镜像或图片文件；数据库权威，镜像只供查看。
- 所有 attempts / refs 原图只增不改，不覆盖或删除；不得解除、修改、删除或替换 locked 参考图，即使用户要求 force 也不能用它绕过锁定。
- 默认由代理检查候选与设定的符合程度，记录选择依据，再通过 CLI 锁定选定的 ref_id；仅在用户主动要求自行选图或禁止代选时等待用户选择。不随机选择，也不为“跑通”忽略明显错误。
- **每次 redo 前先读 budget**，再查目标 status、分镜与 reviews；根据已有证据写具体 --note，不捏造错误、页 ID、颜色或审查结果。
- 没有用户对本次绕过限额的明确批准，不加 --ignore-limit、不改预算上限、不清账本；退出码3停止并报告，不继续付费重试。
- 用户明确请求重做或生成候选、且服务配置已具备时，可执行该范围内的收费操作，不额外要求每次二次批准；缺密钥或模型配置则报告缺项，不自行补密钥或挑未核实模型。
- 先确认项目和章节，使用显式 -p 避免误操作当前选择；“第N页”跨章不明确时先查询 / 询问，不猜章节，也不擅自重跑整书。
- 不启动多个制作进程，不与 Web 生成任务混跑；Web 同一服务的任务是工作区全局串行，image.concurrency 仅是章内页并发。
- 本技能只检查、eject 和预览配置 / 模板；实际 YAML 与模板编辑由用户在本地 Web 或对应覆盖文件完成，不借编辑模板之名手改业务状态。
- 命令返回0仍检查 flagged / warnings；没有真实模型调用与结果验证的证据，不声称真实 AI 生成或 M1 A/B 已验证，不把账本金额称为服务商实扣金额。

## 通用选项与退出码

所有表中命令前加 `pnpm comic`，机器操作使用 `--json`。返回值没有统一 success/data 包装；错误在顶层 error。CLI 若因模块或运行环境问题无法加载，报告阻塞，不在操作任务中改核心代码。

| 选项 | 含义 |
| --- | --- |
| `-p <id>` / `--project-id <id>` | 选项目；未指定则使用当前项目，budget 不使用当前选择 |
| `--json` | 输出命令自身的 JSON 对象 |
| `--force` | 按步骤重做派生状态、追加候选或更新导出，不删除原始图片 |
| `--ignore-limit` | 仅在用户明确批准后，跳过本次工作区与项目限额检查 |

| 退出码 | 处理 |
| --- | --- |
| `0` | 读取结果，仍报告 flagged / warnings |
| `1` | 报执行错误，不声称完成 |
| `2` | 报缺失前置条件，列需要的原稿、设定、锁定图或目标 |
| `3` | 保存并报告预算拒绝的 scope、spent_usd、limit_usd、estimate_usd、reset_at（以 error.details 为准），停止收费操作 |
| `130` | 中断后先查 status，再用 run / render 续跑；不要重复 redo 重置本轮 |

## 命令表

| 命令 | 参数 | 用途与边界 |
| --- | --- | --- |
| `new <project_id>` | 必填 `--title <标题>`，可选 `--style <描述>` | 新建项目并自动选中，ID 为小写字母、数字、连字符 |
| `list` | 无 | 返回 projects 和 current_project，查看工作区项目进度 |
| `use <project_id>` | 无 | 更新当前项目选择 |
| `import` | 必填 `--novel <path>`，可选 `--force` | 复制原稿并切章；force 归档旧 source，清工作进度，保留历史图与账本，需重新 prepare |
| `prepare` | 可选 `--force` | 提取角色 / 服装 / 地点与摘要；收费，已有结果默认跳过 |
| `refs gen` | 必填 `--kind style\|outfit\|location`，可选 `--target <id>`、`--force` | 生成候选；省略 target 为该类未锁定项补齐，force 仅追加；服装 / 地点需 prepare 和已锁定画风 |
| `refs list` | 可选 `--status candidate\|locked\|rejected` | 返回 refs 数组，包含 ID、类型、target、路径、sha256、prompt、状态 |
| `lock <ref_id>` | 无 | 锁定代理检查后选中的 candidate；用户主动要求自行选图时遵从其选择，同一 kind / target 已有 locked 时不能替换 |
| `adapt` | 必填 `--chapter <n>`，可选 `--force` | 场景、分镜与自审，先检查所需锁定图；force 设置新的 render.start.* 基线，保留旧 attempts |
| `render` | 必填 `--chapter <n>`，可选 `--force` | 按已有分镜生图、审查、自动重抽；force 为该章页开启新周期 |
| `redo` | 必填 `--page <page_id>`，可选 `--note <文本>` | 开启新审查周期，note 追加修正；仍受本轮 max_attempts 与预算约束 |
| `export` | 必填 `--chapter <n>`，可选 `--force` | 本地 PDF / HTML；重做后用 force 更新，不调用模型 |
| `run` | 必填 `--chapter <n>`，可选 `--dry-run`、`--force` | adapt → render → export，不能代做 prepare / 人工 lock；dry-run 只预览已有数据 |
| `status` | 可选 `--chapter <n>` | 返回项目、章节、pages 含分镜 / reviews、设定、refs、warnings、flagged |
| `budget` | 可选 `-p <id>` | 默认全工作区；-p 仅过滤项目账本金额，限额与周期仍是工作区策略 |
| `config` | 可选 `--project`，选项目用 `-p <id>` | 始终返回三层合并 config 和 sources；布尔 --project 额外返回 project 原始配置值 |
| `prompts list` | 无 | 返回 templates 的 name / source |
| `prompts eject <模板名>` | 可选 `--workspace` | 复制当前生效文件到项目覆盖层，或工作区覆盖层 |
| `prompts render <step>` | 可选 `--chapter <n>`、`--page <id>`、`--target <id>`，按步骤传入 | 用真实已有数据渲染，不调 API，不生成中间业务结果 |
| `serve` | 可选 `--host <host>`、`--port <port>` | 启动本地 Web，默认 http://127.0.0.1:4321，host 只可用回环地址；需先 pnpm build 生成 Web 静态资源 |

## 配置、预算与模板

配置三层：仓库 config.default.yaml → 工作区 config.yaml → 项目 project.yaml，深度合并、数组替换。提示词三层：仓库 prompts/ → 工作区 prompts/ → 项目 prompts/，整文件覆盖。`config --project` 不接 ID，正确写法是 `config -p qinglan --project --json`。

密钥来自进程环境或工作区 .env，变量名可由 openai.api_key_env 修改，地址用 openai.base_url；没有 GUI 密钥入口。模型 ID 与 pricing 是 PRD 默认兼容设置，用户需向服务商核实，改配置即可，不宣称最新价格。颜色未知为 null，已知使用中文颜色词加 hex，不自动补全原文外设定。

预算默认 limit_usd=null，但记账始终开启；收费请求前记预估，有 usage / 定价后结算，缺信息、超时或中断可能仍是估算。工作区与项目显式限额都检查。month 的 cycle_start_day 为1..31并钳制到月末，week 为1周一至7周日，none 为累计。`budget -p` 不是项目限额报告，需同时查看 config 的项目原始 budget；budget JSON 不含逐笔 estimated 标记，不能凭它断言所有花费均为实费。

文本步骤如 extract、summary、merge、adapt、storyboard、storyboard_review 返回 `{system,user,sources}`；rewrite / review_text / review_visual 需 --page，章节步骤需 --chapter。单文件 refs/*、image/*、partials/* 返回 `{text,sources}`；整页 image 需 --page，返回 `{prompt,refs}`，不输出图片二进制。refs/character_sheet 用 --target 服装 ID，refs/location 用地点 ID。

```sh
pnpm comic config -p qinglan --project --json
pnpm comic prompts list -p qinglan --json
pnpm comic prompts eject image/panel.md -p qinglan
pnpm comic prompts render adapt -p qinglan --chapter 1 --json
pnpm comic prompts render image -p qinglan --page 001-p03 --json
pnpm comic run -p qinglan --chapter 1 --dry-run --json
```

dry-run 只预览已有数据可支持的步骤，`unavailable` 报缺失原因；不要为了预览去调用模型补齐，更不能编造改编 / 分镜使预览“完整”。

## 常见任务

### 重做第N页并说明原因

1. 先读全局与项目过滤的 budget，再读目标章节 status 和 config；确认页号对应的实际 page_id，章节不明确就询问。
2. 读取该页 storyboard、final_attempt_id 和 reviews，以当前选定尝试的审查及用户要求为修正依据；没有审查证据就明确说明，不把猜测写成已发现问题。
3. 用具体格号、期望对白 / 颜色 / 动作写 --note，执行一次 redo；用户请求单页只处理该页，不扩成整章 force。
4. 成功后 export --force 更新本章 PDF / HTML，再查 status 和 budget；报告修正依据、实际执行的改动、前后 final_attempt_id、状态 / flagged、账本差额与导出路径，区别“已提交修正要求”和“结果已通过审查”。

下例仅展示第1章第3页的命令顺序，说明须替换为真实 review / 用户要求，不可照抄当作发现：

```sh
pnpm comic budget --json
pnpm comic budget -p qinglan --json
pnpm comic status -p qinglan --chapter 1 --json
pnpm comic config -p qinglan --project --json
pnpm comic redo -p qinglan --page 001-p03 --note "第2格对白按分镜逐字绘制；保留已锁定服装配色。" --json
pnpm comic export -p qinglan --chapter 1 --force --json
pnpm comic status -p qinglan --chapter 1 --json
pnpm comic budget -p qinglan --json
```

遇到1 / 2 / 3 / 130先报告并处理，不继续当作成功导出；3不加 ignore-limit。账本差额可能含估算，无可确认的费用数据就报告未知，不能编造金额。

### 新角色候选与代理选图

1. 查 budget、status、config，从现有 characters / outfits 找到角色与实际 outfit_id；目标已 locked 就报告并保留，不 force 另选。
2. 确认已 prepare 且画风已 locked；若未提取该角色，报告需要重新导入 / prepare 的原因，不直接插入数据库，扩大为全书 force 前先确认用户意图。
3. 对目标运行 refs gen，再 refs list；默认检查并锁定合适候选，用户主动要求自行选图或禁止代选时才报告 ID、路径、状态并等待。画风候选遵循同一规则，不替换已有锁定。

```sh
pnpm comic budget --json
pnpm comic status -p qinglan --json
pnpm comic config -p qinglan --project --json
pnpm comic refs gen -p qinglan --kind outfit --target OUTFIT_ID --json
pnpm comic refs list -p qinglan --status candidate --json
```

`OUTFIT_ID` 必须来自现有设定，不能把示例 ID 当真；地点候选同理使用 --kind location。默认由代理检查并选定 ref_id 后，执行 `pnpm comic lock -p qinglan REF_ID --json`；用户主动要求自行选图或禁止代选时遵从其选择。

### 整章重跑与 flagged 检查

先查 budget / status，确认用户确实要求重新改编整个章节，再执行 `pnpm comic run -p qinglan --chapter 1 --force --json`；它重建工作分镜 / render.start.* 基线，旧 attempts 与 refs / reviews / spend 保留，不是删除全部历史。若只是继续中断工作，不加 force。

`pnpm comic status -p qinglan --chapter 1 --json` 的 flagged 数组就是待复核页 ID；关联 pages.reviews 分析原因。仅查看 flagged 不等于授权批量 redo。手动 redo 新周期仍受配置 max_attempts 限制，不是无限自动重抽。

## JSON 结构示例

以下仅为返回结构示例，不是本工作区执行结果；页 / 引用 / 尝试 ID 和金额不可硬编码。标为“字段摘录”的示例省略了其他真实字段。

`new qinglan --title 青岚纪 --json` 与 `use qinglan --json` 分别返回：

```json
{"id":"qinglan","title":"青岚纪"}
```

```json
{"current_project":"qinglan"}
```

`budget --json`（空账本、默认策略的形状示例，reset_at 以实际返回为准）：

```json
{"spent_usd":0,"limit_usd":null,"remaining_usd":null,"period":"month","timezone":"Asia/Shanghai","reset_at":"2026-11-30T16:00:00.000Z","by_project":[],"by_step":[]}
```

`status --chapter 1 --json` 字段摘录；reviews 真实记录含 attempt_id、text_check、visual_check、score、passed、fix_instructions，部分检查内容为 JSON 字符串：

```json
{"project":{"id":"qinglan","title":"青岚纪","style_desc":"清新国风修仙"},"pages":[{"id":"001-p03","chapter_id":"001","page_no":3,"status":"flagged","final_attempt_id":null,"image_path":null,"reviews":[]}],"flagged":["001-p03"]}
```

`refs list --status candidate --json` 字段摘录；完整结果还含 sha256 与 prompt：

```json
{"refs":[{"id":"REF_ID","kind":"outfit","target_id":"CHARACTER_ID.OUTFIT_ID","path":"refs/characters/CHARACTER_ID/CHARACTER_ID.OUTFIT_ID/REF_ID.png","status":"candidate"}]}
```

`redo --page 001-p03 --json` 的无可用图结果形状，与 `export --chapter 1 --force --json` 分别为：

```json
{"id":"001-p03","status":"flagged","final_attempt_id":null,"score":null,"skipped":false}
```

```json
{"chapter":"001","pdf":"chapters/001/export/chapter.pdf","html":"chapters/001/export/index.html","flagged":["001-p03"],"skipped":false}
```

dry-run 字段摘录（prompts 的内容取决于实际已有数据）：

```json
{"chapter":"001","dry_run":true,"unavailable":[{"step":"storyboard","reason":"Scene adaptation is not available yet; dry-run cannot invent model outputs"}],"api_calls":0}
```

错误示例为真实前置条件的返回形状，没有 details 时该字段省略：

```json
{"error":{"message":"Only candidate references can be locked","code":2}}
```

评测用例在 [evals/evals.json](evals/evals.json)。已在三个隔离的本地模拟工作区，仅依据本技能执行：错误页一次重绘后通过并更新HTML；新角色只生成并列出候选、不锁定；项目限额为零时保持原页与账本、不继续调用。结果属于CLI控制流程验证，不是实际画质或技能性能基准。
