import { rewriteSchema } from "../../../schemas/index.js";
import { getChapter, getPage, requireStoryboardReady } from "../data.js";
import { isRefusal, isTimeout } from "../calls.js";
import { PreconditionError } from "../errors.js";
import { generateImage, recoverPendingImages, sha256 } from "../image.js";
import { structuredCall } from "../llm.js";
import { buildPagePrompt } from "../promptBuilder.js";
import { reviewAttempt, type ReviewResult } from "../review.js";
import { pageFile, type Attempt, type Context, type Page, type PageStoryboard } from "../types.js";

async function rewritePage(ctx: Context, row: Page, page: PageStoryboard, refusalId: string): Promise<PageStoryboard> {
  const key = `rewrite.done.${refusalId}`;
  if (await ctx.db.get("SELECT value FROM meta WHERE key = ?", [key])) return page;
  const result = await structuredCall(ctx, { step: "rewrite", template: "rewrite", model: ctx.config.models.rewrite, schema: rewriteSchema, data: { page } });
  if (result.panels.length !== page.panels.length || new Set(result.panels.map((panel) => panel.id)).size !== page.panels.length) throw new Error("Rewrite must preserve all panel IDs");
  const rewritten: PageStoryboard = { ...page, panels: page.panels.map((panel) => {
    const update = result.panels.find((item) => item.id === panel.id);
    if (!update || update.characters.length !== panel.characters.length || new Set(update.characters.map((item) => item.id)).size !== panel.characters.length || panel.characters.some((character) => !update.characters.some((item) => item.id === character.id))) {
      throw new Error(`Rewrite must preserve the characters of panel ${panel.id}`);
    }
    return { ...panel, action: update.action, characters: panel.characters.map((character) => ({ ...character, pose: update.characters.find((item) => item.id === character.id)!.pose })) };
  }) };
  await ctx.db.transaction([
    { sql: "UPDATE pages SET storyboard = ? WHERE id = ?", params: [JSON.stringify(rewritten), row.id] },
    { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, 'true')", params: [key] },
  ]);
  const pages = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [row.chapter_id]);
  await ctx.fs.writeJson(`chapters/${row.chapter_id}/storyboard.json`, { pages: pages.map((item) => JSON.parse(item.storyboard)) });
  return rewritten;
}

async function selectAttempt(ctx: Context, row: Page, candidates: { attempt: Attempt; review: ReviewResult }[]) {
  const best = candidates.find((candidate) => candidate.review.passed) ?? candidates.sort((a, b) => b.review.score - a.review.score || b.attempt.seq - a.attempt.seq)[0];
  if (best) {
    const data = await ctx.fs.readBytes(best.attempt.path!);
    if (!data) throw new PreconditionError(`Generated image ${best.attempt.path} is missing`);
    await ctx.fs.replaceCopy(`chapters/${row.chapter_id}/pages/${pageFile(row.page_no)}`, data);
  }
  const status = best?.review.passed ? "passed" : "flagged";
  await ctx.db.run("UPDATE pages SET status = ?, final_attempt_id = ? WHERE id = ?", [status, best?.attempt.id ?? null, row.id]);
  ctx.log(status === "passed" ? "info" : "warning", `${row.id}: ${status}${best ? ` (score ${best.review.score.toFixed(1)})` : " (text-only fallback)"}`);
  return { id: row.id, status, final_attempt_id: best?.attempt.id ?? null, score: best?.review.score ?? null, skipped: false };
}

export async function renderPage(ctx: Context, pageId: string, options: { redo?: boolean; note?: string } = {}) {
  let row = await getPage(ctx, pageId);
  await requireStoryboardReady(ctx, row.chapter_id);
  if (!options.redo && ["passed", "flagged", "exported"].includes(row.status)) return { id: row.id, status: row.status, final_attempt_id: row.final_attempt_id, skipped: true };
  if (options.redo) {
    const latest = await ctx.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM attempts WHERE page_id = ?", [row.id]);
    await ctx.db.transaction([
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [`render.start.${row.id}`, String(latest!.seq)] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [`render.note.${row.id}`, options.note ?? ""] },
      { sql: "UPDATE pages SET status = 'planned' WHERE id = ?", params: [row.id] },
      { sql: "UPDATE chapters SET status = 'storyboarded' WHERE id = ?", params: [row.chapter_id] },
    ]);
    row = await getPage(ctx, pageId);
  }
  await recoverPendingImages(ctx, row.id);
  const start = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`render.start.${row.id}`]);
  const startSeq = Number(start?.value ?? 0);
  const savedNote = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`render.note.${row.id}`]);
  const note = options.note ?? savedNote?.value ?? "";
  let page = JSON.parse(row.storyboard) as PageStoryboard;
  await buildPagePrompt(ctx, page, note);
  await ctx.db.run("UPDATE pages SET status = 'generating' WHERE id = ?", [row.id]);
  for (;;) {
    ctx.signal?.throwIfAborted();
    const attempts = await ctx.db.all<Attempt>("SELECT * FROM attempts WHERE page_id = ? AND seq > ? ORDER BY seq", [row.id, startSeq]);
    const candidates: { attempt: Attempt; review: ReviewResult }[] = [];
    for (const attempt of attempts.filter((item) => item.status === "ok")) {
      const bytes = await ctx.fs.readBytes(attempt.path!);
      if (!bytes) throw new PreconditionError(`Attempt image ${attempt.path} is missing`);
      const review = await reviewAttempt(ctx, attempt.id, page, bytes);
      candidates.push({ attempt, review });
      if (review.passed) return selectAttempt(ctx, row, candidates);
    }
    const refused = attempts.filter((attempt) => attempt.status === "refused");
    const used = attempts.filter((attempt) => attempt.status === "ok" || (attempt.status === "error" && !["network", "cancelled"].includes(JSON.parse(attempt.error ?? "{}").kind))).length;
    if (used >= ctx.config.review.max_attempts || refused.length > ctx.config.image.max_refusals) return selectAttempt(ctx, row, candidates);
    const latest = attempts.at(-1);
    if (latest?.status === "refused") page = await rewritePage(ctx, row, page, latest.id);
    const corrections = [candidates.at(-1)?.review.corrections ?? "", note].filter(Boolean).join("\n");
    const built = await buildPagePrompt(ctx, page, corrections, candidates.at(-1)?.review.text_errors);
    try {
      await generateImage(ctx, { pageId: row.id, prompt: built.prompt, images: built.images, refPaths: built.refs.map((ref) => ref.path), path: (seq) => `chapters/${row.chapter_id}/attempts/${pageFile(row.page_no).replace(/\.png$/, "")}-a${seq}.png` });
    } catch (error) {
      if (!ctx.signal?.aborted && (isRefusal(error) || isTimeout(error))) continue;
      throw error;
    }
  }
}

export async function renderChapter(ctx: Context, chapterNumber: number | string, options: { force?: boolean } = {}) {
  const chapter = await getChapter(ctx, chapterNumber);
  const pages = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  if (!pages.length) throw new PreconditionError("Adapt and review the chapter before rendering it");
  let cursor = 0;
  let failure: unknown;
  const results: Awaited<ReturnType<typeof renderPage>>[] = [];
  const workers = Array.from({ length: Math.min(ctx.config.image.concurrency, pages.length) }, async () => {
    while (cursor < pages.length && !failure) {
      const page = pages[cursor++];
      try { results.push(await renderPage(ctx, page.id, { redo: options.force })); }
      catch (error) { failure ??= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  if (options.force || chapter.status !== "exported") await ctx.db.run("UPDATE chapters SET status = 'rendered' WHERE id = ?", [chapter.id]);
  return { chapter: chapter.id, pages: results.sort((a, b) => a.id.localeCompare(b.id)), flagged: results.filter((page) => page.status === "flagged").map((page) => page.id) };
}

export async function redoPage(ctx: Context, pageId: string, note?: string) {
  const result = await renderPage(ctx, pageId, { redo: true, note });
  const page = await getPage(ctx, pageId);
  await ctx.db.run("UPDATE chapters SET status = 'rendered' WHERE id = ?", [page.chapter_id]);
  return result;
}

export async function restorePageAttempt(ctx: Context, pageId: string, attemptId: string) {
  const page = await getPage(ctx, pageId);
  await requireStoryboardReady(ctx, page.chapter_id);
  const attempt = await ctx.db.get<Attempt>("SELECT * FROM attempts WHERE id = ? AND page_id = ?", [attemptId, page.id]);
  const review = await ctx.db.get<{ id: string; score: number; passed: number; fix_instructions: string | null; text_check: string | null }>("SELECT * FROM reviews WHERE attempt_id = ?", [attemptId]);
  if (!attempt?.path || attempt.status !== "ok" || !review) throw new PreconditionError("Restore requires a saved reviewed page attempt");
  const note = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`render.note.${page.id}`]);
  const built = await buildPagePrompt(ctx, JSON.parse(page.storyboard), note?.value ?? "");
  if (attempt.prompt !== built.prompt.text || attempt.model !== ctx.config.image.model || attempt.quality !== ctx.config.image.quality || attempt.ref_paths !== JSON.stringify(built.refs.map((ref) => ref.path))) throw new PreconditionError("Saved attempt inputs do not match the current page");
  const bytes = await ctx.fs.readBytes(attempt.path);
  if (!bytes || await sha256(bytes) !== attempt.sha256) throw new PreconditionError("Saved attempt original is missing or changed");
  const result = await selectAttempt(ctx, page, [{ attempt, review: { id: review.id, score: review.score, passed: Boolean(review.passed), corrections: review.fix_instructions ?? "", text_errors: JSON.parse(review.text_check ?? "{}").errors ?? [] } }]);
  await ctx.db.run("UPDATE chapters SET status = 'rendered' WHERE id = ?", [page.chapter_id]);
  return result;
}
