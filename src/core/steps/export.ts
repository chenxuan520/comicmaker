import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getChapter, requireStoryboardReady } from "../data.js";
import { PreconditionError } from "../errors.js";
import { pngSize, sha256 } from "../image.js";
import { pageFile, readingFile, STRIP_LAYOUT, type Context, type Page, type PageStoryboard, type ReadingImages, type UploadedImages } from "../types.js";

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
  const readingKey = `export.reading.${chapter.id}`;
  const marker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [readingKey]);
  const previous = marker ? JSON.parse(marker.value) as ReadingImages : undefined;
  const copies = new Map<string, Uint8Array>();
  if (targetKb !== null && previous?.target_kb === targetKb) {
    for (const row of rows) {
      if (row.final_attempt_id && previous.attempts[row.id] === row.final_attempt_id) {
        const bytes = await ctx.fs.readBytes(`${base}/${readingFile(row.page_no)}`);
        if (bytes) copies.set(row.id, bytes);
      }
    }
  }
  const readingReady = targetKb === null ? !previous || previous.target_kb === null : previous?.target_kb === targetKb && copies.size === rows.filter((row) => row.final_attempt_id).length;
  const uploadKey = `export.upload.${chapter.id}`;
  const uploadMarker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [uploadKey]);
  const savedUploads = uploadMarker ? JSON.parse(uploadMarker.value) as UploadedImages : undefined;
  const imgbed = ctx.config.export.imgbed;
  const uploads: UploadedImages = savedUploads?.base_url === imgbed.base_url && savedUploads.target_kb === targetKb ? savedUploads : { base_url: imgbed.base_url, target_kb: targetKb, pages: {} };
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
  const isStrip = rows.every((row) => (JSON.parse(row.storyboard) as PageStoryboard).layout === STRIP_LAYOUT);
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
  const reading: ReadingImages = { target_kb: targetKb, attempts: {} };
  for (const row of rows) {
    if (row.final_attempt_id) {
      const path = `chapters/${chapter.id}/pages/${pageFile(row.page_no)}`;
      const data = await ctx.fs.readBytes(path);
      if (!data) throw new PreconditionError(`Final page copy is missing: ${path}`);
      const size = pngSize(data);
      const readingData = targetKb === null ? data : copies.get(row.id) ?? await ctx.fs.writeReadingCopy(`${base}/${readingFile(row.page_no)}`, data, targetKb);
      if (imgbed.enabled) await uploadReadingImage(row, readingData);
      if (targetKb !== null) reading.attempts[row.id] = row.final_attempt_id;
      if (targetKb !== null) reading.attempts[row.id] = row.final_attempt_id;
      if (pdf) {
        const image = targetKb === null ? await pdf.embedPng(data) : await pdf.embedJpg(readingData);
        pdf.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      }
      const imageSource = targetKb === null ? `../pages/${pageFile(row.page_no)}` : readingFile(row.page_no);
      if (isStrip) {
        htmlPages.push(`<img src="${imageSource}" width="${size.width}" height="${size.height}" loading="lazy" alt="${htmlEscape(chapter.title)} ${row.page_no}${row.status === "flagged" ? "，待复核" : ""}">`);
      } else {
        htmlPages.push(`<figure><img src="${imageSource}" width="${size.width}" height="${size.height}" loading="lazy" alt="${htmlEscape(chapter.title)} ${row.page_no}"><figcaption>${row.page_no}${row.status === "flagged" ? " · flagged" : ""}</figcaption></figure>`);
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
  if (paths.html) await ctx.fs.writeText(paths.html, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(ctx.project.title)} · ${htmlEscape(chapter.title)}</title>
<style>body{margin:0;background:#eeeae2;color:#242b2a;font-family:system-ui,sans-serif}header,main{max-width:${fallbackSize.width}px;margin:auto}header{padding:24px;box-sizing:border-box}h1{font-size:24px}figure{margin:0 0 24px}img{display:block;width:100%;height:auto;background:white}figcaption{text-align:center;padding:12px;font-size:12px}.text-page{box-sizing:border-box;min-height:70vh;background:white;padding:8%;margin-bottom:24px;line-height:2}.notice{display:grid;place-content:center;text-align:center}${isStrip ? ".strip{background:white}.strip header,.strip main{max-width:720px}.strip figure{margin:0}.strip figcaption{padding:8px 12px;text-align:right;color:#59665e}.strip .text-page{margin-bottom:0}" : ""}</style></head>
<body${isStrip ? ' class="strip" data-format="strip"' : ""}><header><h1>${htmlEscape(ctx.project.title)}</h1><p>${htmlEscape(chapter.title)}</p>${isStrip ? "<p>手机条漫 · 单列四格 · 向下滑动阅读</p>" : ""}</header><main>${htmlPages.join("\n")}</main></body></html>\n`);
  await ctx.db.transaction([
    { sql: "UPDATE chapters SET status = 'exported' WHERE id = ?", params: [chapter.id] },
    { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [readingKey, JSON.stringify(reading)] },
  ]);
  ctx.log("info", `Exported chapter ${chapter.id}`, { ...paths, flagged });
  return { chapter: chapter.id, ...paths, flagged, image_urls: imageUrls(), skipped: false };
}
