[PANEL {{panel_index}} | row {{panel.row}} | {{panel.size}}]
Shot: {{panel.shot}}. Camera angle: {{panel.angle}}.
{{#if panel.location}}
Setting: {{panel.location.name}}.
{{#if panel.location.desc}}
Setting description: {{panel.location.desc}}.
{{/if}}
{{#if panel.location.palette}}
Setting palette: {{panel.location.palette}}.
{{/if}}
{{/if}}
{{#if panel.time}}
Time: {{panel.time}}.
{{/if}}
Action: {{panel.action}}.
{{#each panel.characters}}
{{name}} ({{id}}), position: {{position}}, pose: {{pose}}, expression: {{expression}}.
{{#if outfit}}
Outfit: {{outfit.name}} ({{outfit.id}}).
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
{{#each panel.dialogue}}
{{#if is_speech}}
Speech bubble{{#if speaker_name}} from {{speaker_name}}{{/if}}: {{json text}}
{{/if}}
{{#if is_thought}}
Thought cloud bubble{{#if speaker_name}} from {{speaker_name}}{{/if}}: {{json text}}
{{/if}}
{{#if is_narration}}
Narration box: {{json text}}
{{/if}}
{{#if is_sfx}}
Sound effect lettering: {{json text}}
{{/if}}
{{/each}}
