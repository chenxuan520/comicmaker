import { adaptationSchema, storyboardSchema, storyboardReviewSchema, type Scene, type PageStoryboard, type StoryboardIssue } from "../../../schemas/index.js";
import { getChapter, getBible, entitiesForChapter, chapterData, requireLocked, firstAppearanceCharacters } from "../data.js";
import { ComicError, PreconditionError } from "../errors.js";
import { structuredCall } from "../llm.js";
import type { SqlStatement } from "../ports.js";
import { validateStoryboard } from "../storyboardCheck.js";
import type { Context, Page, Ref } from "../types.js";

interface ReviewState { completed: boolean; passed: boolean; issues: StoryboardIssue[] }

export async function saveStoryboard(ctx: Context, chapterId: string, pages: PageStoryboard[], options: { force?: boolean; resetReviewProgress?: boolean } = {}): Promise<void> {
  const chapter = await getChapter(ctx, chapterId);
  const parsed = storyboardSchema.parse({ pages }).pages;
  if (!parsed.length) throw new ComicError("A chapter storyboard must contain at least one page");
  if (new Set(parsed.map((page) => page.page_no)).size !== parsed.length) throw new ComicError("Storyboard contains duplicate page numbers");
  const existing = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  const statements: SqlStatement[] = [];
  const ids = new Set<string>();
  for (const page of parsed) {
    const id = `${chapter.id}-p${String(page.page_no).padStart(2, "0")}`;
    ids.add(id);
    const storyboard = JSON.stringify(page);
    const previous = existing.find((row) => row.id === id);
    if (!options.force && previous) {
      const saved = storyboardSchema.parse({ pages: [JSON.parse(previous.storyboard)] }).pages[0];
      if (JSON.stringify(saved) === storyboard) continue;
    }
    const latest = await ctx.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM attempts WHERE page_id = ?", [id]);
    statements.push(
      {
        sql: "INSERT INTO pages (id, chapter_id, page_no, storyboard, status, final_attempt_id) VALUES (?, ?, ?, ?, 'planned', NULL) ON CONFLICT(id) DO UPDATE SET storyboard = excluded.storyboard, status = 'planned', final_attempt_id = NULL",
        params: [id, chapter.id, page.page_no, storyboard],
      },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [`render.start.${id}`, String(latest!.seq)] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [`render.note.${id}`] },
    );
  }
  if (options.force) {
    for (const page of existing) {
      if (!ids.has(page.id)) statements.push({ sql: "DELETE FROM pages WHERE id = ?", params: [page.id] });
    }
  }
  if (statements.length) {
    if (options.resetReviewProgress) statements.push(
      { sql: "UPDATE chapters SET status = 'storyboarded' WHERE id = ?", params: [chapter.id] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [`storyboard.candidate.${chapter.id}`] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [`storyboard.revisions.${chapter.id}`] },
    );
    statements.push({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [`storyboard.review.${chapter.id}`, JSON.stringify({ completed: false, passed: false, issues: [] })] });
    await ctx.db.transaction(statements);
  }
}

export async function patchStoryboard(ctx: Context, chapterNumber: number | string, updates: PageStoryboard[]) {
  const chapter = await getChapter(ctx, chapterNumber);
  const adaptation = await ctx.db.get<{ scenes: string }>("SELECT scenes FROM adaptations WHERE chapter_id = ?", [chapter.id]);
  if (!adaptation) throw new PreconditionError("Adapt the chapter before patching its storyboard");
  const replacements = storyboardSchema.parse({ pages: updates }).pages;
  const stored = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  const existing = new Set(stored.map((page) => page.page_no));
  if (new Set(replacements.map((page) => page.page_no)).size !== replacements.length) throw new PreconditionError("Storyboard patch contains duplicate page numbers");
  const unknown = replacements.filter((page) => !existing.has(page.page_no)).map((page) => page.page_no);
  if (unknown.length) throw new PreconditionError("Storyboard patch can only replace existing pages", { unknown_pages: unknown });
  const pages = stored.map((row) => replacements.find((page) => page.page_no === row.page_no) ?? storyboardSchema.parse({ pages: [JSON.parse(row.storyboard)] }).pages[0]);
  const bible = await getBible(ctx);
  const refs = await ctx.db.all<Ref>("SELECT * FROM refs WHERE status = 'locked'");
  const issues = validateStoryboard(pages, JSON.parse(adaptation.scenes), entitiesForChapter(bible, chapter), refs, ctx.config);
  if (issues.length) throw new PreconditionError("Storyboard patch failed validation", { issues });
  const updated = stored.filter((row, index) => JSON.stringify(storyboardSchema.parse({ pages: [JSON.parse(row.storyboard)] }).pages[0]) !== JSON.stringify(pages[index])).map((row) => row.id);
  if (!updated.length) return { chapter: chapter.id, updated, review_required: false, skipped: true };
  await saveStoryboard(ctx, chapter.id, pages, { resetReviewProgress: true });
  await ctx.fs.writeJson(`chapters/${chapter.id}/storyboard.json`, { pages });
  return { chapter: chapter.id, updated, review_required: true, skipped: false };
}

function mergeRevision(pages: PageStoryboard[], replacements: PageStoryboard[], issues: StoryboardIssue[], allowNewPages: boolean): PageStoryboard[] {
  const involved = new Set(issues.map((issue) => issue.page));
  const existing = new Set(pages.map((page) => page.page_no));
  const updates = replacements.filter((page) => involved.has(page.page_no) || (allowNewPages && !existing.has(page.page_no)));
  const retained = pages.filter((page) => !involved.has(page.page_no));
  const pageCount = Math.max(pages.length, retained.length + updates.length);
  const missing = [...involved].filter((pageNo) => (!allowNewPages || pageNo <= pageCount) && !updates.some((page) => page.page_no === pageNo));
  if (missing.length) throw new ComicError("Storyboard revision must preserve the issued page numbers", 1, { missing_pages: missing });
  return [...retained.filter((page) => !allowNewPages || page.page_no <= pageCount), ...updates].sort((a, b) => a.page_no - b.page_no);
}

export async function adaptChapter(ctx: Context, chapterNumber: number | string, options: { force?: boolean } = {}): Promise<unknown> {
  const chapter = await getChapter(ctx, chapterNumber);
  const reviewKey = `storyboard.review.${chapter.id}`;
  const revisionKey = `storyboard.revisions.${chapter.id}`;
  const candidateKey = `storyboard.candidate.${chapter.id}`;
  const marker = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [reviewKey]);
  let state = marker ? JSON.parse(marker.value) as ReviewState : undefined;
  const storedPages = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  if (!options.force && ["storyboarded", "rendered", "exported"].includes(chapter.status) && state?.completed && storedPages.length) {
    return { chapter: chapter.id, pages: storedPages.length, passed: state.passed, issues: state.issues, skipped: true };
  }

  for (const key of ["prepare.extract.completed", "prepare.summary.completed"]) {
    const prepared = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
    if (prepared?.value !== "true") throw new PreconditionError("Prepare the imported novel's settings and chapter summaries before adapting", { missing: key });
  }
  const data = chapterData(chapter);
  if (!data.paragraphs.length) throw new PreconditionError(`Chapter ${chapter.id} has no source paragraphs`);
  const bible = await getBible(ctx);
  const entities = entitiesForChapter(bible, chapter);
  const withoutOutfits = entities.characters.filter((character) => !entities.outfits.some((outfit) => outfit.id.split(".")[0] === character.id));
  if (withoutOutfits.length) {
    throw new PreconditionError(`Characters without chapter-relevant outfits: ${withoutOutfits.map((character) => `${character.name} (${character.id})`).join(", ")}; prepare and lock their outfits first`, { characters: withoutOutfits.map((character) => character.id) });
  }
  await requireLocked(ctx, entities.outfits.map((outfit) => outfit.id), entities.locations.map((location) => location.id));
  const refs = await ctx.db.all<Ref>("SELECT * FROM refs WHERE status = 'locked'");
  const previous = chapter.idx === 1 ? undefined : await ctx.db.get<{ summary: string | null }>("SELECT summary FROM chapters WHERE idx = ?", [chapter.idx - 1]);
  const introductions = await firstAppearanceCharacters(ctx, chapter, entities);
  const templateData = { chapter: data, prev_summary: previous?.summary ?? "", ...entities, first_appearance_characters: introductions };
  const stored = await ctx.db.get<{ scenes: string; version: number }>("SELECT scenes, version FROM adaptations WHERE chapter_id = ?", [chapter.id]);
  const generateScenes = Boolean(options.force) || !stored || chapter.status === "imported";
  const adaptation = generateScenes ? await structuredCall(ctx, {
    step: "adapt", template: "adapt", model: ctx.config.models.adapt, schema: adaptationSchema, data: templateData,
  }) : undefined;
  const scenes = adaptation?.scenes ?? JSON.parse(stored!.scenes) as Scene[];
  const characterIds = new Set(entities.characters.map((character) => character.id));
  const outfitIds = new Set(entities.outfits.map((outfit) => outfit.id));
  const locationIds = new Set(entities.locations.map((location) => location.id));
  const sceneIds = new Set<string>();
  const beatIds = new Set<string>();
  const invalid: string[] = [];
  if (!scenes.length) invalid.push("The adaptation has no scenes");
  for (const scene of scenes) {
    if (sceneIds.has(scene.id)) invalid.push(`Duplicate scene ID ${scene.id}`);
    sceneIds.add(scene.id);
    if (!locationIds.has(scene.location_id)) invalid.push(`Scene ${scene.id} uses unknown location ${scene.location_id}`);
    for (const character of scene.characters) {
      if (!characterIds.has(character.id)) invalid.push(`Scene ${scene.id} uses unknown character ${character.id}`);
      if (!outfitIds.has(character.outfit)) invalid.push(`Scene ${scene.id} uses unknown outfit ${character.outfit}`);
      if (character.outfit.split(".")[0] !== character.id) invalid.push(`Outfit ${character.outfit} does not belong to ${character.id}`);
    }
    if (!scene.beats.length) invalid.push(`Scene ${scene.id} has no beats`);
    for (const beat of scene.beats) {
      if (beatIds.has(beat.id)) invalid.push(`Duplicate beat ID ${beat.id}`);
      beatIds.add(beat.id);
      if (!beat.src_paras.length || beat.src_paras.some((paragraph) => !Number.isSafeInteger(paragraph) || paragraph < 1 || paragraph > data.paragraphs.length)) {
        invalid.push(`Beat ${beat.id} source paragraphs must be within 1-${data.paragraphs.length}`);
      }
      for (const dialogue of beat.dialogue) {
        if (dialogue.speaker !== null && !characterIds.has(dialogue.speaker)) invalid.push(`Beat ${beat.id} uses unknown speaker ${dialogue.speaker}`);
      }
    }
  }
  if (invalid.length) throw new ComicError("Scene adaptation is invalid", 1, { issues: invalid });

  if (adaptation) {
    await ctx.db.transaction([
      { sql: "INSERT INTO adaptations (chapter_id, scenes, version) VALUES (?, ?, 1) ON CONFLICT(chapter_id) DO UPDATE SET scenes = excluded.scenes, version = adaptations.version + 1", params: [chapter.id, JSON.stringify(scenes)] },
      { sql: "UPDATE chapters SET status = 'adapted' WHERE id = ?", params: [chapter.id] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [reviewKey, JSON.stringify({ completed: false, passed: false, issues: [] })] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [revisionKey] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [candidateKey] },
      ...(options.force ? [{ sql: "DELETE FROM pages WHERE chapter_id = ?", params: [chapter.id] }] : []),
    ]);
    await ctx.fs.writeJson(`chapters/${chapter.id}/adaptation.json`, adaptation);
    state = undefined;
  } else if (chapter.status !== "adapted") {
    await ctx.db.run("UPDATE chapters SET status = 'adapted' WHERE id = ?", [chapter.id]);
  }

  const pendingCandidate = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [candidateKey]);
  const candidate = pendingCandidate ? JSON.parse(pendingCandidate.value) as { pages: PageStoryboard[]; revisions: number } : undefined;
  const reusePages = !options.force && storedPages.length > 0 && (state !== undefined || chapter.status !== "adapted");
  let pages = candidate ? storyboardSchema.parse({ pages: candidate.pages }).pages : reusePages ? storyboardSchema.parse({ pages: storedPages.map((page) => JSON.parse(page.storyboard)) }).pages : (await structuredCall(ctx, {
    step: "storyboard", template: "storyboard", model: ctx.config.models.storyboard, schema: storyboardSchema,
    data: { ...templateData, scenes, review_issues: [], storyboard: { pages: [] } },
  })).pages;
  let forceFull = Boolean(options.force) || (!reusePages && storedPages.length > 0);
  let revisions = candidate?.revisions ?? Number((await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [revisionKey]))?.value ?? 0);
  let pendingIssues = state && !state.completed && state.issues.length ? state.issues : undefined;
  let review: { pass: boolean; issues: StoryboardIssue[] };
  for (;;) {
    const programIssues = validateStoryboard(pages, scenes, entities, refs, ctx.config);
    if (programIssues.length) {
      if (revisions >= ctx.config.storyboard.max_revisions) throw new ComicError(`Storyboard failed program validation after ${revisions} revisions`, 1, { issues: programIssues });
      const revised = await structuredCall(ctx, {
        step: "storyboard", template: "storyboard", model: ctx.config.models.storyboard, schema: storyboardSchema,
        data: { ...templateData, scenes, review_issues: programIssues, storyboard: { pages } },
      });
      pages = mergeRevision(pages, revised.pages, programIssues, true);
      pendingIssues = undefined;
      revisions++;
      await ctx.db.transaction([
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [revisionKey, String(revisions)] },
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [candidateKey, JSON.stringify({ pages, revisions })] },
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [reviewKey, JSON.stringify({ completed: false, passed: false, issues: [] })] },
      ]);
      continue;
    }

    await saveStoryboard(ctx, chapter.id, pages, { force: forceFull });
    forceFull = false;
    review = pendingIssues ? { pass: false, issues: pendingIssues } : await structuredCall(ctx, {
      step: "storyboard_review", template: "storyboard_review", model: ctx.config.models.storyboard_review, schema: storyboardReviewSchema,
      data: { ...templateData, scenes, storyboard: { pages } },
    });
    pendingIssues = undefined;
    if (review.pass) break;
    if (revisions >= ctx.config.storyboard.max_revisions) {
      ctx.log("warning", `Chapter ${chapter.id}: storyboard review still failed after ${revisions} revisions; continuing with program-valid pages`, review.issues);
      break;
    }
    await ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [reviewKey, JSON.stringify({ completed: false, passed: false, issues: review.issues })]);
    const revised = await structuredCall(ctx, {
      step: "storyboard", template: "storyboard", model: ctx.config.models.storyboard, schema: storyboardSchema,
      data: { ...templateData, scenes, review_issues: review.issues, storyboard: { pages } },
    });
    pages = mergeRevision(pages, revised.pages, review.issues, false);
    revisions++;
    await ctx.db.transaction([
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [revisionKey, String(revisions)] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [candidateKey, JSON.stringify({ pages, revisions })] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [reviewKey, JSON.stringify({ completed: false, passed: false, issues: [] })] },
    ]);
  }

  const finalPages = await ctx.db.all<Page>("SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_no", [chapter.id]);
  await ctx.fs.writeJson(`chapters/${chapter.id}/storyboard.json`, { pages: finalPages.map((page) => JSON.parse(page.storyboard)) });
  await ctx.db.transaction([
    { sql: "UPDATE chapters SET status = 'storyboarded' WHERE id = ?", params: [chapter.id] },
    { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [reviewKey, JSON.stringify({ completed: true, passed: review.pass, issues: review.issues })] },
    { sql: "DELETE FROM meta WHERE key = ?", params: [candidateKey] },
  ]);
  ctx.log("info", `Chapter ${chapter.id}: ${finalPages.length} storyboard pages ready`);
  return { chapter: chapter.id, pages: finalPages.length, passed: review.pass, issues: review.issues, revisions, skipped: false };
}
