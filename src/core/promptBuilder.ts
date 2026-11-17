import { getBible, requireLocked } from "./data.js";
import { PreconditionError } from "./errors.js";
import { sha256 } from "./image.js";
import { layoutRows } from "./layoutPlan.js";
import type { Scene } from "../../schemas/index.js";
import type { ImageInput, TemplateSource } from "./ports.js";
import type { RenderedPrompt } from "./prompts.js";
import type { TextError } from "./review.js";
import { isStripLayout, STRIP_LAYOUT, type Context, type PageStoryboard, type Page, type Ref } from "./types.js";

export interface PromptReference {
  index: number;
  kind: Ref["kind"] | "continuity";
  target_id: string;
  path: string;
  label: string;
  name: string;
  character_id: string | null;
  outfit_id: string | null;
  sha256?: string | null;
}

function boundaryScene(page: PageStoryboard, scenes: Scene[], fromEnd: boolean) {
  const panels = fromEnd ? [...page.panels].reverse() : page.panels;
  for (const panel of panels) {
    if (panel.location_id !== panels[0].location_id || panel.time !== panels[0].time) return null;
    const matching = scenes.filter((scene) => scene.beats.some((beat) => panel.beat_ids.includes(beat.id)));
    if (matching.length > 1) return null;
    if (matching.length === 1) return matching[0].id;
  }
  return null;
}

async function previousSceneReference(ctx: Context, page: PageStoryboard, chapterId?: string): Promise<Omit<PromptReference, "index"> | null> {
  if (!chapterId) throw new PreconditionError("Scene continuity needs the page's chapter ID");
  const previous = await ctx.db.get<Page>("SELECT * FROM pages WHERE chapter_id = ? AND page_no = ?", [chapterId, page.page_no - 1]);
  if (!previous?.final_attempt_id || !["passed", "exported"].includes(previous.status)) return null;
  const adaptation = await ctx.db.get<{ scenes: string }>("SELECT scenes FROM adaptations WHERE chapter_id = ?", [chapterId]);
  if (!adaptation) return null;
  const scenes = JSON.parse(adaptation.scenes) as Scene[];
  const previousPage = JSON.parse(previous.storyboard) as PageStoryboard;
  const currentScene = boundaryScene(page, scenes, false);
  if (!currentScene || currentScene !== boundaryScene(previousPage, scenes, true)) return null;
  const before = previousPage.panels.at(-1)!, after = page.panels[0];
  if (before.location_id !== after.location_id || before.time !== after.time || after.characters.some((character) => before.characters.some((old) => old.id === character.id && old.outfit !== character.outfit))) return null;
  const attempt = await ctx.db.get<{ path: string; sha256: string }>("SELECT a.path, a.sha256 FROM attempts a JOIN reviews r ON r.attempt_id = a.id JOIN meta m ON m.key = 'review.visual.' || a.id WHERE a.id = ? AND a.page_id = ? AND a.status = 'ok' AND r.passed = 1", [previous.final_attempt_id, previous.id]);
  if (!attempt?.path) return null;
  return { kind: "continuity", target_id: previous.id, path: attempt.path, sha256: attempt.sha256, label: `Previous strip ${previous.id}; only its last panel is the continuing scene`, name: previous.id, character_id: null, outfit_id: null };
}

export async function buildPagePrompt(ctx: Context, page: PageStoryboard, corrections = "", textErrors: TextError[] = [], chapterId?: string): Promise<{ prompt: RenderedPrompt; refs: PromptReference[]; images: ImageInput[] }> {
  const bible = await getBible(ctx);
  const appearances = new Map<string, number>();
  const locationIds = new Set(page.panels.map((panel) => panel.location_id));
  for (const panel of page.panels) for (const character of panel.characters) appearances.set(character.outfit, (appearances.get(character.outfit) ?? 0) + 1);
  await requireLocked(ctx, [...appearances.keys()], [...locationIds]);
  const locked = await ctx.db.all<Ref>("SELECT * FROM refs WHERE status = 'locked'");
  const selected: Ref[] = [];
  if (ctx.config.image.include_style_ref) selected.push(locked.find((ref) => ref.kind === "style")!);
  const ordered = [...appearances.keys()];
  if (ctx.config.image.ref_strategy === "by_frequency") ordered.sort((a, b) => appearances.get(b)! - appearances.get(a)!);
  const previous = ctx.config.image.scene_continuity ? await previousSceneReference(ctx, page, chapterId) : null;
  if (ctx.config.image.scene_continuity) {
    if (!ctx.config.image.include_location_ref) throw new PreconditionError("Scene continuity requires image.include_location_ref=true");
    for (const id of locationIds) selected.push(locked.find((ref) => ref.kind === "location" && ref.target_id === id)!);
    const required = selected.length + (ctx.config.image.ref_strategy === "none" ? 0 : ordered.length) + Number(Boolean(previous));
    if (required > ctx.config.image.max_refs) throw new PreconditionError(`Scene continuity needs image.max_refs >= ${required} to preserve character, location and previous-strip references`);
  }
  if (ctx.config.image.ref_strategy !== "none") {
    for (const outfit of ordered) {
      if (selected.length >= ctx.config.image.max_refs) break;
      selected.push(locked.find((ref) => ref.kind === "outfit" && ref.target_id === outfit)!);
    }
    if (!ctx.config.image.scene_continuity && ctx.config.image.include_location_ref && locationIds.size === 1 && selected.length < ctx.config.image.max_refs) {
      selected.push(locked.find((ref) => ref.kind === "location" && locationIds.has(ref.target_id))!);
    }
  }
  const refs: PromptReference[] = selected.map((ref, index) => {
    const outfit = ref.kind === "outfit" ? bible.outfits.find((item) => item.id === ref.target_id) : undefined;
    const character = outfit ? bible.characters.find((item) => outfit.id.startsWith(`${item.id}.`)) : undefined;
    const location = ref.kind === "location" ? bible.locations.find((item) => item.id === ref.target_id) : undefined;
    const name = character?.name ?? location?.name ?? ctx.project.title;
    return { index: index + 1, kind: ref.kind, target_id: ref.target_id, path: ref.path!, name, label: outfit ? `${name} (${character!.id}), ${outfit.name} (${outfit.id})` : name, character_id: character?.id ?? null, outfit_id: outfit?.id ?? null, ...(ctx.config.image.scene_continuity ? { sha256: ref.sha256 } : {}) };
  });
  const continuity = previous ? { ...previous, index: refs.length + 1 } : null;
  if (continuity) refs.push(continuity);
  const characters = ordered.map((outfitId) => {
    const outfit = bible.outfits.find((item) => item.id === outfitId);
    const character = bible.characters.find((item) => outfitId.startsWith(`${item.id}.`));
    if (!outfit || !character) throw new PreconditionError(`Missing character setting for ${outfitId}`);
    return { ...character, outfit };
  });
  const location = locationIds.size === 1 ? bible.locations.find((item) => locationIds.has(item.id)) ?? null : null;
  const isStrip = isStripLayout(page.layout);
  const rows = layoutRows(page, ctx.config.storyboard);
  const data = {
    page, refs, characters, location, corrections, text_errors: textErrors,
    variable_strip: isStrip && page.layout !== STRIP_LAYOUT, layout_rows: rows, continuity_reference: continuity,
    reading_order_description: isStrip ? `top to bottom, one panel per row; bubbles ${ctx.config.storyboard.reading_order === "rtl" ? "right to left" : "left to right"}` : ctx.config.storyboard.reading_order === "rtl" ? "right to left, top to bottom" : "left to right, top to bottom",
  };
  const sections: string[] = [];
  const sources: Record<string, TemplateSource> = {};
  for (const section of ctx.config.prompts.image_sections) {
    const panels = section === "panels" ? page.panels : [null];
    for (let index = 0; index < panels.length; index++) {
      const rawPanel = panels[index];
      const panel = rawPanel ? {
        ...rawPanel, is_hero: rows[index]?.hero ?? false,
        location: bible.locations.find((item) => item.id === rawPanel.location_id) ?? null,
        characters: rawPanel.characters.map((item) => ({ ...item, name: bible.characters.find((character) => character.id === item.id)?.name ?? item.id, outfit_id: item.outfit, outfit: bible.outfits.find((outfit) => outfit.id === item.outfit) ?? null })),
        dialogue: rawPanel.dialogue.map((item) => ({
          ...item, speaker_name: bible.characters.find((character) => character.id === item.speaker)?.name ?? item.speaker,
          is_speech: item.type === "speech", is_thought: item.type === "thought", is_narration: item.type === "narration", is_sfx: item.type === "sfx",
        })),
      } : null;
      const rendered = await ctx.prompts.render(`image/${section === "panels" ? "panel" : section}.md`, { ...data, panel, panel_index: index + 1 });
      if (rendered.text) sections.push(rendered.text);
      Object.assign(sources, rendered.sources);
    }
  }
  const images = await Promise.all(refs.map(async (ref) => {
    const data = await ctx.fs.readBytes(ref.path);
    if (ctx.config.image.scene_continuity && (!data || await sha256(data) !== ref.sha256)) throw new PreconditionError(`Continuity reference original is missing or changed: ${ref.path}`);
    return { data: data!, name: `${ref.target_id}.png`, label: ref.label };
  }));
  return { prompt: { text: sections.join("\n\n"), sources }, refs, images };
}
