import { getBible } from "./data.js";
import { chapterId, STRIP_LAYOUT, type Chapter, type Context, type Page, type Ref } from "./types.js";

export async function getStatus(ctx: Context, chapterNumber?: number | string) {
  const filter = chapterNumber === undefined ? "" : "WHERE c.id = ?";
  const params = chapterNumber === undefined ? [] : [chapterId(chapterNumber)];
  const chapters = await ctx.db.all<Omit<Chapter, "text"> & { page_count: number; flagged_count: number }>(`
    SELECT c.id, c.idx, c.title, c.summary, c.status, (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = c.id) AS page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = c.id AND p.status = 'flagged') AS flagged_count
    FROM chapters c ${filter} ORDER BY c.idx`, params);
  const rows = await ctx.db.all<Page>(`SELECT * FROM pages ${chapterNumber === undefined ? "" : "WHERE chapter_id = ?"} ORDER BY chapter_id, page_no`, params);
  const reviews = await ctx.db.all<Record<string, unknown> & { page_id: string }>(`SELECT r.*, a.page_id FROM reviews r JOIN attempts a ON a.id = r.attempt_id JOIN pages p ON p.id = a.page_id ${chapterNumber === undefined ? "" : "WHERE p.chapter_id = ?"} ORDER BY a.seq`, params);
  const byPage = new Map<string, Record<string, unknown>[]>();
  for (const { page_id, ...review } of reviews) {
    const group = byPage.get(page_id) ?? [];
    group.push(review);
    byPage.set(page_id, group);
  }
  const pages = rows.map((page) => ({
    ...page, storyboard: JSON.parse(page.storyboard),
    format: JSON.parse(page.storyboard).layout === STRIP_LAYOUT ? "strip" as const : "page" as const,
    image_path: page.final_attempt_id ? `chapters/${page.chapter_id}/pages/p${String(page.page_no).padStart(2, "0")}.png` : null,
    reviews: byPage.get(page.id) ?? [],
  }));
  const refs = await ctx.db.all<Ref>("SELECT * FROM refs WHERE path IS NOT NULL ORDER BY kind, target_id, id");
  const reviewMeta = await ctx.db.all<{ key: string; value: string }>("SELECT * FROM meta WHERE key LIKE 'storyboard.review.%'");
  const warnings = reviewMeta.filter((row) => { const value = JSON.parse(row.value); return value.completed && !value.passed; }).map((row) => `Storyboard review warning for chapter ${row.key.split(".").at(-1)}`);
  return { project: ctx.project, comic_format: ctx.config.storyboard.format, chapters, pages, refs, ...await getBible(ctx), warnings, flagged: pages.filter((page) => page.status === "flagged").map((page) => page.id), export_options: { pdf: ctx.config.export.pdf, html: ctx.config.export.html } };
}
