import { getBible, requireLocked } from "./data.js";
import { PreconditionError } from "./errors.js";
import type { ImageInput, TemplateSource } from "./ports.js";
import type { RenderedPrompt } from "./prompts.js";
import type { TextError } from "./review.js";
import { STRIP_LAYOUT, type Context, type PageStoryboard, type Ref } from "./types.js";

export interface PromptReference {
  index: number;
  kind: Ref["kind"];
  target_id: string;
  path: string;
  label: string;
  name: string;
  character_id: string | null;
  outfit_id: string | null;
}

export async function buildPagePrompt(ctx: Context, page: PageStoryboard, corrections = "", textErrors: TextError[] = []): Promise<{ prompt: RenderedPrompt; refs: PromptReference[]; images: ImageInput[] }> {
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
  if (ctx.config.image.ref_strategy !== "none") {
    for (const outfit of ordered) {
      if (selected.length >= ctx.config.image.max_refs) break;
      selected.push(locked.find((ref) => ref.kind === "outfit" && ref.target_id === outfit)!);
    }
    if (ctx.config.image.include_location_ref && locationIds.size === 1 && selected.length < ctx.config.image.max_refs) {
      selected.push(locked.find((ref) => ref.kind === "location" && locationIds.has(ref.target_id))!);
    }
  }
  const refs: PromptReference[] = selected.map((ref, index) => {
    const outfit = ref.kind === "outfit" ? bible.outfits.find((item) => item.id === ref.target_id) : undefined;
    const character = outfit ? bible.characters.find((item) => outfit.id.startsWith(`${item.id}.`)) : undefined;
    const location = ref.kind === "location" ? bible.locations.find((item) => item.id === ref.target_id) : undefined;
    const name = character?.name ?? location?.name ?? ctx.project.title;
    return { index: index + 1, kind: ref.kind, target_id: ref.target_id, path: ref.path!, name, label: outfit ? `${name} (${character!.id}), ${outfit.name} (${outfit.id})` : name, character_id: character?.id ?? null, outfit_id: outfit?.id ?? null };
  });
  const characters = ordered.map((outfitId) => {
    const outfit = bible.outfits.find((item) => item.id === outfitId);
    const character = bible.characters.find((item) => outfitId.startsWith(`${item.id}.`));
    if (!outfit || !character) throw new PreconditionError(`Missing character setting for ${outfitId}`);
    return { ...character, outfit };
  });
  const location = locationIds.size === 1 ? bible.locations.find((item) => locationIds.has(item.id)) ?? null : null;
  const isStrip = page.layout === STRIP_LAYOUT;
  const data = {
    page, refs, characters, location, corrections, text_errors: textErrors,
    reading_order_description: isStrip ? `top to bottom, one panel per row; bubbles ${ctx.config.storyboard.reading_order === "rtl" ? "right to left" : "left to right"}` : ctx.config.storyboard.reading_order === "rtl" ? "right to left, top to bottom" : "left to right, top to bottom",
  };
  const sections: string[] = [];
  const sources: Record<string, TemplateSource> = {};
  for (const section of ctx.config.prompts.image_sections) {
    const panels = section === "panels" ? page.panels : [null];
    for (let index = 0; index < panels.length; index++) {
      const rawPanel = panels[index];
      const panel = rawPanel ? {
        ...rawPanel,
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
  const images = await Promise.all(refs.map(async (ref) => ({ data: (await ctx.fs.readBytes(ref.path))!, name: `${ref.target_id}.png`, label: ref.label })));
  return { prompt: { text: sections.join("\n\n"), sources }, refs, images };
}
