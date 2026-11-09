【待审页面图片】
待审页面图片已随本次消息附上。

{{#if refs}}
【本页参考图说明】
以下参考图仅供比较设定，不是待审页面。
{{#each refs}}
参考图 {{index}}：{{label}}；类型 {{kind}}；名称 {{name}}；目标 ID {{target_id}}。
{{/each}}
{{/if}}

【本页分镜】
{{json page}}
{{#if (eq page.layout "strip-4")}}

【手机条漫版式检查】
图片必须恰好四格，四个全宽横向画格从上到下单列排列，与分镜的 row 1、2、3、4 对应。两列、2×2、横排、跨行合并或错误阅读顺序均属于 major 内容错误，写入 content，并在 fix_instructions 中明确要求单列四格。四格数量正确不代表版式正确。
{{/if}}

【角色颜色与服装设定】
{{json characters}}
{{json outfits}}
