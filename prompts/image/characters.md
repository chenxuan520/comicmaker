{{#if characters}}
[CHARACTERS]
Use the locked reference for each CURRENT outfit/stage. Keep recognizable identity, but the current outfit/stage, its reference and current source determine age appearance, hair changes and body proportions; global initial descriptions do not force every life period into the same-age face. Do not carry another period's aging, injuries or equipment into this page. An art-style sample supplies rendering style, never the identities or costumes of its unrelated sample characters.
{{#each characters}}
{{name}} ({{id}}):
{{#if gender}}
Gender: {{gender}}.
{{/if}}
{{#if age_look}}
Initial age baseline; current outfit/stage takes precedence: {{age_look}}.
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
