import { extractionSchema, summarySchema, type Extraction } from "../../../schemas/index.js";
import { chapterData, getBible, getChapter } from "../data.js";
import { PreconditionError } from "../errors.js";
import { structuredCall } from "../llm.js";
import type { SqlStatement } from "../ports.js";
import type { Chapter, Context } from "../types.js";

async function saveBible(ctx: Context, extraction: Extraction): Promise<void> {
  const statements: SqlStatement[] = [
    { sql: "DELETE FROM outfits" }, { sql: "DELETE FROM characters" }, { sql: "DELETE FROM locations" },
  ];
  for (const character of extraction.characters) {
    statements.push({ sql: "INSERT INTO characters (id, name, aliases, spec) VALUES (?, ?, ?, ?)", params: [character.id, character.name, JSON.stringify(character.aliases), JSON.stringify(character)] });
    for (const outfit of character.outfits) statements.push({
      sql: "INSERT INTO outfits (id, character_id, name, spec, chapters) VALUES (?, ?, ?, ?, ?)",
      params: [outfit.id, character.id, outfit.name, JSON.stringify(outfit), JSON.stringify(outfit.chapters)],
    });
  }
  for (const location of extraction.locations) statements.push({ sql: "INSERT INTO locations (id, name, spec) VALUES (?, ?, ?)", params: [location.id, location.name, JSON.stringify(location)] });
  statements.push({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('prepare.extract.completed', 'true')" });
  await ctx.db.transaction(statements);
  await ctx.fs.writeJson("bible/characters.json", extraction.characters);
  await ctx.fs.writeJson("bible/locations.json", extraction.locations);
}

export async function addOutfitChapter(ctx: Context, outfitId: string, chapterNumber: number | string, paragraphNumber: number | string) {
  const chapter = await getChapter(ctx, chapterNumber);
  const paragraph = Number(paragraphNumber);
  if (!Number.isSafeInteger(paragraph) || paragraph < 1 || paragraph > chapterData(chapter).paragraphs.length) throw new PreconditionError("Outfit association requires an existing source paragraph");
  const bible = await getBible(ctx);
  const outfit = bible.outfits.find((item) => item.id === outfitId);
  const character = bible.characters.find((item) => item.id === outfit?.id.split(".")[0]);
  const characterOutfit = character?.outfits.find((item) => item.id === outfitId);
  if (!outfit || !character || !characterOutfit) throw new PreconditionError(`Unknown outfit target ${outfitId}`);
  const source = `${chapter.idx}:${paragraph}`;
  const skipped = outfit.chapters.includes(chapter.idx) && characterOutfit.chapters.includes(chapter.idx) && character.evidence.includes(source);
  if (!skipped) {
    if (!outfit.chapters.includes(chapter.idx)) outfit.chapters.push(chapter.idx);
    if (!characterOutfit.chapters.includes(chapter.idx)) characterOutfit.chapters.push(chapter.idx);
    if (!character.evidence.includes(source)) character.evidence.push(source);
    await ctx.db.transaction([
      { sql: "UPDATE outfits SET spec = ?, chapters = ? WHERE id = ?", params: [JSON.stringify(outfit), JSON.stringify(outfit.chapters), outfitId] },
      { sql: "UPDATE characters SET spec = ? WHERE id = ?", params: [JSON.stringify(character), character.id] },
    ]);
  }
  await ctx.fs.writeJson("bible/characters.json", bible.characters);
  return { chapter: chapter.id, outfit: outfitId, source, skipped };
}

export async function prepareBook(ctx: Context, options: { force?: boolean } = {}) {
  const chapters = await ctx.db.all<Chapter>("SELECT * FROM chapters ORDER BY idx");
  if (!chapters.length) throw new PreconditionError("Import a novel before preparing its settings");
  const tokenEstimate = Math.ceil(chapters.reduce((length, chapter) => length + chapter.text.length, 0) / ctx.config.llm.chars_per_token);
  const chunkSize = tokenEstimate > ctx.config.llm.full_book_max_tokens ? ctx.config.llm.chunk_chapters : chapters.length;
  const chunks = Array.from({ length: Math.ceil(chapters.length / chunkSize) }, (_, index) => chapters.slice(index * chunkSize, (index + 1) * chunkSize));
  if (options.force) await ctx.db.transaction([
    { sql: "DELETE FROM meta WHERE key LIKE 'prepare.%'" },
    { sql: "UPDATE chapters SET summary = NULL" },
  ]);
  const extracted = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'prepare.extract.completed'");
  if (!extracted) {
    const extractions: Extraction[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const input = JSON.stringify({ chapters: chunks[index].map(({ id, idx, text }) => ({ id, idx, text })), model: ctx.config.models.extract });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
      const key = `prepare.chunk.extract.${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const cached = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
      const extraction = cached ? extractionSchema.parse(JSON.parse(cached.value)) : await structuredCall(ctx, {
        step: "prepare", template: "extract", model: ctx.config.models.extract, schema: extractionSchema,
        data: { chapters: chunks[index].map(chapterData) }, estimate: ctx.config.budget.estimates.full_book,
      });
      await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, JSON.stringify(extraction)]);
      extractions.push(extraction);
    }
    const extraction = extractions.length === 1 ? extractions[0] : await structuredCall(ctx, {
      step: "prepare", template: "merge", model: ctx.config.models.extract, schema: extractionSchema,
      data: { extractions, chapters: chapters.map(({ idx, title }) => ({ idx, title, paragraphs: [] })) }, estimate: ctx.config.budget.estimates.full_book,
    });
    await saveBible(ctx, extraction);
  }
  const summarized = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'prepare.summary.completed'");
  if (!summarized) {
    const chapterSummary = summarySchema.shape.chapters.element;
    const schema = summarySchema.extend({ chapters: chapterSummary.extend({ summary: chapterSummary.shape.summary.max(ctx.config.summary.max_chars) }).array() });
    for (const chunk of chunks) {
      const latest = await ctx.db.all<Chapter>("SELECT * FROM chapters ORDER BY idx");
      if (!options.force && chunk.every((chapter) => latest.find((item) => item.id === chapter.id)?.summary)) continue;
      const result = await structuredCall(ctx, {
        step: "prepare", template: "summary", model: ctx.config.models.extract, schema,
        data: { chapters: chunk.map(chapterData) }, estimate: ctx.config.budget.estimates.full_book,
      });
      if (result.chapters.length !== chunk.length || new Set(result.chapters.map((item) => item.chapter)).size !== chunk.length || chunk.some((chapter) => !result.chapters.some((item) => item.chapter === chapter.idx))) {
        throw new Error("Summary output must contain exactly one entry for every requested chapter");
      }
      await ctx.db.transaction(result.chapters.map((summary) => ({ sql: "UPDATE chapters SET summary = ? WHERE idx = ?", params: [summary.summary, summary.chapter] })));
    }
    await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('prepare.summary.completed', 'true')");
  }
  ctx.log("info", "Book settings and chapter summaries are ready");
  return { chapters: chapters.length, chunks: chunks.length, estimated_tokens: tokenEstimate, skipped: Boolean(extracted && summarized) };
}
