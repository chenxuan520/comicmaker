【作品】{{project.title}}
【本章】{{chapter.id}}，第 {{chapter.idx}} 章：{{chapter.title}}
{{#if (eq config.storyboard.format "strip")}}
【漫画格式】手机条漫，每组四个全宽横向画格，从上到下连续阅读。按原文组织动作与停顿，不重复对白、不编造事件来凑四格；suggested_pages 表示建议的四格组数。
{{/if}}

【前情提要】
{{#if prev_summary}}
{{prev_summary}}
{{else}}
无。
{{/if}}

【本章角色】
{{json characters}}

【本章服装】
{{json outfits}}

【本章地点】
{{json locations}}

【本章原文】
{{numbered chapter.paragraphs}}
