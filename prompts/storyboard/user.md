【作品】{{project.title}}
【本章】{{chapter.id}}，第 {{chapter.idx}} 章：{{chapter.title}}
【画风】{{project.style_desc}}

【尚未在前章画面中正式出场的角色】
{{json first_appearance_characters}}
名单中的主要及反复出场角色在本章实际露面时安排姓名/称呼与当前身份介绍；只被提及、只出现在画像或回忆中的人物不要误作现场新登场。

【本章角色设定】
{{json characters}}

【本章服装设定】
{{json outfits}}

【本章地点设定】
{{json locations}}

【场景与节拍】
{{json scenes}}

【本章原文】
{{numbered chapter.paragraphs}}

{{#if review_issues}}
【当前分镜，请保留未涉及的页及原页码】
{{json storyboard}}

【审稿意见，请只修改涉及的页】
{{json review_issues}}
{{/if}}
