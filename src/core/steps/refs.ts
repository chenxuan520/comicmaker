import { ulid } from "ulid";
import { getBible, requireLocked } from "../data.js";
import { PreconditionError } from "../errors.js";
import { generateImage, recoverPendingImages } from "../image.js";
import { isRefusal } from "../calls.js";
import type { ImageInput } from "../ports.js";
import type { Context, Ref } from "../types.js";

export async function generateRefs(ctx: Context, options: { kind: Ref["kind"]; target?: string; force?: boolean }) {
  const bible = await getBible(ctx);
  if (options.kind !== "style") {
    if (!await ctx.db.get("SELECT value FROM meta WHERE key = 'prepare.extract.completed'")) throw new PreconditionError("Prepare the novel before generating character or location references");
    await requireLocked(ctx, [], []);
  }
  const allTargets = options.kind === "style" ? ["project"] : options.kind === "outfit" ? bible.outfits.map((outfit) => outfit.id) : bible.locations.map((location) => location.id);
  if (options.target && !allTargets.includes(options.target)) throw new PreconditionError(`Unknown ${options.kind} target ${options.target}`);
  const targets = options.target ? [options.target] : allTargets;
  const generated: Ref[] = [];
  const unfinished = await ctx.db.all<Ref>("SELECT * FROM refs WHERE kind = ? AND status = 'candidate' AND path IS NULL", [options.kind]);
  for (const ref of unfinished.filter((item) => targets.includes(item.target_id))) {
    await recoverPendingImages(ctx, undefined, ref.id);
    const attempt = await ctx.db.get<{ path: string; sha256: string }>("SELECT path, sha256 FROM attempts WHERE ref_id = ? AND status = 'ok' ORDER BY seq DESC LIMIT 1", [ref.id]);
    if (attempt) {
      await ctx.db.run("UPDATE refs SET path = ?, sha256 = ? WHERE id = ?", [attempt.path, attempt.sha256, ref.id]);
      generated.push((await ctx.db.get<Ref>("SELECT * FROM refs WHERE id = ?", [ref.id]))!);
    }
  }
  const style = options.kind !== "style" ? await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = 'style' AND target_id = 'project' AND status = 'locked'") : undefined;
  const images: ImageInput[] = style?.path ? [{ data: (await ctx.fs.readBytes(style.path))!, name: `${style.id}.png`, label: "Art style" }] : [];
  for (const target of targets) {
    if (!options.force && await ctx.db.get("SELECT id FROM refs WHERE kind = ? AND target_id = ? AND status = 'locked'", [options.kind, target])) continue;
    const count = await ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM refs WHERE kind = ? AND target_id = ? AND status = 'candidate' AND path IS NOT NULL", [options.kind, target]);
    const needed = options.force ? ctx.config.refs.candidates : Math.max(0, ctx.config.refs.candidates - count!.count);
    const outfit = options.kind === "outfit" ? bible.outfits.find((item) => item.id === target)! : null;
    const character = outfit ? bible.characters.find((item) => outfit.id.startsWith(`${item.id}.`))! : null;
    const location = options.kind === "location" ? bible.locations.find((item) => item.id === target)! : null;
    const template = options.kind === "style" ? "refs/style_sample.md" : options.kind === "outfit" ? "refs/character_sheet.md" : "refs/location.md";
    const prompt = await ctx.prompts.render(template, { character, outfit, location });
    for (let index = 0; index < needed; index++) {
      const id = ulid();
      const path = options.kind === "style" ? `refs/style/${id}.png` : options.kind === "outfit" ? `refs/characters/${character!.id}/${target}/${id}.png` : `refs/locations/${target}/${id}.png`;
      await ctx.db.run("INSERT INTO refs (id, kind, target_id, prompt, status) VALUES (?, ?, ?, ?, 'candidate')", [id, options.kind, target, prompt.text]);
      try {
        const attempt = await generateImage(ctx, { refId: id, prompt, images, refPaths: style?.path ? [style.path] : [], path: () => path });
        await ctx.db.run("UPDATE refs SET path = ?, sha256 = ? WHERE id = ?", [attempt.path, attempt.sha256, id]);
        generated.push((await ctx.db.get<Ref>("SELECT * FROM refs WHERE id = ?", [id]))!);
      } catch (error) {
        if (isRefusal(error)) await ctx.db.run("UPDATE refs SET status = 'rejected' WHERE id = ?", [id]);
        throw error;
      }
    }
  }
  return { refs: generated };
}

export async function lockRef(ctx: Context, id: string) {
  const ref = await ctx.db.get<Ref>("SELECT * FROM refs WHERE id = ?", [id]);
  if (!ref?.path || !await ctx.fs.readBytes(ref.path)) throw new PreconditionError("Reference image not found");
  if (ref.status === "locked") return { ref, skipped: true };
  if (ref.status !== "candidate") throw new PreconditionError("Only candidate references can be locked");
  const existing = await ctx.db.get<Ref>("SELECT * FROM refs WHERE kind = ? AND target_id = ? AND status = 'locked'", [ref.kind, ref.target_id]);
  if (existing) throw new PreconditionError("This target already has a locked reference; locked references cannot be replaced", { ref_id: existing.id });
  await ctx.db.transaction([
    { sql: "UPDATE refs SET status = 'rejected' WHERE kind = ? AND target_id = ? AND status = 'candidate' AND id <> ?", params: [ref.kind, ref.target_id, id] },
    { sql: "UPDATE refs SET status = 'locked' WHERE id = ?", params: [id] },
  ]);
  ctx.log("info", `Locked ${ref.kind} reference for ${ref.target_id}`);
  return { ref: { ...ref, status: "locked" as const }, skipped: false };
}
