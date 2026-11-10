import { getBible } from "./data.js";
import { chapterId, readingFile, STRIP_LAYOUT, type Chapter, type Context, type Page, type Ref, type ReadingImages, type UploadedImages } from "./types.js";

export async function getStatus(ctx: Context, chapterNumber?: number | string) {
  const filter = chapterNumber === undefined ? "" : "WHERE c.id = ?";
  const params = chapterNumber === undefined ? [] : [chapterId(chapterNumber)];
  const chapters = await ctx.db.all<Omit<Chapter, "text"> & { page_count: number; flagged_count: number }>(`
    SELECT c.id, c.idx, c.title, c.summary, c.status,       (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = c.id) AS page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = c.id AND p.status = 'flagged') AS flagged_count
    FROM chapters c ${filter} ORDER BY c.idx`, params);
  const cleanTitle = (title: string) => title.replace(/^#{1,6}\s+/, "");

  const rows = await ctx.db.all<Page>(`SELECT * FROM pages ${chapterNumber === undefined ? "" : "WHERE chapter_id = ?"} ORDER BY chapter_id, page_no`, params);
  const reviews = await ctx.db.all<Record<string, unknown> & { page_id: string }>(`SELECT r.*, a.page_id FROM reviews r JOIN attempts a ON a.id = r.attempt_id JOIN pages p ON p.id = a.page_id ${chapterNumber === undefined ? "" : "WHERE p.chapter_id = ?"} ORDER BY a.seq`, params);
  const byPage = new Map<string, Record<string, unknown>[]>();
  for (const { page_id, ...review } of reviews) {
    const group = byPage.get(page_id) ?? [];
    group.push(review);
    byPage.set(page_id, group);
  }
  const readingRows = await ctx.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'export.reading.%'");
  const reading = new Map(readingRows.map((row) => [row.key.slice("export.reading.".length), JSON.parse(row.value) as ReadingImages]));
  const uploadRows = await ctx.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'export.upload.%'");
  const uploads = new Map(uploadRows.map((row) => [row.key.slice("export.upload.".length), JSON.parse(row.value) as UploadedImages]));
  const pages = await Promise.all(rows.map(async (page) => {
    const exported = reading.get(page.chapter_id);
    const hosted = uploads.get(page.chapter_id);
    const hostedImage = hosted?.pages[page.id];
    const hostedUrl = hosted?.base_url === ctx.config.export.imgbed.base_url && hosted.target_kb === ctx.config.export.reading_image_kb && hostedImage?.attempt_id === page.final_attempt_id ? hostedImage?.url ?? null : null;
    const readingPath = page.final_attempt_id && ctx.config.export.reading_image_kb !== null && exported?.target_kb === ctx.config.export.reading_image_kb && exported?.attempts[page.id] === page.final_attempt_id ? `chapters/${page.chapter_id}/export/${readingFile(page.page_no)}` : null;
    return {
      ...page, storyboard: JSON.parse(page.storyboard),
      format: JSON.parse(page.storyboard).layout === STRIP_LAYOUT ? "strip" as const : "page" as const,
      image_path: page.final_attempt_id ? `chapters/${page.chapter_id}/pages/p${String(page.page_no).padStart(2, "0")}.png` : null,
      reading_image_path: readingPath && await ctx.fs.exists(readingPath) ? readingPath : null,
      hosted_image_url: hostedUrl,
      reviews: byPage.get(page.id) ?? [],
    };
  }));
  const refs = await ctx.db.all<Ref>("SELECT * FROM refs WHERE path IS NOT NULL ORDER BY kind, target_id, id");
  const reviewMeta = await ctx.db.all<{ key: string; value: string }>("SELECT * FROM meta WHERE key LIKE 'storyboard.review.%'");
  const warnings = reviewMeta.filter((row) => { const value = JSON.parse(row.value); return value.completed && !value.passed; }).map((row) => `Storyboard review warning for chapter ${row.key.split(".").at(-1)}`);
  return { project: ctx.project, comic_format: ctx.config.storyboard.format, chapters: chapters.map(chapter => ({ ...chapter, title: cleanTitle(chapter.title) })), pages, refs, ...await getBible(ctx), warnings, flagged: pages.filter((page) => page.status === "flagged").map((page) => page.id), export_options: { pdf: ctx.config.export.pdf, html: ctx.config.export.html, imgbed: ctx.config.export.imgbed } };
}
