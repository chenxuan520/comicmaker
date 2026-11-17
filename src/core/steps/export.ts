import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getChapter, requireStoryboardReady } from "../data.js";
import { PreconditionError } from "../errors.js";
import { jpegSize, pngSize, sha256 } from "../image.js";
import { renderModernReader } from "../reader.js";
import { pageFile, readingFile, isStripLayout, type Context, type Page, type PageStoryboard, type ReadingImages, type UploadedImages } from "../types.js";

function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) { lines.push(line); line = ""; }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export async function exportChapter(ctx: Context, chapterNumber: number | string, options: { force?: boolean; font?: Uint8Array } = {}) {
  const chapter = await getChapter(ctx, chapterNumber);
  await requireStoryboardReady(ctx, chapter.id);
  const rows = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  if (!rows.length || rows.some((page) => !["passed", "flagged", "exported"].includes(page.status))) throw new PreconditionError("Render all chapter pages before exporting");
  const base = `chapters/${chapter.id}/export`;
  const flagged = rows.filter((page) => page.status === "flagged").map((page) => page.id);
  const paths = { pdf: ctx.config.export.pdf ? `${base}/chapter.pdf` : null, html: ctx.config.export.html ? `${base}/index.html` : null };
  const targetKb = ctx.config.export.reading_image_kb;
  const maxWidth = ctx.config.export.reading_max_width;
  const readingKey = `export.reading.${chapter.id}`;
  const marker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [readingKey]);
  const previous = marker ? JSON.parse(marker.value) as ReadingImages : undefined;
  const copies = new Map<string, Uint8Array>();
  if (targetKb !== null && previous?.target_kb === targetKb && previous.max_width === maxWidth) {
    for (const row of rows) {
      if (row.final_attempt_id && previous.attempts[row.id] === row.final_attempt_id) {
        const bytes = await ctx.fs.readBytes(`${base}/${readingFile(row.page_no)}`);
        if (bytes) copies.set(row.id, bytes);
      }
    }
  }
  const readingReady = targetKb === null ? !previous || previous.target_kb === null : previous?.target_kb === targetKb && previous.max_width === maxWidth && copies.size === rows.filter((row) => row.final_attempt_id).length;
  const uploadKey = `export.upload.${chapter.id}`;
  const uploadMarker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [uploadKey]);
  const savedUploads = uploadMarker ? JSON.parse(uploadMarker.value) as UploadedImages : undefined;
  const imgbed = ctx.config.export.imgbed;
  const uploads: UploadedImages = savedUploads?.base_url === imgbed.base_url && savedUploads.target_kb === targetKb && (targetKb === null || savedUploads.max_width === maxWidth) ? savedUploads : { base_url: imgbed.base_url, target_kb: targetKb, max_width: maxWidth, pages: {} };
  const imageUrls = () => Object.fromEntries(rows.filter((row) => row.final_attempt_id && uploads.pages[row.id]?.attempt_id === row.final_attempt_id).map((row) => [row.id, uploads.pages[row.id].url]));
  const uploadReadingImage = async (row: Page, data: Uint8Array): Promise<boolean> => {
    ctx.signal?.throwIfAborted();
    const attemptId = row.final_attempt_id!;
    const hash = await sha256(data);
    const cached = uploads.pages[row.id];
    let uploaded = false;
    if (!cached || cached.attempt_id !== attemptId || cached.sha256 !== hash) {
      if (!ctx.imageHost) throw new PreconditionError("An ImgBed uploader is required when export.imgbed.enabled is true");
      const name = targetKb === null ? pageFile(row.page_no) : readingFile(row.page_no);
      const url = await ctx.imageHost.upload(`${base}/${ctx.project.id}-${chapter.id}-${attemptId}-${hash}-${name}`, data, ctx.signal);
      uploads.pages[row.id] = { attempt_id: attemptId, sha256: hash, url };
      await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [uploadKey, JSON.stringify(uploads)]);
      ctx.log("info", `Uploaded reading image ${row.id}`);
      uploaded = true;
    }
    ctx.signal?.throwIfAborted();
    return uploaded;
  };
  if (!options.force && readingReady && chapter.status === "exported" && (!paths.pdf || await ctx.fs.readBytes(paths.pdf)) && (!paths.html || await ctx.fs.readText(paths.html))) {
    let uploaded = false;
    if (imgbed.enabled) {
      for (const row of rows.filter((page) => page.final_attempt_id)) {
        const path = targetKb === null ? `chapters/${chapter.id}/pages/${pageFile(row.page_no)}` : `${base}/${readingFile(row.page_no)}`;
        const data = targetKb === null ? await ctx.fs.readBytes(path) : copies.get(row.id);
        if (!data) throw new PreconditionError(`Final reading image is missing: ${path}`);
        if (await uploadReadingImage(row, data)) uploaded = true;
      }
    }
    return { chapter: chapter.id, ...paths, flagged, image_urls: imageUrls(), skipped: !uploaded };
  }
  const isStrip = rows.every((row) => isStripLayout((JSON.parse(row.storyboard) as PageStoryboard).layout));
  const dimensions = ctx.config.image.size.split("x").map(Number);
  const fallbackSize = { width: dimensions[0], height: dimensions[1] };
  const pdf = ctx.config.export.pdf ? await PDFDocument.create() : undefined;
  const textSettings = ctx.config.export.text as { font_size: number; margin: number; line_height: number };
  let font: PDFFont | undefined;
  if (pdf && (ctx.config.export.ai_notice_page || rows.some((row) => !row.final_attempt_id))) {
    if (!options.font) throw new PreconditionError("A Chinese font is required for PDF text pages. Set export.font_path to a local TTF/OTF/TTC font.");
    pdf.registerFontkit({ ...fontkit, create: (data: Uint8Array) => {
      const result = fontkit.create(data) as ReturnType<typeof fontkit.create> & { fonts?: ReturnType<typeof fontkit.create>[] };
      return result.fonts?.[0] ?? result;
    } });
    font = await pdf.embedFont(options.font, { subset: true });
  }
  const addTextPages = (text: string) => {
    if (!pdf || !font) return;
    const { font_size: fontSize, margin, line_height: lineHeight } = textSettings;
    const lines = wrapText(text, font, fontSize, fallbackSize.width - margin * 2);
    const linesPerPage = Math.max(1, Math.floor((fallbackSize.height - margin * 2) / lineHeight));
    for (let offset = 0; offset < lines.length; offset += linesPerPage) {
      const page = pdf.addPage([fallbackSize.width, fallbackSize.height]);
      lines.slice(offset, offset + linesPerPage).forEach((line, index) => page.drawText(line, { x: margin, y: fallbackSize.height - margin - fontSize - index * lineHeight, font, size: fontSize, color: rgb(0.1, 0.1, 0.1) }));
    }
  };
  const htmlPages: string[] = [];
  const reading: ReadingImages = { target_kb: targetKb, max_width: maxWidth, attempts: {} };
  for (const row of rows) {
    if (row.final_attempt_id) {
      const path = `chapters/${chapter.id}/pages/${pageFile(row.page_no)}`;
      const data = await ctx.fs.readBytes(path);
      if (!data) throw new PreconditionError(`Final page copy is missing: ${path}`);
      const size = pngSize(data);
      const readingData = targetKb === null ? data : copies.get(row.id) ?? await ctx.fs.writeReadingCopy(`${base}/${readingFile(row.page_no)}`, data, targetKb, maxWidth);
      const readingSize = targetKb === null ? size : jpegSize(readingData);
      if (imgbed.enabled) await uploadReadingImage(row, readingData);
      if (targetKb !== null) reading.attempts[row.id] = row.final_attempt_id;
      if (targetKb !== null) reading.attempts[row.id] = row.final_attempt_id;
      if (pdf) {
        const image = targetKb === null ? await pdf.embedPng(data) : await pdf.embedJpg(readingData);
        pdf.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      }
      const imageSource = targetKb === null ? `../pages/${pageFile(row.page_no)}` : readingFile(row.page_no);
      if (isStrip) {
        htmlPages.push(`<img src="${imageSource}" width="${readingSize.width}" height="${readingSize.height}" loading="lazy" alt="${htmlEscape(chapter.title)} ${row.page_no}${row.status === "flagged" ? "，待复核" : ""}">`);
      } else {
        htmlPages.push(`<figure><img src="${imageSource}" width="${readingSize.width}" height="${readingSize.height}" loading="lazy" alt="${htmlEscape(chapter.title)} ${row.page_no}"><figcaption>${row.page_no}${row.status === "flagged" ? " · flagged" : ""}</figcaption></figure>`);
      }
    } else {
      const storyboard = JSON.parse(row.storyboard) as PageStoryboard;
      const text = storyboard.panels.flatMap((panel) => panel.dialogue.map((dialogue) => dialogue.text)).join("\n");
      addTextPages(text || chapter.title);
      htmlPages.push(`<article class="text-page"><h2>${htmlEscape(chapter.title)} · ${row.page_no}</h2><p>${htmlEscape(text).replace(/\n/g, "<br>")}</p></article>`);
    }
  }
  if (ctx.config.export.ai_notice_page) {
    addTextPages(ctx.config.export.ai_notice_text);
    htmlPages.push(`<article class="text-page notice"><p>${htmlEscape(ctx.config.export.ai_notice_text)}</p></article>`);
  }
  if (pdf && paths.pdf) await ctx.fs.writeBytes(paths.pdf, await pdf.save());
  if (paths.html) {
    const allChapters = await ctx.db.all<{ id: string; idx: number; title: string; status: string }>(
      "SELECT id, idx, title, status FROM chapters ORDER BY idx"
    );
    const chapterIdx = typeof chapter.idx === "number" ? chapter.idx : Number(chapterNumber);
    const currentIndex = allChapters.findIndex((c) => c.id === chapter.id);
    const prevChapter = currentIndex > 0 ? allChapters[currentIndex - 1] : null;
    const nextChapter = currentIndex >= 0 && currentIndex < allChapters.length - 1 ? allChapters[currentIndex + 1] : null;

    const htmlContent = renderModernReader({
      projectTitle: ctx.project.title,
      chapter: { id: chapter.id, idx: chapterIdx, title: chapter.title },
      allChapters: allChapters.map((c) => ({ id: c.id, idx: c.idx, title: c.title })),
      prevChapter: prevChapter ? { id: prevChapter.id, idx: prevChapter.idx, title: prevChapter.title } : null,
      nextChapter: nextChapter ? { id: nextChapter.id, idx: nextChapter.idx, title: nextChapter.title } : null,
      pagesHtml: htmlPages,
      isStrip,
      hasPdf: Boolean(pdf && paths.pdf),
      fallbackWidth: fallbackSize.width,
    });
    await ctx.fs.writeText(paths.html, htmlContent);
  }
  await ctx.db.transaction([
    { sql: "UPDATE chapters SET status = 'exported' WHERE id = ?", params: [chapter.id] },
    { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [readingKey, JSON.stringify(reading)] },
  ]);
  ctx.log("info", `Exported chapter ${chapter.id}`, { ...paths, flagged });
  return { chapter: chapter.id, ...paths, flagged, image_urls: imageUrls(), skipped: false };
}
