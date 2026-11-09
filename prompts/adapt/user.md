【作品】{{project.title}}
【本章】{{chapter.id}}，第 {{chapter.idx}} 章：{{chapter.title}}

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
