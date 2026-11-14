# 小说到漫画：制作、读者审计与定向修补

本流程用于在明确授权和预算内完成一部漫画，而不是只把章节状态变成 `exported`。操作在仓库根目录执行；示例项目 `demo-book`、路径、章号和素材 ID 均需替换。

**完成标准：原文忠实、图文可读、上下文自足、选图与导出一致、费用可核对。** 模型通过、段号全覆盖、HTTP 200 都不能单独证明内容交付完成。

CLI 参数与配置入口见 [README](../README.md)。本页侧重实际执行顺序和验收纪律，不增加另一套生成流水线。

## 1. 开始前固定任务边界

在工作区运行记录中写清：

- 原稿、项目 ID、工作区、要处理的章节与最后一个正文段落。
- 文本、分镜、图片审核与生图模型；生图质量、格式、字数与框数限制。
- 已授权的累计金额、账户/密钥阶段、阶段基线、工作区和项目硬限。
- 参考图由谁选择，是否允许返修，是否禁止逐章询问。
- 要保留的阅读服务、对比试验、原图、候选和旧导出。
- 什么叫完成：不仅生成完，还包括通读、修补、重新导出及最终核验。

没有费用授权不能开始收费调用；已有明确授权则按约定自主推进，不逐章重新索要同一授权。新消息通常是对当前任务的修正或追加，不能悄悄丢掉正在执行的目标。

### 预算口径

```sh
pnpm comic budget --json
pnpm comic budget -p demo-book --json
pnpm comic config -p demo-book --json
```

以 `ledger.db` 的 `spend` 为费用依据，不从对话中的近似余额或某个运行 JSON 的字段名猜口径。

- 工作区、项目、当前密钥授权余额分别核对，取可用范围中的最小值。
- 密钥阶段基线为 `S0`，累计授权为 `K`，该阶段余额为 `K - (当前累计支出 - S0)`。
- 追加授权只更新获准的累计额度，不重设 `S0`，不把“本次增加金额”再次叠到累计授权上。
- 扣除历史基线计算出的“本轮新增支出”不是项目累计总费，不能直接拿它减项目硬限。
- 费用预占、超时/取消后的未知费用估算必须保留。`estimated=1` 包含多种估算，不能把其行数都称为“未知超时请求数”。
- 新建工作区、换密钥或对比模型不能成为绕过已耗尽预算的办法。

应给审计和返修留余量，不在首轮图上花完全部授权；也不为了花完余额重画没有问题的页。

## 2. 导入和全书预读

```sh
pnpm comic new demo-book --title 示例小说
pnpm comic import -p demo-book --novel ./novel.md
pnpm comic prepare -p demo-book
pnpm comic status -p demo-book --json
```

`import` 不调用模型；`prepare` 会提取设定和章节摘要，属于收费操作。已完成的步骤不要习惯性加 `--force`。

先读原稿，建立连续性登记：

| 登记项 | 要记录什么 |
| --- | --- |
| 人物 | 首次正式出场、已知身份/关系、仅提及或回忆、离场、明确死亡 |
| 时间 | 主角年龄、相隔年月、突破与养伤顺序；未知时间保持未知 |
| 地点 | 已到达与仅讨论的地点、同名/近似地点是否确为同一处 |
| 道具 | 取得、损坏、修补、遗失、赠出、谁持有；同形物不自动视为同物 |
| 证据 | 亲见、听说、旧图、残音、推测分别标记，不互相升级成事实 |
| 正文范围 | 分隔线、作者说明、链接等章后信息；保留原稿与原段号 |

摘要和提取结果是线索，不是原文的替代品。段号覆盖完整，也可能只有动作描述而没有读者能看到的解释。

## 3. 准备并锁定本章参考

```sh
pnpm comic refs gen -p demo-book --kind style
pnpm comic refs list -p demo-book --status candidate
pnpm comic lock -p demo-book STYLE_REF_ID
pnpm comic refs gen -p demo-book --kind outfit --target OUTFIT_ID
pnpm comic lock -p demo-book OUTFIT_REF_ID
pnpm comic refs gen -p demo-book --kind location --target LOCATION_ID
pnpm comic lock -p demo-book LOCATION_REF_ID
```

选图前检查原始尺寸的候选：

- 同一人物的脸、发型、衣色和身体特征一致，与其他角色可区分。
- 仅按初登状态设计，不提前画后期白发、战伤、境界、礼物或身份文字。
- 未详外貌可作明确的美术选择，但不能变成新剧情事实或未知数字年龄。
- 地点符合规模和用途，不复制画风样张里的宫殿、角色或奇幻地理。
- 长期或多时代复用的参考不固定一个未经原文确认的花季、雪季、昼夜或剧情状态。
- 生图 API 使用原始参考字节；联系表、裁片和阅读 JPEG 只是本地副本，不能反过来充当缩小后的 API 参考。

`refs/` 和 `attempts/` 只追加。**已锁定参考不能替换、解除或修改。** 不合格且尚未锁定的候选可以保留，再用 `refs gen --force` 追加一次；不能把这种做法用于解锁既有参考。

遗漏设定或章关联时，先查原文，再使用已有命令：

```sh
pnpm comic settings add -p demo-book --file ./missing-settings.json --json
pnpm comic outfits include -p demo-book OUTFIT_ID --chapter 2 --paragraph 1 --json
pnpm comic locations include -p demo-book LOCATION_ID --chapter 2 --paragraph 1 --json
```

这些操作不收费，但新增参考仍需生成和锁定。关联段号只证明操作指向哪一段，原文语义仍由操作者核实；仅提及死者或家属不能补成现场人物。

## 4. 分步改编：先审再生图

需要人工关卡时分步执行，不直接依赖一次 `run`：

```sh
pnpm comic adapt -p demo-book --chapter 1 --json
```

`adapt` 包含场景改编、分镜、程序检查和模型自审。先检查输出与 `chapters/001/storyboard.json`，再决定是否渲染。

### 原文与分镜审计

- 人物、时间、地点、行动目的与关键结果是否对应原文？
- 首次出场是否有足够的姓名/称呼与当前关系说明？已介绍人物不能反复贴身份卡。
- 已死者、信中人物和幻影有没有被写成当前在场？
- 器物取得、毁损、交接、伤势和左右侧是否接续？
- 跨页对白有没有只剩半句；叙述转成对白后，第三人称有没有误放进角色嘴里？
- 原文明确的信息有没有只藏在 `action`、`pose` 或场景元数据里，没有落实为可见画面/文字？
- 未知的案情、来历和将来是否仍保留不确定性？

手机条漫固定四个全宽横格、单列四行；检查每框字数、每格框数、每页已知人物数。配置示例：

```yaml
image:
  quality: low
review:
  max_attempts: 1
storyboard:
  format: strip
  max_bubble_chars: 15
  max_bubbles_per_panel: 2
  max_chars_per_page: 3
```

这是低成本、首轮逐页复核的制作策略，不是仓库的全部默认值。模型与质量按本次授权明确设置；若用户要求返修也只能 `low`，不能自动升成高画质。

一套已使用的统一文本/审核组合如下；它不是所有服务商的可用性或价格保证，使用前仍须核对服务与 `pricing`：

```yaml
models:
  extract: gpt-6-luna
  adapt: gpt-6-luna
  storyboard: gpt-6-luna
  storyboard_review: gpt-6-luna
  rewrite: gpt-6-luna
  review_text: gpt-6-luna
  review_visual: gpt-6-luna
image:
  model: gpt-image-2.6-sunburst
  quality: low
```

程序或模型存在提醒时先处理，不把“已经生成分镜”或“已结束自审”称为审计通过。当前 `run` 是流水线，不自动提供操作者的读者通读关卡。

## 5. 首轮生图与逐页核验

```sh
pnpm comic render -p demo-book --chapter 1 --json
pnpm comic status -p demo-book --chapter 1 --json
```

同一工作区只有一个制作任务，不同时跑多个 CLI 生成进程，也不与 Web 生成任务混跑。`image.concurrency` 只控制同章内页并发。

检查当前选定原图，而不是只看低分列表：

1. 核对 `final_attempt_id`、原图路径与 SHA-256。
2. 用联系表筛查，疑似错误回到原图或原生裁片。
3. 对照对白和关键画面，不把 OCR 输出当成图片事实。
4. 区分文字错字、OCR 误读、合法短句合并、道具上的源文字和标点变体。
5. 核对版式：门框、柱子是否属于连续空间，还是确实把一行拆成两个独立画格。

汉字不确定时，可用本地最近邻放大与字体对照检查笔画。例如形近字、草头字、雨字头和中点变体都容易误报；没确认不能直接重画。裁片不能覆盖原图。

`passed` 不代表全书衔接已验证；`flagged` 也不必然是漫画真错。保留模型原始审查，再另写人工证据和判断。

## 6. 必须单独做“读者视角通读”

**先只看漫画的图和文字，按实际阅读顺序读，不拿原文或分镜替读者补脑。** 模型查错可以辅助，不能代替操作者亲自通读。

每章用一句话回答：谁在什么地方，想做什么，为什么这么做，发生了什么改变？答不清楚时，记下具体页/格与读者缺少的信息，再回原文复核。

| 常见阅读断点 | 最小补法 |
| --- | --- |
| 家人突然知道角色的决定，前面却没交代 | 补角色说出意图的一句，再承接家人的回应 |
| 初得的重要器物没有名称，后文突然用专名 | 在取得时补短名称，不编品阶或额外功能 |
| 新术语只有示意图，后续反复依赖其机制 | 在初次学习时补原文已有的一两句解释 |
| 交信、抄图、查账都画成拿纸，话题不清 | 标明纸的用途、给谁，或补转场的一句 |
| 无对白谈话后人物突然改了行动 | 恢复促成该决定的关键话题，不补整段独白 |
| “这句”“当年”“那里”找不到指代 | 改成明确但简短的指代，必要时加冒号/引号 |
| 失踪者的遗物突然成为寻人线索 | 补物件出处，不擅自宣告其主人仍活着 |
| 从秘境回人间、现实切回忆、并行支线切换不明 | 补真实时地提示，并检查背景是否也跟着切换 |
| 整段试错被压成只有成功结果 | 补必要的失败/修正/结果关系，不虚构新试验 |

### 不应该补的内容

- 本来能从画面读懂的日常动作，不逐格配旁白。
- 已解释过的名词，不每章再写百科。
- 刻意悬念、无法确认的证词，不为“讲清楚”编出答案。
- 不给无名人物编名，不强推数字年龄、朝代、月份或死亡日。
- 不把主角的猜测、别人转述或自我辩解改成叙述者保证。
- 不把所有宽景、微动作或配色差异当成必须返修的错误。

单格可以选择一个动作瞬间；相邻图文确实兑现了结果，就不必把全部阶段塞在一格里。**但关键事件从未在任何一格图文中兑现时，不能用“下一拍”“画外发生了”替缺失开脱。** 道具若承担人物意图、情感回扣或因果，也不能仅因看起来小就省掉。

通读覆盖全书，不只查章节首尾。另列章节边界、人物初登、伤势变化、法宝交接、境界突破和重大选择等高价值接缝，逐一核对。

## 7. 分开处理两类修补

修补前快照当前分镜、选图 ID/哈希、审查、配置、费用与旧 `export/`。记录每个断点的源段号、缺少的信息和最小修改，不直接重做整章。

### A. 图画错了，分镜本身正确

```sh
pnpm comic budget -p demo-book --json
pnpm comic status -p demo-book --chapter 1 --json
pnpm comic redo -p demo-book --page 001-p03 --note "仅修第2格已确认的交接方向，保留其他三格和原有对白。" --json
```

说明只针对确认的缺陷。新原图返回后重新看，不因为分数升高就接受，也不因 OCR 再报形近字就重复重画。

### B. 分镜/文字不足，或描述本身错误

把要替换的**既有页完整对象**放到 `{ "pages": [...] }`：

```sh
pnpm comic storyboard patch -p demo-book --chapter 1 --file ./storyboard-patch.json --json
pnpm comic adapt -p demo-book --chapter 1 --json
pnpm comic render -p demo-book --chapter 1 --json
```

`storyboard patch` 零费用，只使变更页待重新审核/生成；其余页和旧 attempts 保留。`adapt` 不加 `--force` 复用已有场景；复审与生图仍收费。

复审可能触发模型修订。定向修补可临时将 `storyboard.max_revisions` 设为 `0`，避免模型顺手改历史页；这不是强制通过审查，发现问题仍须解决，结束后恢复原配置。检查修改前后完整分镜差异，任何超出修补清单的改动先复核，不以“保持一致”扩大范围。

### 超时或审查输出不完整

```sh
pnpm comic status -p demo-book --chapter 1 --json
pnpm comic budget -p demo-book --json
pnpm comic render -p demo-book --chapter 1 --json
```

用相同项目/章节、不加 `--force` 续跑，复用已存原图补完审核。再次 `redo` 会开启新周期，不能把它当免费续跑。保留未知费用估算，不删账本行，不关闭记账。

新候选仍失败时，针对剩余真缺陷再开小计划；已正确的原文、人物和其他格不应被顺手改掉。

## 8. 人工审计记录与产品状态的边界

审计记录放工作区，例如 `runs/<run-id>/`，不要进 Git。建议每页记录：

```json
{
  "page_id": "001-p03",
  "final_attempt_id": "ACTUAL_ATTEMPT_ID",
  "original_sha256": "ACTUAL_SHA256",
  "verdict": "accepted",
  "source_paragraphs": [12],
  "basis": "原生图与原文支持的具体判断，不是‘看起来可以’。",
  "evidence": ["audit/native-crop.png"],
  "model_flags_preserved": true
}
```

另存修改清单、读者疑问、前后对照、费用快照和最终验证。验收必须绑定当前 `final_attempt_id` 与哈希；后续换图后，旧验收自动失效，不能继续沿用。

这是**外部人工审计约定，不是当前 CLI 新增的 accept 命令或数据库状态**。`project.db` 的自动 `flagged` 与模型 reviews 原样保留；外部报告可以区分“有效人工接受”与“未解决”，但不能谎称模型 `passed`。人工记录不会解除产品定时调度的 flagged 暂停条件。

产品状态修改使用 CLI/Web，不手改 `project.db` 或镜像来跳过审核、选图、预算或原图检查。

## 9. 重导出和交付终检

```sh
pnpm comic export -p demo-book --chapter 1 --force --json
pnpm comic status -p demo-book --chapter 1 --json
pnpm comic budget -p demo-book --json
```

只对受影响章节更新派生导出。最终核验清单：

- [ ] 所有正文段落都得到忠实处理；非故事段有证据，不重排源编号。
- [ ] 全书图文已按顺序通读，缺解释/缺转场的候选有明确处置。
- [ ] 当前选图全部存在；没有 planned/generating、无图文字占位或失效验收混入交付。
- [ ] 每个 flagged 页要么确已修好，要么有绑定当前图的有效人工原生证据；未解决数为零。
- [ ] 所有历史参考/attempts，包括 rejected，哈希未变；最终 `pages/` 与选定 attempt 字节一致。
- [ ] HTML 画页数与当前组数一致，PDF 页数考虑独立 AI 告知页，页序正确。
- [ ] 重导出的 HTML、PDF、阅读 JPEG 确实使用新选图，不只是旧缓存可打开。
- [ ] 阅读服务的 HTML/PDF 均可访问；复用已有服务，不因测试再开同工作区的制作进程。
- [ ] 全书累计费用、密钥阶段费用、本轮修补增量与真实剩余额分别报告，历史估算未删减。
- [ ] 对比试验、原稿、旧导出及用户要求保留的服务未被动到。
- [ ] 最终报告注明实际覆盖与剩余限制，不能把一章验收说成所有作品都已验证。

HTTP 200 只证明能取到文件，不能代替内容、选图与缓存检查。浏览器需要测试时只用已有浏览器或 Chrome DevTools，不运行 Playwright 浏览器下载；缺少浏览器就说明限制。清理本次自行创建的临时页面，不停止用户要求保留的服务。

## 10. 仓库交付

小说、图片/PDF、数据库、账本、运行记录、密钥不进 Git。只有本次请求需要的代码、通用文档和不含私人原稿的资源进入提交。

提交前检查相对主分支的完整 diff，确认每行与需求相关。按仓库要求运行：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试使用隔离工作区和 mock，不复用真实 token 或产生真实收费。依项目授权完成审查、验证后提交和推送；这不扩展模型费用或服务操作授权。
