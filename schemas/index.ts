import { z } from "zod";

const positiveInteger = z.number().int().min(1);
const nonnegativeInteger = z.number().int().min(0);
const nonnegativeNumber = z.number().finite().nonnegative();
const positiveNumber = z.number().finite().positive();
const modelName = z.string().min(1);
const entityIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const outfitIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const sceneIdSchema = z.string().regex(/^s[1-9]\d*$/);
const beatIdSchema = z.string().regex(/^b[1-9]\d*$/);
const panelIdSchema = z.string().regex(/^p[1-9]\d*$/);
const nullableDescription = z.string().nullable();
const nullableColor = z.string().regex(/[\u3400-\u9fff].*#[0-9a-fA-F]{6}/).nullable();

const outfitSchema = z
  .object({
    id: outfitIdSchema,
    name: z.string(),
    desc: nullableDescription,
    main_color: nullableColor,
    accent_color: nullableColor,
    chapters: z.array(positiveInteger),
  })
  .strict();

const characterSchema = z
  .object({
    id: entityIdSchema,
    name: z.string(),
    aliases: z.array(z.string()),
    role: nullableDescription,
    gender: nullableDescription,
    age_look: nullableDescription,
    height_build: nullableDescription,
    face: nullableDescription,
    hair: nullableDescription,
    hair_color: nullableColor,
    eye_color: nullableColor,
    skin: nullableColor,
    marks: nullableDescription,
    outfits: z.array(outfitSchema).min(1),
    evidence: z.array(z.string().regex(/^[1-9]\d*:[1-9]\d*$/)),
  })
  .strict();

const locationSchema = z
  .object({
    id: entityIdSchema,
    name: z.string(),
    desc: nullableDescription,
    palette: nullableDescription,
    chapters: z.array(positiveInteger),
  })
  .strict();

export const extractionSchema = z
  .object({
    characters: z.array(characterSchema),
    locations: z.array(locationSchema),
  })
  .strict()
  .superRefine((extraction, ctx) => {
    const characters = new Set<string>();
    const outfits = new Set<string>();
    const locations = new Set<string>();
    extraction.characters.forEach((character, characterIndex) => {
      if (characters.has(character.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", characterIndex, "id"], message: `Duplicate character ID ${character.id}` });
      characters.add(character.id);
      character.outfits.forEach((outfit, outfitIndex) => {
        const path = ["characters", characterIndex, "outfits", outfitIndex, "id"];
        if (!outfit.id.startsWith(`${character.id}.`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Outfit ${outfit.id} must start with '${character.id}.' and use a distinct outfit purpose after the dot` });
        if (outfits.has(outfit.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate outfit ID ${outfit.id}` });
        outfits.add(outfit.id);
      });
    });
    extraction.locations.forEach((location, index) => {
      if (locations.has(location.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["locations", index, "id"], message: `Duplicate location ID ${location.id}` });
      locations.add(location.id);
    });
  });

export const summarySchema = z
  .object({
    chapters: z.array(
      z
        .object({
          chapter: positiveInteger,
          summary: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const dialogueSchema = z
  .object({
    speaker: entityIdSchema.nullable(),
    type: z.enum(["speech", "thought", "narration", "sfx"]),
    text: z.string(),
  })
  .strict();

const sceneSchema = z
  .object({
    id: sceneIdSchema,
    location_id: entityIdSchema,
    time: nullableDescription,
    characters: z.array(
      z
        .object({
          id: entityIdSchema,
          outfit: outfitIdSchema,
        })
        .strict(),
    ),
    beats: z.array(
      z
        .object({
          id: beatIdSchema,
          src_paras: z.array(positiveInteger),
          importance: z.number().int().min(1).max(3),
          action: z.string(),
          dialogue: z.array(dialogueSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const adaptationSchema = z
  .object({
    scenes: z.array(sceneSchema),
    suggested_pages: positiveInteger,
  })
  .strict();

const pageStoryboardSchema = z
  .object({
    page_no: positiveInteger,
    layout: z.string(),
    panels: z.array(
      z
        .object({
          id: panelIdSchema,
          row: positiveInteger,
          size: z.enum(["small", "medium", "large", "wide"]),
          shot: z.enum(["远景", "全景", "中景", "近景", "特写"]),
          angle: z.enum(["平视", "俯视", "仰视"]),
          location_id: entityIdSchema,
          time: nullableDescription,
          characters: z.array(
            z
              .object({
                id: entityIdSchema,
                outfit: outfitIdSchema,
                pose: z.string(),
                expression: z.string(),
                position: z.enum(["左", "中", "右"]),
              })
              .strict(),
          ),
          action: z.string(),
          dialogue: z.array(dialogueSchema),
          beat_ids: z.array(beatIdSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const storyboardSchema = z
  .object({
    pages: z.array(pageStoryboardSchema),
  })
  .strict();

const storyboardIssueSchema = z
  .object({
    page: positiveInteger,
    panel: panelIdSchema,
    type: z.enum(["faithfulness", "omission", "pacing"]),
    detail: z.string(),
    fix: z.string(),
  })
  .strict();

export const storyboardReviewSchema = z
  .object({
    pass: z.boolean(),
    issues: z.array(storyboardIssueSchema),
  })
  .strict();

export const rewriteSchema = z
  .object({
    panels: z.array(
      z
        .object({
          id: panelIdSchema,
          action: z.string(),
          characters: z.array(
            z
              .object({
                id: entityIdSchema,
                pose: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export const textReviewSchema = z
  .object({
    panels: z.array(
      z
        .object({
          panel: positiveInteger,
          texts: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

const visualIssueSchema = z
  .object({
    panel: positiveInteger,
    severity: z.enum(["major", "minor"]),
    issue: z.string(),
  })
  .strict();

export const visualReviewSchema = z
  .object({
    panel_count: nonnegativeInteger,
    characters: z.array(
      z
        .object({
          panel: positiveInteger,
          char_id: entityIdSchema,
          identity_match: z.number().min(0).max(1),
          color_match: z.number().min(0).max(1),
          issue: nullableDescription,
        })
        .strict(),
    ),
    content: z.array(visualIssueSchema),
    artifacts: z.array(visualIssueSchema),
    fix_instructions: z.string(),
  })
  .strict();

export const configSchema = z
  .object({
    openai: z
      .object({
        base_url: z.string().url(),
        api_key_env: z.string().min(1),
      })
      .passthrough(),
    models: z
      .object({
        extract: modelName,
        adapt: modelName,
        storyboard: modelName,
        storyboard_review: modelName,
        rewrite: modelName,
        review_text: modelName,
        review_visual: modelName,
      })
      .catchall(modelName),
    pricing: z.record(
      z
        .object({
          input: nonnegativeNumber.optional(),
          output: nonnegativeNumber.optional(),
          text_in: nonnegativeNumber.optional(),
          image_in: nonnegativeNumber.optional(),
          image_out: nonnegativeNumber.optional(),
        })
        .passthrough(),
    ),
    image: z
      .object({
        model: modelName,
        size: z.string().regex(/^[1-9]\d*x[1-9]\d*$/),
        aspect_ratio: z.string().regex(/^[1-9]\d*:[1-9]\d*$/),
        quality: z.string().min(1),
        ref_strategy: z.enum(["by_frequency", "first_appearance", "none"]),
        max_refs: nonnegativeInteger,
        include_style_ref: z.boolean(),
        include_location_ref: z.boolean(),
        concurrency: positiveInteger,
        max_refusals: nonnegativeInteger,
        timeout_sec: positiveNumber,
        retry_backoff_sec: z.array(nonnegativeNumber),
      })
      .passthrough(),
    storyboard: z
      .object({
        format: z.enum(["page", "strip"]).default("page"),
        min_panels: positiveInteger,
        max_panels: positiveInteger,
        max_bubble_chars: positiveInteger,
        max_bubbles_per_panel: nonnegativeInteger,
        max_chars_per_page: nonnegativeInteger,
        max_revisions: nonnegativeInteger,
        coverage_min_importance: positiveInteger.max(3),
        emphasis_min_importance: positiveInteger.max(3),
        large_panel_sizes: z.array(z.enum(["small", "medium", "large", "wide"])).min(1),
        reading_order: z.enum(["ltr", "rtl"]),
      })
      .passthrough(),
    review: z
      .object({
        enabled: z.boolean(),
        base_score: z.number().finite(),
        max_attempts: positiveInteger,
        checks: z
          .object({
            text: z.boolean(),
            identity: z.boolean(),
            color: z.boolean(),
            content: z.boolean(),
            artifacts: z.boolean(),
            panel_count: z.boolean(),
          })
          .passthrough(),
        min_identity: z.number().min(0).max(1),
        min_color: z.number().min(0).max(1),
        missing_character: z.enum(["fail", "ignore"]).default("fail"),
        max_text_errors: nonnegativeInteger,
        max_major_issues: nonnegativeInteger,
        sfx_patterns: z.array(z.string()),
        weights: z
          .object({
            text_error: nonnegativeNumber,
            major: nonnegativeNumber,
            minor: nonnegativeNumber,
            identity: nonnegativeNumber,
            color: nonnegativeNumber,
            panel_mismatch: nonnegativeNumber,
          })
          .passthrough(),
      })
      .passthrough(),
    refs: z
      .object({
        candidates: positiveInteger,
        sheet_layout: z.string().regex(/^[1-9]\d*x[1-9]\d*$/),
        style_sample_panels: positiveInteger,
        style_sample_text: z.string(),
      })
      .passthrough(),
    llm: z
      .object({
        full_book_max_tokens: positiveInteger,
        chunk_chapters: positiveInteger,
        chars_per_token: positiveNumber,
        schema_retry: nonnegativeInteger,
        timeout_sec: positiveNumber,
        retry_backoff_sec: z.array(nonnegativeNumber),
      })
      .passthrough(),
    summary: z.object({ max_chars: positiveInteger }).passthrough(),
    budget: z
      .object({
        limit_usd: nonnegativeNumber.nullable(),
        period: z.enum(["month", "week", "none"]),
        cycle_start_day: positiveInteger.max(31),
        timezone: z.string(),
        estimates: z
          .object({
            image: nonnegativeNumber,
            llm: nonnegativeNumber,
            full_book: nonnegativeNumber,
          })
          .passthrough(),
      })
      .passthrough(),
    import: z
      .object({
        chapter_regex: z.string(),
        strip_patterns: z.array(z.string()),
      })
      .passthrough(),
    export: z
      .object({
        pdf: z.boolean(),
        html: z.boolean(),
        reading_image_kb: positiveInteger.nullable().default(200),
        ai_notice_page: z.boolean(),
        ai_notice_text: z.string(),
        font_path: z.string().nullable(),
        text: z.object({ font_size: positiveNumber, margin: nonnegativeNumber, line_height: positiveNumber }).passthrough(),
      })
      .passthrough(),
    web: z.object({
      host: z.enum(["127.0.0.1", "localhost", "::1"]),
      port: positiveInteger.max(65535),
      poll_interval_ms: positiveInteger,
      max_upload_mb: positiveNumber,
    }).passthrough(),
    prompts: z
      .object({
        vars: z.record(z.unknown()),
        image_sections: z.array(z.string().min(1)),
      })
      .passthrough(),
    project: z.object({ style_desc: z.string() }).passthrough(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (config.storyboard.min_panels > config.storyboard.max_panels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storyboard", "max_panels"],
        message: "max_panels must be greater than or equal to min_panels",
      });
    }
    if (config.budget.period === "week" && config.budget.cycle_start_day > 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "cycle_start_day"],
        message: "cycle_start_day must be between 1 and 7 for a weekly budget",
      });
    }
    if (
      config.image.include_style_ref &&
      config.image.max_refs === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["image", "max_refs"],
        message: "max_refs must allow the enabled style reference",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type Character = z.infer<typeof characterSchema>;
export type Outfit = z.infer<typeof outfitSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Adaptation = z.infer<typeof adaptationSchema>;
export type PageStoryboard = z.infer<typeof pageStoryboardSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
export type StoryboardIssue = z.infer<typeof storyboardIssueSchema>;
export type TextReview = z.infer<typeof textReviewSchema>;
export type VisualReview = z.infer<typeof visualReviewSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
