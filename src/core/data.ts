import type { Bible, Chapter, Context, Page } from "./types.js";
import { chapterId, paragraphs } from "./types.js";
import { PreconditionError } from "./errors.js";

export async function getChapter(ctx: Context, number: number | string): Promise<Chapter> {
  const id = chapterId(number);
  const chapter = await ctx.db.get<Chapter>("SELECT * FROM chapters WHERE id = ?", [id]);
  if (!chapter) throw new PreconditionError(`Chapter ${id} not found; import a novel first`);
  return { ...chapter, title: chapter.title.replace(/^#{1,6}\s+/, "") };
}

export async function getPage(ctx: Context, id: string): Promise<Page> {
  const page = await ctx.db.get<Page>("SELECT * FROM pages WHERE id = ?", [id]);
  if (!page) throw new PreconditionError(`Page ${id} not found; adapt its chapter first`);
  return page;
}

export async function getBible(ctx: Context): Promise<Bible> {
  const load = async <T>(table: string) => (await ctx.db.all<{ spec: string }>(`SELECT spec FROM ${table} ORDER BY id`)).map((row) => JSON.parse(row.spec) as T);
  return { characters: await load<Bible["characters"][number]>("characters"), outfits: await load<Bible["outfits"][number]>("outfits"), locations: await load<Bible["locations"][number]>("locations") };
}

export function chapterData(chapter: Chapter) {
  return { ...chapter, paragraphs: paragraphs(chapter.text) };
}

export function entitiesForChapter(bible: Bible, chapter: Chapter): Bible {
  const characters = bible.characters.filter((character) => {
    const names = [character.name, ...character.aliases.filter((name) => [...name].length > 1)];
    const mentionedText = names.reduce((text, name) => name ? text.replaceAll(`比${name}`, "") : text, chapter.text);
    return character.evidence.some((source) => source.startsWith(`${chapter.idx}:`)) ||
      names.some((name) => name && mentionedText.includes(name)) ||
      bible.outfits.some((outfit) => outfit.id.startsWith(`${character.id}.`) && outfit.chapters.includes(chapter.idx));
  });
  const ids = new Set(characters.map((character) => character.id));
  const outfits = bible.outfits.filter((outfit) => ids.has(outfit.id.split(".")[0]) && (outfit.chapters.length === 0 || outfit.chapters.includes(chapter.idx)));
  const locations = bible.locations.filter((location) => location.chapters.includes(chapter.idx) || chapter.text.includes(location.name));
  return { characters, outfits, locations };
}

export async function requireStoryboardReady(ctx: Context, chapter: string): Promise<void> {
  if (!await ctx.db.get("SELECT chapter_id FROM adaptations WHERE chapter_id = ?", [chapter])) return;
  const marker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`storyboard.review.${chapter}`]);
  if (!marker || !JSON.parse(marker.value).completed) throw new PreconditionError(`Complete storyboard validation for chapter ${chapter} before rendering or exporting`);
}

export async function requireLocked(ctx: Context, outfits: string[], locations: string[]): Promise<void> {
  const missing: { kind: string; target: string }[] = [];
  for (const [kind, targets] of [["style", ["project"]], ["outfit", outfits], ["location", locations]] as const) {
    for (const target of new Set(targets)) {
      const ref = await ctx.db.get<{ path: string | null }>("SELECT path FROM refs WHERE kind = ? AND target_id = ? AND status = 'locked'", [kind, target]);
      if (!ref?.path || !await ctx.fs.readBytes(ref.path)) missing.push({ kind, target });
    }
  }
  if (missing.length) throw new PreconditionError("Lock the missing reference images before continuing", { missing });
}
