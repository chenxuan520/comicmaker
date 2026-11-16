import { ulid } from "ulid";
import { getBible, chapterData } from "../data.js";
import { PreconditionError } from "../errors.js";
import { generateImage, recoverPendingImages, sha256 } from "../image.js";
import type { ImageInput } from "../ports.js";
import type { Chapter, Context, Ref } from "../types.js";

async function coverTarget(ctx: Context) {
  const version = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'cover.source_version'");
  return JSON.stringify([version?.value ?? "project", ctx.project.title]);
}

export async function getCover(ctx: Context): Promise<Ref | null> {
  return await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = 'cover' AND target_id = ? AND path IS NOT NULL AND status != 'rejected' ORDER BY id DESC LIMIT 1", [await coverTarget(ctx)]) ?? null;
}

export async function coverRetryRequired(ctx: Context) {
  return Boolean(await ctx.db.get("SELECT r.id FROM refs r JOIN attempts a ON a.ref_id = r.id WHERE r.kind = 'cover' AND r.target_id = ? AND r.path IS NULL LIMIT 1", [await coverTarget(ctx)]));
}

export async function generateCover(ctx: Context, options: { force?: boolean } = {}) {
  if (!ctx.config.cover.enabled) return { cover: null, skipped: true };
  const existing = await getCover(ctx);
  if (existing && !options.force) {
    const bytes = await ctx.fs.readBytes(existing.path!);
    if (!bytes || await sha256(bytes) !== existing.sha256) throw new PreconditionError("Saved cover image is missing or changed; restore the original before continuing");
    return { cover: existing, skipped: true };
  }
  const target = await coverTarget(ctx);
  let unfinished = await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = 'cover' AND target_id = ? AND path IS NULL ORDER BY id DESC LIMIT 1", [target]);
  if (unfinished) {
    await recoverPendingImages(ctx, undefined, unfinished.id);
    const attempt = await ctx.db.get<{ path: string; sha256: string }>("SELECT path, sha256 FROM attempts WHERE ref_id = ? AND status = 'ok' ORDER BY seq DESC LIMIT 1", [unfinished.id]);
    if (attempt) {
      await ctx.db.run("UPDATE refs SET path = ?, sha256 = ? WHERE id = ?", [attempt.path, attempt.sha256, unfinished.id]);
      return { cover: (await getCover(ctx))!, skipped: true };
    }
    if (await ctx.db.get("SELECT id FROM attempts WHERE ref_id = ? LIMIT 1", [unfinished.id])) {
      if (!options.force) throw new PreconditionError("A cover request failed; check its retained fees and restore any saved image before explicitly retrying with --force");
      unfinished = undefined;
    }
  }
  const chapter = await ctx.db.get<Chapter>("SELECT * FROM chapters ORDER BY idx LIMIT 1");
  if (!chapter) throw new PreconditionError("Import a novel before generating its cover");
  const style = await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = 'style' AND target_id = 'project' AND status = 'locked'");
  if (!style?.path) throw new PreconditionError("Lock the book art style before generating its cover");
  const bytes = await ctx.fs.readBytes(style.path);
  if (!bytes || await sha256(bytes) !== style.sha256) throw new PreconditionError("Locked book art style image is missing or changed");
  const images: ImageInput[] = [{ data: bytes, name: "style.png", label: "Book art style; do not copy its sample characters or panels" }];
  const refPaths = [style.path];
  const extracted = await ctx.db.get("SELECT value FROM meta WHERE key = 'prepare.extract.completed' AND value = 'true'");
  const bible = extracted ? await getBible(ctx) : { characters: [], outfits: [], locations: [] };
  const characters = bible.characters.filter((character) => character.evidence.some((source) => source.startsWith(`${chapter.idx}:`))).map((character) => ({ ...character, outfits: character.outfits.filter((outfit) => !outfit.chapters.length || outfit.chapters.includes(chapter.idx)) }));
  const primary = characters.find((character) => character.role?.includes("主角")) ?? characters[0];
  const outfit = primary?.outfits.find((item) => !item.chapters.length || item.chapters.includes(chapter.idx));
  const portrait = outfit && ctx.config.image.max_refs > 1 ? await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = 'outfit' AND target_id = ? AND status = 'locked'", [outfit.id]) : undefined;
  if (portrait?.path) {
    const data = await ctx.fs.readBytes(portrait.path);
    if (!data || await sha256(data) !== portrait.sha256) throw new PreconditionError("Initial character reference is missing or changed");
    images.push({ data, name: "character.png", label: "Initial character appearance" });
    refPaths.push(portrait.path);
  }
  const prompt = await ctx.prompts.render("cover.md", { chapter: chapterData(chapter), characters });
  const id = unfinished?.id ?? ulid();
  if (unfinished) await ctx.db.run("UPDATE refs SET prompt = ? WHERE id = ?", [prompt.text, id]);
  else await ctx.db.run("INSERT INTO refs (id, kind, target_id, prompt, status) VALUES (?, 'cover', ?, ?, 'candidate')", [id, target, prompt.text]);
  const attempt = await generateImage(ctx, { refId: id, prompt, images, refPaths, path: () => `refs/cover/${id}.png` });
  await ctx.db.run("UPDATE refs SET path = ?, sha256 = ? WHERE id = ?", [attempt.path, attempt.sha256, id]);
  return { cover: (await getCover(ctx))!, skipped: false };
}
