import { getBible, getChapter, getPage, chapterData, entitiesForChapter } from "./data.js";
import { PreconditionError } from "./errors.js";
import { buildPagePrompt } from "./promptBuilder.js";
import { visualRefs } from "./review.js";
import { adaptChapter } from "./steps/adapt.js";
import { renderChapter } from "./steps/render.js";
import { exportChapter } from "./steps/export.js";
import type { Chapter, Context, Page, PageStoryboard } from "./types.js";

export async function runChapter(ctx: Context, chapter: number | string, options: { force?: boolean; font?: Uint8Array } = {}) {
  const adaptation = await adaptChapter(ctx, chapter, { force: options.force });
  const rendering = await renderChapter(ctx, chapter);
  const exported = await exportChapter(ctx, chapter, { force: options.force, font: options.font });
  return { adaptation, rendering, export: exported };
}

export async function renderStepPrompt(ctx: Context, step: string, options: { chapter?: number | string; page?: string; target?: string } = {}) {
  const bible = await getBible(ctx);
  const chapters = await ctx.db.all<Chapter>("SELECT * FROM chapters ORDER BY idx");
  const chapter = options.chapter !== undefined ? await getChapter(ctx, options.chapter) : undefined;
  const row = options.page ? await getPage(ctx, options.page) : undefined;
  const page = row ? JSON.parse(row.storyboard) as PageStoryboard : null;
  if (step === "image") {
    if (!page) throw new PreconditionError("Use --page to preview an image prompt");
    const { prompt, refs } = await buildPagePrompt(ctx, page);
    return { prompt, refs };
  }
  const entities = chapter ? entitiesForChapter(bible, chapter) : bible;
  const adaptation = chapter ? await ctx.db.get<{ scenes: string }>("SELECT scenes FROM adaptations WHERE chapter_id = ?", [chapter.id]) : undefined;
  const pages = chapter ? await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]) : [];
  const previous = chapter ? chapters.find((item) => item.idx === chapter.idx - 1)?.summary ?? "" : "";
  const outfit = options.target ? bible.outfits.find((item) => item.id === options.target) ?? null : null;
  const character = outfit ? bible.characters.find((item) => outfit.id.startsWith(`${item.id}.`)) ?? null : null;
  const location = options.target ? bible.locations.find((item) => item.id === options.target) ?? null : null;
  const data = {
    chapters: chapters.map(chapterData), chapter: chapter ? chapterData(chapter) : null,
    prev_summary: previous, ...entities, scenes: adaptation ? JSON.parse(adaptation.scenes) : [],
    review_issues: [], storyboard: { pages: pages.map((item) => JSON.parse(item.storyboard)) },
    page, panel_count: page?.panels.length ?? 0, layout: page?.layout ?? "", refs: page && step === "review_visual" ? await visualRefs(ctx, page) : [],
    character, outfit, location, corrections: "", text_errors: [], extractions: [],
  };
  if (["adapt", "storyboard", "storyboard_review"].includes(step) && !chapter) throw new PreconditionError("Use --chapter for this prompt");
  if (["rewrite", "review_text", "review_visual"].includes(step) && !page) throw new PreconditionError("Use --page for this prompt");
  return step.startsWith("refs/") || step.startsWith("image/") || step.startsWith("partials/") ? ctx.prompts.render(step, data) : ctx.prompts.pair(step, data);
}

export async function dryRunChapter(ctx: Context, chapter: number | string) {
  const row = await getChapter(ctx, chapter);
  const prompts: unknown[] = [];
  const unavailable: { step: string; reason: string }[] = [];
  prompts.push({ step: "adapt", ...await renderStepPrompt(ctx, "adapt", { chapter }) });
  if (await ctx.db.get("SELECT chapter_id FROM adaptations WHERE chapter_id = ?", [row.id])) prompts.push({ step: "storyboard", ...await renderStepPrompt(ctx, "storyboard", { chapter }) });
  else unavailable.push({ step: "storyboard", reason: "Scene adaptation is not available yet; dry-run cannot invent model outputs" });
  const pages = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [row.id]);
  if (!pages.length) unavailable.push({ step: "image/review", reason: "Storyboards are not available yet" });
  else {
    prompts.push({ step: "storyboard_review", ...await renderStepPrompt(ctx, "storyboard_review", { chapter }) });
    for (const page of pages) {
      const built = await renderStepPrompt(ctx, "image", { page: page.id });
      prompts.push({ step: "image", page: page.id, ...built });
      prompts.push({ step: "review_text", page: page.id, ...await renderStepPrompt(ctx, "review_text", { page: page.id }) });
      prompts.push({ step: "review_visual", page: page.id, ...await renderStepPrompt(ctx, "review_visual", { page: page.id }) });
    }
  }
  return { chapter: row.id, dry_run: true, prompts, unavailable, api_calls: 0 };
}
