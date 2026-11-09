{{#if (eq page.layout "strip-4")}}
[VERTICAL STRIP]
Mobile scrolling comic strip. Aspect ratio: {{config.image.aspect_ratio}}. Output size: {{config.image.size}}.
Exactly four landscape panels, each spanning the full canvas width, stacked in one column and four rows from top to bottom. Use narrow white horizontal gutters. No side-by-side panels, 2x2 grids, merged panels, page titles or page-number lettering.
Reading order: {{reading_order_description}}. Continue the story downward across all four panels.
{{else}}
[PAGE]
Single comic page. Aspect ratio: {{config.image.aspect_ratio}}. Output size: {{config.image.size}}. White gutters between panels.
Layout rows: {{page.layout}}. Reading order: {{reading_order_description}}.
{{/if}}
{{#if location}}
Shared page setting: {{location.name}}.
{{#if location.desc}}
Setting description: {{location.desc}}.
{{/if}}
{{#if location.palette}}
Setting palette: {{location.palette}}.
{{/if}}
{{/if}}
