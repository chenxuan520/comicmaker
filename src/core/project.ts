import type { Config } from "../../schemas/index.js";
import { PreconditionError } from "./errors.js";
import type { ProjectStore, SqlStatement } from "./ports.js";
import { chapterId, type Context } from "./types.js";

export async function createProject(store: ProjectStore, id: string, title: string, style?: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new PreconditionError("Project ID must contain lowercase letters, digits and hyphens");
  if (!title.trim()) throw new PreconditionError("Project title is required");
  const handle = await store.create({ id, title: title.trim(), style_desc: style, created_at: new Date().toISOString() });
  await handle.db.close();
  return { id, title: title.trim() };
}

export function decodeNovel(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("gb18030", { fatal: true }).decode(bytes), encoding: "GB18030" };
  }
}

export function splitNovel(text: string, config: Config["import"], fallbackTitle: string): { idx: number; title: string; text: string }[] {
  const strip = config.strip_patterns.map((pattern) => new RegExp(pattern));
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => !strip.some((pattern) => pattern.test(line)))
    .join("\n").replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, "\n\n").trim();
  if (!cleaned) throw new PreconditionError("Novel is empty after cleaning");
  const chapterPattern = new RegExp(config.chapter_regex);
  const result: { idx: number; title: string; text: string }[] = [];
  let title: string | null = null;
  let lines: string[] = [];
  for (const line of cleaned.split("\n")) {
    if (chapterPattern.test(line)) {
      if (title !== null) result.push({ idx: result.length + 1, title, text: lines.join("\n").trim() });
      title = line.trim().replace(/^#{1,6}\s+/, "");
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (title !== null) result.push({ idx: result.length + 1, title, text: lines.join("\n").trim() });
  else result.push({ idx: 1, title: fallbackTitle, text: cleaned });
  if (result.some((chapter) => !chapter.text)) throw new PreconditionError("Found an empty chapter; check import.chapter_regex");
  return result;
}

export async function importNovel(ctx: Context, bytes: Uint8Array, options: { force?: boolean } = {}) {
  const decoded = decodeNovel(bytes);
  const chapters = splitNovel(decoded.text, ctx.config.import, ctx.project.title);
  await ctx.fs.writeNovel(bytes, options.force ?? false, new Date().toISOString().replace(/[:.]/g, "-"));
  const statements: SqlStatement[] = [
    { sql: "DELETE FROM adaptations" },
    { sql: "DELETE FROM pages" },
    { sql: "DELETE FROM chapters" },
    { sql: "DELETE FROM meta WHERE key LIKE 'prepare.%' OR key LIKE 'storyboard.%' OR key LIKE 'render.%' OR key LIKE 'export.upload.%' OR key = 'schedule.next'" },
    ...chapters.map((chapter) => ({
      sql: "INSERT INTO chapters (id, idx, title, text, summary, status) VALUES (?, ?, ?, ?, NULL, 'imported')",
      params: [chapterId(chapter.idx), chapter.idx, chapter.title, chapter.text],
    })),
  ];
  await ctx.db.transaction(statements);
  ctx.log("info", `Imported ${chapters.length} chapters (${decoded.encoding})`);
  return { chapters: chapters.length, encoding: decoded.encoding };
}
