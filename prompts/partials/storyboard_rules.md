{{#if (eq config.storyboard.format "strip")}}
{{#if (eq config.storyboard.layout_mode "budget")}}
- 采用手机纵向条漫，page_no 表示本章连续的条漫组号。每组单列，第 i 格的 row 为 i。
- 默认每组用 layout=strip-4：四格，size 均为 wide。
- 下列版式计划中的每一项，必须恰好用一组对应的 layout 来表现。该组的格数和各格 size 必须与计划一致，重点格的 beat_ids 必须包含该 beat，并以这个节拍为画面主体：
{{#each layout_plan}}
  - {{beat_id}}：layout={{layout}}，{{panel_count}} 格，size 依次为 {{join sizes "、"}}，重点格是第 {{hero}} 格。
{{/each}}
- 计划之外的组不得使用 strip-4 以外的版式；不得增加、删除或更换计划中的版式。
- 重点格的对白尽量精简，把画面留给动作、表情或场面；重点格之前的一两格用于铺垫，之后的格可以给人物反应。
{{#if config.storyboard.layout_rules.max_same_shot_run}}
- 同一景别不得连续超过 {{config.storyboard.layout_rules.max_same_shot_run}} 格（跨组计算）。
{{/if}}
- 格与格、组与组之间保持向下滚动的叙事连续性，不重复对白来凑格数。气泡在每格内遵循 {{config.storyboard.reading_order}}：ltr 从左到右，rtl 从右到左。
{{else}}
- 采用手机纵向条漫，page_no 表示本章连续的条漫组号。每组恰好四格，单列四行，每格是铺满宽度的横向画格，不使用页漫的 min_panels / max_panels。
- layout 必须为 strip-4；panels 数组按从上到下排列，四格的 row 依次为 1、2、3、4，size 均为 wide。不得使用两列、2×2、横排四格、跨行合并或整页大图。
- 四格之间与组与组之间保持向下滚动的叙事连续性，不重复对白来凑格数。气泡在每格内遵循 {{config.storyboard.reading_order}}：ltr 从左到右，rtl 从右到左。
{{/if}}
{{else}}
- 每页必须有 {{config.storyboard.min_panels}} 至 {{config.storyboard.max_panels}} 格。
- 阅读顺序配置为 {{config.storyboard.reading_order}}：ltr 表示从左到右，rtl 表示从右到左；两者都从上到下。页内 panels 数组、对白顺序和构图都须遵守该顺序。
{{/if}}
- 每个气泡不超过 {{config.storyboard.max_bubble_chars}} 个汉字与中文标点，每格最多 {{config.storyboard.max_bubbles_per_panel}} 个气泡。
- 每页出场角色不超过 {{config.storyboard.max_chars_per_page}} 人，同一角色在多格出现只计一人。
- importance>={{config.storyboard.emphasis_min_importance}} 的节拍必须用 size={{join config.storyboard.large_panel_sizes " 或 "}} 的大格，或采用符合每页格数配置的整页方案。
- 所有 importance>={{config.storyboard.coverage_min_importance}} 的节拍都必须在至少一格的 beat_ids 中出现，不得遗漏或引用不存在的节拍。
- 对白可以删减或拆到相邻格，但不能改变意思；不得为满足格数而编造剧情。
{{#unless (eq config.storyboard.format "strip")}}
- layout 按行描述版式，每行写格数及必要的 wide 标记，行之间用 | 分隔。row 从 1 开始，layout、row 和 size 必须描述同一版式。
{{/unless}}
- 角色、服装、地点只能引用输入的已知 ID；服装必须属于该角色，不得擅自换装。
