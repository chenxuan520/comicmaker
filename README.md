# 页间 · comicmaker

**页间（comicmaker）**是本地小说转彩色漫画工作室，支持页漫与手机条漫：一本小说一个项目，提取设定、人工锁定参考图，再逐章改编、分镜、生图、审查与重抽，导出 PDF 和本地 HTML 阅读页。默认页漫模式，一张图生成一页或一个四格组，中文对白直接画进图里，不做程序叠字。

提供 CLI 和本地 Web UI；不做云端部署、图床、多用户或多个项目同时制作。本地指存储与编排在本机，模型调用仍会把相关原文、提示词和参考图发送给配置的服务商。

**已有单章真实模型验收记录，仍有分镜质量提醒；不代表全书或所有小说均已验证。验证范围与已知限制见文末。**

## 快速开始

要求 Node.js **>=22.13**（使用内置 `node:sqlite`）和 **pnpm 8.15.5**。获取代码并在仓库根目录安装、构建：

```sh
git clone https://github.com/chenxuan520/comicmaker.git
cd comicmaker
pnpm install
pnpm build
```

默认工作区是启动目录下的 `./workspace`，已被 Git 忽略。若需要仓库外的独立目录，在首次启动服务或运行业务 CLI 命令前设置，之后每次启动保持相同设置：

```sh
export COMIC_WORKSPACE="$HOME/comic-workspace"
```

启动已构建的本地 Web：

```sh
pnpm start
```

打开 <http://127.0.0.1:4321>。开发时可用 `pnpm dev` 替代 `pnpm start`；它通过 `tsx` 运行同一个 CLI 的 `serve`，不是独立 Web 服务。两者均从 `dist/web/` 读取静态资源，首次运行及修改 Web 源码后需要 `pnpm build`。

首次需要工作区的 CLI 调用（如 `list`、`new`、`serve`，不含 `--help`）初始化 `config.yaml`、`ledger.db` 和 `.env`；不会覆盖已有配置。无需密钥即可启动、导入和浏览；执行模型生成与审查前，在工作区 `.env` 的空值占位 `OPENAI_API_KEY=` 中填入自己的密钥，例如：

```dotenv
OPENAI_API_KEY=your-provider-api-key
```

密钥只放进程环境或工作区 `.env`，不提交、不打印，也不写入 YAML、仓库根目录 `.env` 或提示词；进程环境优先。`openai.api_key_env` 可改变量名，`openai.base_url` 可改兼容服务地址，均在 YAML 配置。**Web UI 不提供密钥输入或保存入口。**

## 本地 Web

| 页面 | 操作 |
| --- | --- |
| 作品书架 / 工作台 | 新建项目、选择项目、上传 `.txt` / `.md` 小说、全书预处理 |
| 配置 / 提示词 | 编辑工作区或项目 YAML、查看合并值及来源；浏览模板并保存为项目覆盖 |
| 视觉设定 | 生成、浏览候选，先由人选择并锁定画风，再锁定服装与地点 |
| 章节稿台 | 运行章节、逐页浏览、查看分镜与审查、筛选 flagged、带说明重绘、导出 PDF / HTML |
| 预算 / 任务 | 查看账本分类、任务进度与日志、取消当前任务 |

只监听回环地址。一个 Web 服务在整个工作区同时只运行一个任务，运行中提交新任务会被拒绝，不是按项目分别并行；取消保留已完成进度，已发出的模型请求仍可能计费。CLI 不支持多进程或多个项目同时制作，也不要与 Web 生成任务混跑；`image.concurrency` 只控制同一章内的页并发。

## 页漫与手机条漫

在「章节稿台」选择 **页漫 / 手机条漫**，保存为当前作品的配置覆盖；也可在工作区或项目 YAML 中设置：

```yaml
storyboard:
  format: strip
```

| 格式 | 分镜与阅读方式 |
| --- | --- |
| `page`（默认） | 常规页漫，按 `min_panels` / `max_panels` 安排格数与版式 |
| `strip` | 每组固定四个全宽横向画格，单列四行，自上而下连续阅读；不使用页漫格数上下限 |

条漫仍复用原有改编、生图、文字与画面审查、预算和重抽流程，不是另一条生成流水线。输出尺寸、模型、参考图和画质继续使用现有配置，不自动换模型或增加图像尺寸。分镜的 `layout: strip-4` 保存实际格式；条漫版式错误会被列入分镜修订或画面审查。

**切换只保存配置，不自动生图或收费，也不会把旧页漫裁成四格。** 已完成章节保留自己的分镜格式、选定图片与导出；想按另一格式重新制作旧章，需要明确开启「强制执行」再运行改编或章节制作，这会重新计费，历史参考图和尝试原图仍保留。修改后无 `--force` 的续跑仍跳过已完成结果。

章节稿台支持「逐页查看 / 向下连读」。HTML 条漫阅读页按组号连续排列，手机全宽显示，桌面限制阅读宽度。默认使用 `export/` 内的轻量 JPEG，复制完整 `export/` 即可阅读。PDF 仍按每个四格组一页导出，不拼接成无限长的 PDF 页面。已有自定义覆盖模板需要保留相应格式约束与分支。

### 阅读图片大小

生图画质 `image.quality` 与阅读图片压缩是两件事。生图和审查仍使用原始 PNG；导出在本机生成宽度最多 768 像素、不放大的 JPEG 阅读副本，自动调节压缩质量，默认目标为每张约 200 KiB。Web、HTML 和 PDF 使用阅读副本，「打开原图」仍可查看 PNG。不会因此调用模型或新增费用，也不会覆盖、删除参考图、尝试原图或最终 PNG 副本。

```yaml
export:
  reading_image_kb: 200
```

这个值支持工作区和项目覆盖；设为 `null` 使用原始 PNG 阅读和导出。目标不是严格字节上限，极小值或复杂画面可能超出，JPEG 是有损副本。已有章节执行 `export --chapter 1 --force` 即可生成或更新阅读副本，不需重新生图；重绘后也需更新导出。缓存绑定选定尝试和大小设置，不复用旧图的阅读副本。

## CLI 流程

### 创建与导入

下面用 `demo-book` 和“示例小说”演示；仓库不预置项目或小说，请按自己的作品替换。

```sh
pnpm comic new demo-book --title 示例小说
pnpm comic list
pnpm comic use demo-book
```

`new` 自动选中新项目；`use` 用于之后切换。项目命令可使用 `-p demo-book` / `--project-id demo-book` 明确选项目，未指定则用当前项目。

小说路径换成你有权使用的本地 `.txt` / `.md` 文件。若 Markdown 以 `### 第…章` 为章节标题，**导入前**在工作区 `config.yaml` 或本项目 `project.yaml` 加入：

```yaml
import:
  chapter_regex: '^\s*(?:#{1,6}\s*)?第[零一二三四五六七八九十百千0-9]+章.*$'
  strip_patterns: ['^\s*#{1,2}\s', '^\s*<a\s', '^\s*- \[']
```

这组清洗规则移除一二级标题、锚点行和目录链接，保留 `###` 章节；清洗先于切章，不要用 `strip_patterns` 删除要保留的章标题。默认正则只匹配普通“第…章”，不匹配时整书作为第 1 章。

```sh
pnpm comic import --novel "./novel.md"
pnpm comic status --json
pnpm comic budget --json
pnpm comic prepare
```

导入复制原稿而不修改外部源文件，优先 UTF-8，解码失败则 GB18030；不调用模型。已导入的项目无需重复执行 `import`。`prepare` 提取设定并生成章节摘要，开始调用模型并计费；执行前应确认模型、单价与预算配置。

### 生成与锁定参考图

先看预算与设定，生成画风候选并等待人工选择：

```sh
pnpm comic budget
pnpm comic refs gen --kind style
pnpm comic refs list --status candidate
pnpm comic lock STYLE_REF_ID
```

`STYLE_REF_ID` 等大写占位符必须换成人工选中的真实 ID。画风锁定后，为本章需要的服装和地点生成候选、逐项选图锁定；目标 ID 从 `status` 的 `outfits` / `locations` 获取：

```sh
pnpm comic refs gen --kind outfit --target OUTFIT_ID
pnpm comic refs list --status candidate
pnpm comic lock OUTFIT_REF_ID
pnpm comic refs gen --kind location --target LOCATION_ID
pnpm comic refs list --status candidate
pnpm comic lock LOCATION_REF_ID
```

省略 `--target` 会为该类型所有未锁定项补齐候选。每个 `(kind, target_id)` 最多一张 locked；锁定后其他候选标为 rejected，但图片保留。**不能替换、解除、修改或删除已锁定参考图**；`refs gen --force` 仅追加候选，不解除锁定。

### 制作与重做

完成本章所需设定锁定后：

```sh
pnpm comic run --chapter 1
pnpm comic status --chapter 1 --json
```

`run` 只执行 `adapt → render → export`，不会代做导入、预处理或人工锁定；已完成步骤默认跳过。中断后先查 `status` 和 `budget`，再以相同项目、章节的 `run` / `render` **不加 `--force`** 续跑。flagged 表示未通过全部审查，不等于命令失败；有图时选择本轮最佳版本，无可用图时导出对白文字页。

单页重做先读预算和已有审查，`--note` 写具体修正依据，不能编造错误。以下页码与说明仅示意，以实际 `status` 为准：

```sh
pnpm comic budget --json
pnpm comic budget -p demo-book --json
pnpm comic status -p demo-book --chapter 1 --json
pnpm comic redo -p demo-book --page 001-p03 --note "按已有审查修正第2格对白，使其与分镜逐字一致。"
pnpm comic export -p demo-book --chapter 1 --force
```

`redo` 开启新的审查与重抽周期，不受历史已用 `max_attempts` 限制，但本轮仍遵守 `review.max_attempts` 和预算闸；新结果确定前保留旧选定图，原始尝试保留，最终副本可更新。预算或取消中断后，用 `render` / `run` 不加 `--force` 继续当前周期；再次执行 `redo` 会开启新周期。重做后用 `export --force` 确保 PDF / HTML 使用最新页，而不是旧导出。

整章重新改编可用 `pnpm comic run --chapter 1 --force`；强制改编重置该章工作分镜与 `render.start.*` 基线，历史尝试不删除，也不参与新一轮次数统计。此操作可能重新计费，不是清空项目的命令。

## 命令与返回值

下表命令均加前缀 `pnpm comic`；通用选项为 `-p/--project-id <id>`、`--json`、`--force`、`--ignore-limit`，是否重做由具体步骤决定。

| 命令 | 主要参数 | 用途 |
| --- | --- | --- |
| `new <project_id>` | `--title <名>` 必填，`--style <描述>` 可选 | 新建并选中项目 |
| `list` / `use <project_id>` | 无额外参数 | 列项目及进度 / 切换当前项目 |
| `import` | `--novel <path>`，可选 `--force` | 复制原稿并切章 |
| `prepare` | 可选 `--force` | 提取设定、生成摘要 |
| `refs gen` | `--kind style\|outfit\|location`，可选 `--target <id>`、`--force` | 生成候选 |
| `refs list` / `lock <ref_id>` | list 可选 `--status candidate\|locked\|rejected` | 列素材 / 锁定人选定的图 |
| `adapt` / `render` | `--chapter <n>` 必填，可选 `--force` | 改编、分镜与自审 / 生图、审查与重抽 |
| `redo` | `--page <page_id>` 必填，`--note <说明>` 可选 | 重做一页 |
| `export` | `--chapter <n>` 必填，可选 `--force` | 导出 / 更新 PDF 与 HTML |
| `run` | `--chapter <n>` 必填，可选 `--dry-run`、`--force` | 章节流水线 / 无 API 提示词预览 |
| `status` / `budget` | status 可选 `--chapter <n>`；budget 可选 `-p <id>` | 查状态、reviews 与 flagged / 查账本 |
| `config` | 可选 `--project`，项目选择用 `-p <id>` | 打印三层合并值及来源，额外返回项目原始 YAML 值 |
| `prompts list` | 无额外参数 | 列模板及生效来源 |
| `prompts eject <模板名>` | 可选 `--workspace` | 复制生效模板到项目或工作区覆盖层 |
| `prompts render <步骤>` | 按步骤使用 `--chapter <n>`、`--page <id>`、`--target <id>` | 用已有数据渲染，不调用 API |
| `serve` | 可选 `--host <回环地址>`、`--port <端口>` | 启动本地 Web，默认 `127.0.0.1:4321` |

`config --project` 是**布尔开关，不接项目 ID**；`config` 本身始终返回当前项目的三层合并配置，也需要当前项目或 `-p`。`budget` 不使用当前项目选择，默认全工作区；`budget -p demo-book` 只过滤项目花费，返回的上限、周期仍是工作区策略，项目限额应另看 `config -p demo-book --project`。

`--json` 输出命令自身的对象，无统一 `success/data` 包装；错误为 `{"error":{"message":"…","code":2,"details":{}}}`（`details` 可省略）。具体结构示例见 [comic 技能](skills/comic/SKILL.md)。

机器解析时使用 `pnpm --silent comic ... --json`，避免 pnpm 的脚本横幅混入标准输出；例如 `pnpm --silent comic budget --json`。

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令完成；仍需查看 flagged / warnings |
| `1` | 执行错误 |
| `2` | 前置条件不满足，如缺设定、章节或锁定图 |
| `3` | 预算闸拒绝，保留进度，停止并报告花费、上限及重置时间 |
| `130` | 生成执行被中断，先查状态再续跑 |

## 配置与提示词

配置按 `config.default.yaml → 工作区 config.yaml → 项目 project.yaml` 三层深度覆盖，数组整体替换：

| 层级 | 位置 | 作用 |
| --- | --- | --- |
| 仓库 | `config.default.yaml` | 随代码提供的默认值 |
| 工作区 | `<工作区>/config.yaml` | 影响工作区内所有项目 |
| 项目 | `<工作区>/projects/<project_id>/project.yaml` | 覆盖当前项目的配置 |

首次初始化会将当时的默认配置复制到工作区；升级代码不会覆盖该文件，工作区中的旧值可能继续覆盖仓库新默认值。提示词按 `仓库 prompts/ → 工作区 prompts/ → 项目 prompts/` 三层整文件覆盖。产品参数和提示词都可在覆盖层修改，不必改代码；已经缓存的提取结果需要 `prepare --force` 才会重新生成并再次计费。

下面是**实际 `config.default.yaml` 的默认值**，不是服务商能力、最新定价或成本承诺：

| 配置组 | 默认值 |
| --- | --- |
| `openai` / `models` | 地址 `https://api.openai.com/v1`，密钥变量 `OPENAI_API_KEY`；extract / adapt / storyboard / rewrite 用 `gpt-6.1-sol`，storyboard_review / review_text / review_visual 用 `gpt-6.1-terra` |
| `image` 输出 | model `gpt-image-2.6-sunburst`，size `1024x1536`，aspect_ratio `2:3`，quality `high` |
| `image` 参考与执行 | ref_strategy `by_frequency`，max_refs `3`，include_style_ref / include_location_ref `true`，concurrency `2`，max_refusals `2` |
| `image` / `llm` 网络 | timeout_sec 均 `300`，retry_backoff_sec 均 `[2, 4, 8, 16, 32]` |
| `llm` / `summary` | full_book_max_tokens `260000`，chunk_chapters `20`，chars_per_token `2`，schema_retry `1`；summary.max_chars `200` |
| `refs` | candidates `3`，sheet_layout `3x3`，style_sample_panels `4`，style_sample_text `师父，弟子来了。` |
| `storyboard` | format `page`，min_panels / max_panels `3 / 5`，max_bubble_chars `15`，max_bubbles_per_panel `2`，max_chars_per_page `3`，max_revisions `2`，reading_order `ltr`；coverage_min_importance `2`，emphasis_min_importance `3`，large_panel_sizes `[large, wide]` |
| `review` | enabled `true`，base_score `100`，max_attempts `3`，checks 全开，min_identity `0.75`，min_color `0.7`，max_text_errors / max_major_issues `0 / 0`；sfx_patterns 见默认文件 |
| `review.weights` | text_error `30`，major `20`，minor `5`，identity `40`，color `20`，panel_mismatch `50` |
| `budget` | limit_usd `null`，period `month`，cycle_start_day `1`，timezone `Asia/Shanghai`；estimates.image / llm / full_book 为 `0.25 / 0.05 / 1.0` 美元预估值 |
| `import` | 普通中文章标题正则，strip_patterns `[]`；Markdown 覆盖示例见上文 |
| `export` | pdf / html / ai_notice_page `true`，reading_image_kb `200`，ai_notice_text `本作品由 AI 生成`，font_path `null`；text.font_size / margin / line_height `24 / 64 / 36` |
| `web` | host `127.0.0.1`，port `4321`，poll_interval_ms `2000`，max_upload_mb `20` |
| `prompts` / `project` | vars `{}`；image_sections `[style, page, references, characters, panels, text_rules, corrections]`；style_desc `清新国风修仙，干净线稿，明亮通透的赛璐璐上色` |

默认模型名与 `pricing` 只是仓库配置快照。先确认服务商与账户实际支持的模型、上下文、图像尺寸和参考图编辑能力，再在覆盖层调整 `models`、`image.model` 与 `pricing`。单价单位为美元 / 百万 token，不随服务商自动更新；换服务商或计费档位时须自行核对，缺单价不代表免费。

颜色字段未知时保留 `null`，已知时用中文颜色词加 hex，如 `墨黑 #1A1A1A`，不补写原文未给出的颜色；模板省略空字段。摘要 Structured Outputs 使用对象根 `{"chapters":[{"chapter":1,"summary":"…"}]}`，不是裸数组。

```sh
pnpm comic config -p demo-book --project --json
pnpm comic prompts list -p demo-book --json
pnpm comic prompts eject image/panel.md -p demo-book
pnpm comic prompts render adapt -p demo-book --chapter 1 --json
pnpm comic prompts render image -p demo-book --page 001-p03 --json
pnpm comic run -p demo-book --chapter 1 --dry-run --json
```

模板使用 strict Handlebars，支持变量、条件、循环、partials 与 `json` / `numbered` / `join` helper。`eject --workspace` 写到工作区，默认写到项目；它复制**当前生效版本**，不是固定仓库版本。`run --dry-run` 仍必须指定章节，只预览已有原文、改编与分镜能支持的提示词；缺少中间数据会列入 `unavailable`，不能凭空生成后续输出，也不是完整生成验证。

## 预算与数据

花费记账始终开启；`budget.limit_usd: null` 只是默认不设上限，不代表免费。工作区上限和项目显式设置的上限同时检查，项目设置不能取消工作区限制。每次收费请求先按预估值入账占用额度，成功后用返回 usage 和配置单价结算；缺 usage / 单价会 warning 并保留估算，超时或中断且费用未知时也保留估算，不能把账本等同于服务商账单。预算闸在请求前按预估值检查，实际结算可能高于预估，不是服务商侧硬限额；模型审查、修订和重抽也可能增加费用。

周期按配置时区计算：month 的 cycle_start_day 为 `1..31`，不存在的日期钳制到该月最后一天；week 为 `1=周一` 至 `7=周日`；none 为累计总额。预算不足返回 `3` 并保留进度；只有用户明确批准才可用 `--ignore-limit` 临时跳过本次限额，不应自动加这个选项。

```text
workspace/                         # 或 COMIC_WORKSPACE，全部业务数据不进 Git
  .env / config.yaml / ledger.db
  prompts/                         # 工作区模板覆盖
  projects/demo-book/
    project.yaml / project.db
    novel/source.txt               # 当前原稿；旧版本归档为 source.<时间戳>.txt
    bible/*.json                   # 只读镜像
    refs/                          # 所有参考图只增不改
    prompts/                       # 项目模板覆盖
    chapters/001/
      adaptation.json / storyboard.json
      attempts/p03-a1.png          # 原始尝试只增不改
      pages/p03.png                # 最终选定副本，可替换
      export/chapter.pdf / index.html
      export/p03.jpg                # 有损阅读副本，可重新生成
    logs/
```

`project.db` 是状态唯一权威，`ledger.db` 是花费账本；JSON 只是供人查看的镜像，手改不会成为模型输入。`attempts/` 和 `refs/` 的图片永不覆盖或删除，最终 `pages/` 副本与导出文件可更新。备份应保留工作区数据库及完整相对目录，不能只保存 JSON 镜像。默认 HTML 引用 `export/` 内的 JPEG，分享时复制完整 `export/`；关闭阅读压缩后 HTML 引用 `../pages/` PNG，需同时保留 `export/` 与 `pages/` 的相对位置。都不是单文件图像嵌入或云端图床。

`import --force` 先归档旧 source，再清空章节、页、改编及预处理 / 分镜审查工作状态；保留历史 attempts、refs、reviews、spend 和原始图片，新原稿必须重新 `prepare`。残留镜像、页副本或导出不能代表新原稿进度；**force 不意味着删除所有历史图片或花费**。

PDF 用 `pdf-lib` 与 `@pdf-lib/fontkit` 嵌入本机字体，中文说明页或无图对白页需要支持中文的 Unicode 字体。运行时尝试系统已有的 Arial Unicode、Noto Sans CJK 或 Arphic UMing；不可用时，在 YAML 设置 `export.font_path` 为本地支持中文的 TTF / OTF / TTC 路径（相对路径以工作区为基准）。缺少字体会阻止含文字页的 PDF 导出，也可设置 `export.pdf: false` 只导出 HTML。不随仓库再分发系统字体，使用与导出需遵守字体授权。

## 仓库目录

| 路径 | 用途 |
| --- | --- |
| `src/core/` | CLI 与 Web 共用的流水线、提示词、审查与预算；`ports.ts` 抽象 I/O |
| `src/adapters/` | SQLite、文件系统、配置与模板、工作区运行时及本地 HTTP 服务 |
| `src/cli/` / `bin/` | Commander CLI 源码 / 构建后入口 |
| `schemas/` | 共享 Zod 数据与配置校验 |
| `web/` | React / Vite 本地工作室，通过 HTTP 使用共享核心 |
| `config.default.yaml` / `prompts/` | 仓库级默认配置 / Handlebars 模板 |
| `tests/` | 隔离测试、MockAi 与回环 OpenAI 协议模拟服务 |
| `docs/DECISIONS.md` / `AGENTS.md` | 行为决策 / 工程协作约定 |
| `skills/comic/` | 可选的 agent CLI 操作规则 |
| `workspace/` / `dist/` / `node_modules/` | 业务数据 / 构建产物 / 依赖，不提交 |

## 验证与已知限制

- **真实模型验收仅覆盖一部小说的第 1 章**：35 张最终漫画页通过配置的文字与画面审查，并导出 PDF / HTML。这是特定原稿与验收配置下的结果，不是所有默认模型、服务商、小说或全书的端到端保证。
- 单章验收仍保留一条分镜重复对白提醒。程序校验、文字审查和画面审查通过，不等于叙事问题全部消失；其他章节及长期年龄 / 服装变化的生成效果尚未实测，需人工复核。
- 同一原稿的首章还完成了 25 组、100 格手机条漫的真实模型验收；同样不代表其他小说或全书的质量保证。
- 公开代码不依赖验收小说、锁定参考图、账本或生成物；这些数据不随仓库提供。示例项目和小说文件需自行准备，不能直接切换到某个预置验收项目查看成果。
- 兼容服务需支持 Chat Completions 的 JSON Schema Structured Outputs、视觉输入，以及图像生成 / 多参考图编辑；图像接口需以 `b64_json` 返回 PNG。仅支持文本聊天或图片 URL 的服务不能完成整条流水线，默认模型与单价也需按账户和服务商实际能力核对。
- Web 仅面向回环单用户使用，没有云端部署、多用户认证或持久任务队列；不支持同一工作区的多进程并行制作。

已有工程验证记录为 **176 项自动测试通过**，并通过 `lint`、`typecheck`、`build`。本地自动检查：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`lint` 检查未使用的 TypeScript 符号和核心库可移植性。自动测试使用隔离 SQLite、文件系统、`MockAi` 与本地 OpenAI 协议模拟服务，不调用付费 API；mock 成功不等于真实付费 API 全量验证或生成质量保证。缺少测试所需字体时，部分 PDF 检查会禁用并给出诊断，HTML 仍可验证。

行为决策见 [docs/DECISIONS.md](docs/DECISIONS.md)，工程规则见 [AGENTS.md](AGENTS.md)，agent 操作规则见 [skills/comic/SKILL.md](skills/comic/SKILL.md)。
