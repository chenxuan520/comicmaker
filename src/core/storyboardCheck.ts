import type { Config, PageStoryboard, Scene, StoryboardIssue } from "../../schemas/index.js";
import { STRIP_LAYOUT, type Bible, type Ref } from "./types.js";

export function countChineseCharacters(text: string): number {
  return text.match(/[\p{Script=Han}\u3001-\u3003\u3008-\u3011\u3014-\u301b\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f\uff3b\uff3d\uff5b\uff5d\uff61-\uff65\u2014\u2018\u2019\u201c\u201d\u2026\u00b7]/gu)?.length ?? 0;
}

export function validateStoryboard(pages: PageStoryboard[], scenes: Scene[], bible: Bible, lockedRefs: Ref[], config: Config): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  const rules = config.storyboard;
  const characters = new Set(bible.characters.map((character) => character.id));
  const outfits = new Set(bible.outfits.map((outfit) => outfit.id));
  const locations = new Set(bible.locations.map((location) => location.id));
  const locked = new Set(lockedRefs.filter((ref) => ref.status === "locked").map((ref) => `${ref.kind}:${ref.target_id}`));
  const firstPage = pages[0]?.page_no ?? 1;
  const firstPanel = pages[0]?.panels[0]?.id ?? "p1";
  const add = (page: number, panel: string, type: StoryboardIssue["type"], detail: string, fix: string) => {
    issues.push({ page, panel, type, detail, fix });
  };

  if (!pages.length) add(1, "p1", "pacing", "The chapter storyboard is empty", "Generate at least one page for this chapter");
  if (!locked.has("style:project")) add(firstPage, firstPanel, "faithfulness", "The project style reference is not locked", "Lock a project style reference before continuing");

  const pageNumbers = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page.page_no) || page.page_no < 1) {
      add(1, page.panels[0]?.id ?? "p1", "pacing", "Page numbers must be positive integers", "Use consecutive page numbers starting at 1");
    } else if (pageNumbers.has(page.page_no)) {
      add(page.page_no, page.panels[0]?.id ?? "p1", "pacing", `Duplicate page number ${page.page_no}`, "Return exactly one definition for this page number");
    }
    pageNumbers.add(page.page_no);
  }
  for (let pageNo = 1; pageNo <= pages.length; pageNo++) {
    if (!pageNumbers.has(pageNo)) add(pageNo, "p1", "pacing", `Missing page ${pageNo}; page numbers must be consecutive from 1`, `Supply page ${pageNo} without changing the other page numbers`);
  }

  const sceneIds = new Set<string>();
  const beats = new Set<string>();
  for (const scene of scenes) {
    if (sceneIds.has(scene.id)) add(firstPage, firstPanel, "faithfulness", `Duplicate scene ID ${scene.id}`, "Give every scene a unique ID in the adaptation");
    sceneIds.add(scene.id);
    for (const beat of scene.beats) {
      if (beats.has(beat.id)) add(firstPage, firstPanel, "faithfulness", `Duplicate beat ID ${beat.id}`, "Give every beat a unique ID across all scenes");
      beats.add(beat.id);
    }
  }

  const covered = new Map<string, { page: number; panel: string }>();
  const emphasized = new Set<string>();
  for (const page of pages) {
    const panelIds = new Set<string>();
    const pageCharacters = new Set<string>();
    const anchor = page.panels[0]?.id ?? "p1";
    if (rules.format === "strip") {
      if (page.layout !== STRIP_LAYOUT || page.panels.length !== 4 || page.panels.some((panel, index) => panel.row !== index + 1 || panel.size !== "wide")) {
        add(page.page_no, anchor, "pacing", "Vertical strip must have four full-width panels in one column", `Use layout=${STRIP_LAYOUT}, exactly four panels with size=wide, and rows 1, 2, 3, 4 in top-to-bottom order`);
      }
    } else if (page.panels.length < rules.min_panels || page.panels.length > rules.max_panels) {
      add(page.page_no, anchor, "pacing", `Page has ${page.panels.length} panels; allowed range is ${rules.min_panels}-${rules.max_panels}`, "Adjust the panel count to the configured range");
    }
    if (rules.format === "page" && page.layout === STRIP_LAYOUT) add(page.page_no, anchor, "pacing", "Paged format cannot use the vertical strip layout", "Use a paged row layout rather than strip-4, or select storyboard.format=strip");
    for (const panel of page.panels) {
      if (panelIds.has(panel.id)) add(page.page_no, panel.id, "pacing", `Duplicate panel ID ${panel.id}`, "Use unique panel IDs within this page");
      panelIds.add(panel.id);
      if (panel.dialogue.length > rules.max_bubbles_per_panel) {
        add(page.page_no, panel.id, "pacing", `Panel has ${panel.dialogue.length} bubbles; maximum is ${rules.max_bubbles_per_panel}`, "Remove or distribute bubbles across adjacent panels without changing their meaning");
      }
      for (const dialogue of panel.dialogue) {
        const count = countChineseCharacters(dialogue.text);
        if (count > rules.max_bubble_chars) {
          add(page.page_no, panel.id, "pacing", `A bubble has ${count} Chinese characters/punctuation; maximum is ${rules.max_bubble_chars}`, "Shorten or split the bubble without changing its meaning");
        }
        if (dialogue.speaker !== null && !characters.has(dialogue.speaker)) {
          add(page.page_no, panel.id, "faithfulness", `Unknown dialogue speaker ${dialogue.speaker}`, "Use a known character ID, or null for unattributed narration and sound effects");
        }
      }
      if (!locations.has(panel.location_id)) add(page.page_no, panel.id, "faithfulness", `Unknown location ${panel.location_id}`, "Use a location ID from the supplied bible");
      if (!locked.has(`location:${panel.location_id}`)) add(page.page_no, panel.id, "faithfulness", `Location ${panel.location_id} has no locked reference`, "Lock this location reference before continuing");
      const panelCharacters = new Set<string>();
      for (const character of panel.characters) {
        if (panelCharacters.has(character.id)) add(page.page_no, panel.id, "faithfulness", `Duplicate character ID ${character.id} in this panel`, "List each character ID once per panel; describe reflections and unnamed creatures in the action instead of duplicating another character's ID");
        panelCharacters.add(character.id);
        pageCharacters.add(character.id);
        if (!characters.has(character.id)) add(page.page_no, panel.id, "faithfulness", `Unknown character ${character.id}`, "Use a character ID from the supplied bible");
        if (!outfits.has(character.outfit)) add(page.page_no, panel.id, "faithfulness", `Unknown outfit ${character.outfit}`, "Use an outfit ID from the supplied bible");
        if (character.outfit.split(".")[0] !== character.id) add(page.page_no, panel.id, "faithfulness", `Outfit ${character.outfit} does not belong to ${character.id}`, "Use an outfit owned by this character");
        if (!locked.has(`outfit:${character.outfit}`)) add(page.page_no, panel.id, "faithfulness", `Outfit ${character.outfit} has no locked reference`, "Lock this outfit reference before continuing");
      }
      const panelBeats = new Set<string>();
      for (const beatId of panel.beat_ids) {
        if (panelBeats.has(beatId)) add(page.page_no, panel.id, "pacing", `Duplicate beat reference ${beatId} in this panel`, "List each beat ID only once within a panel");
        panelBeats.add(beatId);
        if (!beats.has(beatId)) add(page.page_no, panel.id, "faithfulness", `Unknown beat ${beatId}`, "Use a beat ID defined in the supplied scenes");
        if (!covered.has(beatId)) covered.set(beatId, { page: page.page_no, panel: panel.id });
        if (rules.large_panel_sizes.includes(panel.size) || page.panels.length === 1) emphasized.add(beatId);
      }
    }
    if (pageCharacters.size > rules.max_chars_per_page) {
      add(page.page_no, anchor, "pacing", `Page has ${pageCharacters.size} unique characters; maximum is ${rules.max_chars_per_page}`, "Distribute the characters across pages without omitting important beats");
    }
  }

  for (const scene of scenes) {
    for (const beat of scene.beats) {
      const placement = covered.get(beat.id);
      const page = pages.find((page) => page.panels.some((panel) => panel.location_id === scene.location_id)) ?? pages.at(-1);
      if ((beat.importance >= rules.coverage_min_importance || beat.importance >= rules.emphasis_min_importance) && !placement) {
        add(page?.page_no ?? 1, page?.panels[0]?.id ?? "p1", "omission", `Important beat ${beat.id} is not referenced`, `Include beat ${beat.id} in a panel's beat_ids without inventing new events`);
      } else if (beat.importance >= rules.emphasis_min_importance && placement && !emphasized.has(beat.id)) {
        add(placement.page, placement.panel, "pacing", `Climax beat ${beat.id} has no ${rules.large_panel_sizes.join(" or ")} panel`, `Use size=${rules.large_panel_sizes.join(" or ")}, or a full-page panel within the configured panel-count limits`);
      }
    }
  }
  return issues;
}
