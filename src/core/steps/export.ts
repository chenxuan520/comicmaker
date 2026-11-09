import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getChapter, requireStoryboardReady } from "../data.js";
import { PreconditionError } from "../errors.js";
import { pngSize } from "../image.js";
import { pageFile, STRIP_LAYOUT, type Context, type Page, type PageStoryboard } from "../types.js";

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
  if (!options.force && chapter.status === "exported" && (!paths.pdf || await ctx.fs.readBytes(paths.pdf)) && (!paths.html || await ctx.fs.readText(paths.html))) return { chapter: chapter.id, ...paths, flagged, skipped: true };
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
  for (const row of rows) {
    if (row.final_attempt_id) {
      const path = `chapters/${chapter.id}/pages/${pageFile(row.page_no)}`;
      const data = await ctx.fs.readBytes(path);
      if (!data) throw new PreconditionError(`Final page copy is missing: ${path}`);
      const size = pngSize(data);
      if (pdf) {
        const image = await pdf.embedPng(data);
        pdf.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      }
      htmlPages.push(`<figure><img src="../pages/${pageFile(row.page_no)}" width="${size.width}" height="${size.height}" loading="lazy" alt="${htmlEscape(chapter.title)} ${row.page_no}"><figcaption>${row.page_no}${row.status === "flagged" ? " · flagged" : ""}</figcaption></figure>`);
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
  await ctx.db.run("UPDATE chapters SET status = 'exported' WHERE id = ?", [chapter.id]);
  ctx.log("info", `Exported chapter ${chapter.id}`, { ...paths, flagged });
  return { chapter: chapter.id, ...paths, flagged, skipped: false };
}
