{{#if text_errors}}
[CORRECTIONS]
{{#each text_errors}}
{{#if expected}}
Panel {{panel}} bubble must read exactly: {{json expected}}
{{else}}
Panel {{panel}}: remove unexpected text {{json actual}}.
{{/if}}
{{/each}}
{{corrections}}
{{else}}
{{#if corrections}}
[CORRECTIONS]
{{corrections}}
{{/if}}
{{/if}}
