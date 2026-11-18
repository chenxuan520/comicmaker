{{#if character}}
{{#if outfit}}
Character reference sheet, {{config.refs.sheet_layout}} grid, plain white background, no text, no labels.
Use reference image 1 ONLY for line art, shading technique and palette. It depicts unrelated characters: DO NOT copy their face, hair ornaments, costume, pose or background.
Create a distinct identity for the named target. Do not add ceremonial robes, gold embroidery, jewelry, armor or weapons unless the supplied target outfit explicitly requires them. The entire background of every cell must be solid white #FFFFFF, not dark gradients or scenery.
This sheet depicts the CURRENT TARGET outfit/life stage specified by outfit.name, outfit.desc and its chapter range, not necessarily the character's first appearance. Preserve recognizable facial identity across stages, but a younger or older target must have the corresponding face, hair and body proportions, not merely the same-age face in different clothes. The current target's age, hair changes and source-grounded marks take precedence over global initial descriptions. Do not carry later injuries or equipment backward, and do not force an early youthful appearance into a requested older stage.
Character: {{character.name}} ({{character.id}}).
{{#if character.gender}}
Gender: {{character.gender}}.
{{/if}}
{{#if character.age_look}}
Initial age baseline; CURRENT TARGET stage takes precedence: {{character.age_look}}.
{{/if}}
{{#if character.height_build}}
Height and build: {{character.height_build}}.
{{/if}}
{{#if character.face}}
Face: {{character.face}}.
{{/if}}
{{#if character.hair}}
Hair: {{character.hair}}.
{{/if}}
{{#if character.hair_color}}
Hair color: {{character.hair_color}}.
{{/if}}
{{#if character.eye_color}}
Eye color: {{character.eye_color}}.
{{/if}}
{{#if character.skin}}
Skin: {{character.skin}}.
{{/if}}
{{#if character.marks}}
Distinguishing features: {{character.marks}}.
{{/if}}
Outfit: {{outfit.name}} ({{outfit.id}}).
{{#if outfit.desc}}
CURRENT TARGET appearance and clothing: {{outfit.desc}}.
{{/if}}
{{#if outfit.main_color}}
Main clothing color: {{outfit.main_color}}.
{{/if}}
{{#if outfit.accent_color}}
Accent clothing color: {{outfit.accent_color}}.
{{/if}}
Default nine-grid view plan, arranged in reading order and adapted to the requested grid dimensions:
Row 1: front view, side view, back view, all full body.
Row 2: neutral, smiling, angry, all head and shoulders.
Row 3: surprised, sad, determined, all head and shoulders.
The face, hair, colors and outfit must be identical in every cell.
{{/if}}
{{/if}}
