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

【角色颜色与服装设定】
{{json characters}}
{{json outfits}}
