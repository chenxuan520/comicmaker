{{#if characters}}
[CHARACTERS]
Use the locked character reference sheets for the current appearance. Bible descriptions may mention later chapters: do not add later aging, burns, new scars, ceremonial clothing or weapons to this page unless the current panel explicitly describes that change. An art-style sample supplies rendering style, never the identities or costumes of its unrelated sample characters.
{{#each characters}}
{{name}} ({{id}}):
{{#if gender}}
Gender: {{gender}}.
{{/if}}
{{#if age_look}}
Apparent age: {{age_look}}.
{{/if}}
{{#if height_build}}
Height and build: {{height_build}}.
{{/if}}
{{#if face}}
Face: {{face}}.
{{/if}}
{{#if hair}}
Hair: {{hair}}.
{{/if}}
{{#if hair_color}}
Hair color: {{hair_color}}.
{{/if}}
{{#if eye_color}}
Eye color: {{eye_color}}.
{{/if}}
{{#if skin}}
Skin: {{skin}}.
{{/if}}
{{#if marks}}
Distinguishing features: {{marks}}.
{{/if}}
{{#if outfit}}
Current outfit: {{outfit.name}} ({{outfit.id}}).
{{#if outfit.desc}}
Clothing: {{outfit.desc}}.
{{/if}}
{{#if outfit.main_color}}
Main clothing color: {{outfit.main_color}}.
{{/if}}
{{#if outfit.accent_color}}
Accent clothing color: {{outfit.accent_color}}.
{{/if}}
{{/if}}
{{/each}}
{{/if}}
