import { ulid } from "ulid";
import { textReviewSchema, visualReviewSchema, type TextReview, type VisualReview } from "../../schemas/index.js";
import { getBible } from "./data.js";
import { structuredCall } from "./llm.js";
import type { ImageInput } from "./ports.js";
import type { Context, PageStoryboard, Ref } from "./types.js";

export interface TextError { panel: number; expected: string | null; actual: string | null; kind: "missing" | "mismatch" | "unexpected" }

export function normalizeText(text: string): string {
  const punctuation: Record<string, string> = { ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；", "(": "（", ")": "）", "[": "【", "]": "】" };
  return text.normalize("NFKC").replace(/\s/gu, "").replace(/(?:\.{3,}|…+|⋯+)/gu, "……").replace(/["“”]/g, "＂").replace(/['‘’]/g, "＇").replace(/[,\.!?:;()\[\]]/g, (character) => punctuation[character]);
}

export function compareText(page: PageStoryboard, recognized: TextReview, sfxPatterns: string[] = []): TextError[] {
  const errors: TextError[] = [];
  const sfx = sfxPatterns.map((pattern) => new RegExp(pattern, "u"));
  for (let index = 0; index < page.panels.length; index++) {
    const panel = page.panels[index];
    const actual = recognized.panels.filter((item) => item.panel === index + 1).flatMap((item) => item.texts);
    const unused = new Set(actual.map((_, position) => position));
    const missing: typeof panel.dialogue = [];
    for (const expected of panel.dialogue) {
      const match = [...unused].find((position) => normalizeText(actual[position]) === normalizeText(expected.text));
      if (match !== undefined) { unused.delete(match); continue; }
      missing.push(expected);
    }
    for (const expected of missing) {
      const substitute = [...unused][0];
      if (substitute !== undefined) unused.delete(substitute);
      errors.push({ panel: index + 1, expected: expected.text, actual: substitute === undefined ? null : actual[substitute], kind: substitute === undefined ? "missing" : "mismatch" });
    }
    for (const position of unused) {
      if (!sfx.some((pattern) => pattern.test(normalizeText(actual[position])))) errors.push({ panel: index + 1, expected: null, actual: actual[position], kind: "unexpected" });
    }
  }
  for (const panel of recognized.panels.filter((item) => item.panel < 1 || item.panel > page.panels.length)) {
    for (const text of panel.texts) errors.push({ panel: panel.panel, expected: null, actual: text, kind: "unexpected" });
  }
  return errors;
}

export function evaluateReview(page: PageStoryboard, textErrors: TextError[], visual: VisualReview, config: Context["config"]["review"]) {
  const expected = page.panels.flatMap((panel, index) => panel.characters.map((character) => ({ panel: index + 1, id: character.id })));
  const matches = expected.map((character) => visual.characters.find((item) => item.panel === character.panel && item.char_id === character.id));
  const matched = config.missing_character === "ignore" ? matches.filter((match): match is NonNullable<typeof match> => match !== undefined) : matches;
  const identity = config.checks.identity ? Math.min(1, ...matched.map((match) => match?.identity_match ?? 0), ...visual.characters.map((character) => character.identity_match)) : 1;
  const color = config.checks.color ? Math.min(1, ...matched.map((match) => match?.color_match ?? 0), ...visual.characters.map((character) => character.color_match)) : 1;
  const issues = [...(config.checks.content ? visual.content : []), ...(config.checks.artifacts ? visual.artifacts : [])];
  const major = issues.filter((item) => item.severity === "major").length;
  const minor = issues.filter((item) => item.severity === "minor").length;
  const textCount = config.checks.text ? textErrors.length : 0;
  const panelMismatch = config.checks.panel_count && visual.panel_count !== page.panels.length;
  const weights = config.weights;
  const score = config.base_score - weights.text_error * textCount - weights.major * major - weights.minor * minor - weights.identity * (1 - identity) - weights.color * (1 - color) - (panelMismatch ? weights.panel_mismatch : 0);
  const passed = textCount <= config.max_text_errors && !panelMismatch && identity >= (config.checks.identity ? config.min_identity : 0) && color >= (config.checks.color ? config.min_color : 0) && major <= config.max_major_issues;
  return { score, passed, identity, color, text_errors: textErrors, major, minor, panel_mismatch: panelMismatch };
}

export interface ReviewResult { id: string; score: number; passed: boolean; corrections: string; text_errors: TextError[] }

export async function visualRefs(ctx: Context, page: PageStoryboard) {
  const bible = await getBible(ctx);
  const outfitIds = new Set(page.panels.flatMap((panel) => panel.characters.map((character) => character.outfit)));
  return (await ctx.db.all<Ref>("SELECT * FROM refs WHERE kind = 'outfit' AND status = 'locked'"))
    .filter((ref) => outfitIds.has(ref.target_id)).map((ref, index) => {
      const name = bible.characters.find((character) => ref.target_id.startsWith(`${character.id}.`))?.name ?? ref.target_id;
      return { index: index + 2, ...ref, name, label: name };
    });
}

export async function reviewAttempt(ctx: Context, attemptId: string, page: PageStoryboard, data: Uint8Array): Promise<ReviewResult> {
  const existing = await ctx.db.get<{ id: string; score: number; passed: number; fix_instructions: string; text_check: string }>("SELECT * FROM reviews WHERE attempt_id = ?", [attemptId]);
  if (existing) return { id: existing.id, score: existing.score, passed: Boolean(existing.passed), corrections: existing.fix_instructions, text_errors: JSON.parse(existing.text_check).errors ?? [] };
  const emptyVisual: VisualReview = { panel_count: page.panels.length, characters: page.panels.flatMap((panel, index) => panel.characters.map((character) => ({ panel: index + 1, char_id: character.id, identity_match: 1, color_match: 1, issue: "" }))), content: [], artifacts: [], fix_instructions: "" };
  let text: TextReview = { panels: [] };
  let visual = emptyVisual;
  let errors: TextError[] = [];
  if (ctx.config.review.enabled) {
    const pageImage: ImageInput = { data, name: "page.png", label: "Comic page" };
    if (ctx.config.review.checks.text) {
      const cached = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`review.text.${attemptId}`]);
      text = cached ? textReviewSchema.parse(JSON.parse(cached.value)) : await structuredCall(ctx, { step: "review", template: "review_text", model: ctx.config.models.review_text, schema: textReviewSchema, data: { page, panel_count: page.panels.length, layout: page.layout }, images: [pageImage] });
      await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [`review.text.${attemptId}`, JSON.stringify(text)]);
      errors = compareText(page, text, ctx.config.review.sfx_patterns);
    }
    if (Object.entries(ctx.config.review.checks).some(([check, enabled]) => check !== "text" && enabled)) {
      const bible = await getBible(ctx);
      const referenceData = await visualRefs(ctx, page);
      const images = [pageImage, ...await Promise.all(referenceData.map(async (ref) => ({ data: (await ctx.fs.readBytes(ref.path!))!, name: `${ref.id}.png`, label: ref.label })))];
      const cached = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`review.visual.${attemptId}`]);
      const schema = visualReviewSchema.superRefine((result, validation) => {
        if (result.panel_count !== page.panels.length || ctx.config.review.missing_character === "ignore" || !(ctx.config.review.checks.identity || ctx.config.review.checks.color)) return;
        for (const [index, panel] of page.panels.entries()) for (const character of panel.characters) {
          if (!result.characters.some((item) => item.panel === index + 1 && item.char_id === character.id)) {
            validation.addIssue({ code: "custom", path: ["characters"], message: `Missing visual record for panel ${index + 1}, character ${character.id}; report its scores, including zero scores for a genuinely absent character` });
          }
        }
      });
      visual = cached ? visualReviewSchema.parse(JSON.parse(cached.value)) : await structuredCall(ctx, { step: "review", template: "review_visual", model: ctx.config.models.review_visual, schema, data: { page, refs: referenceData, characters: bible.characters, outfits: bible.outfits }, images });
      await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [`review.visual.${attemptId}`, JSON.stringify(visual)]);
    }
  }
  const evaluation = ctx.config.review.enabled ? evaluateReview(page, errors, visual, ctx.config.review) : { score: ctx.config.review.base_score, passed: true };
  const corrections = visual.fix_instructions;
  const id = ulid();
  await ctx.db.run("INSERT INTO reviews (id, attempt_id, text_check, visual_check, score, passed, fix_instructions) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, attemptId, JSON.stringify({ recognized: text, errors }), JSON.stringify(visual), evaluation.score, evaluation.passed ? 1 : 0, corrections]);
  ctx.log(evaluation.passed ? "info" : "warning", `Review ${attemptId}: score ${evaluation.score.toFixed(1)}, ${evaluation.passed ? "passed" : "failed"}`, { text_errors: errors });
  return { id, score: evaluation.score, passed: evaluation.passed, corrections, text_errors: errors };
}
