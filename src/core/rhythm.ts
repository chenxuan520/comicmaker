import type { Config } from "../../schemas/index.js";
import type { LayoutPlan, StripLayoutName } from "./layoutPlan.js";
import { isStripLayout, STRIP_LAYOUT, type Page, type PageStoryboard } from "./types.js";

export function chapterRhythm(pages: Page[], plan: LayoutPlan | null, rules: Config["storyboard"]) {
  const ordered = [...pages].sort((a, b) => a.page_no - b.page_no);
  const sequence: string[] = [];
  const gapWarnings: number[] = [];
  const flagged: number[] = [];
  let previous = -1, special = 0, used = 0;
  ordered.forEach((page, index) => {
    const layout = (JSON.parse(page.storyboard) as PageStoryboard).layout;
    sequence.push(layout.replace(/^strip-/, ""));
    if (!isStripLayout(layout) || layout === STRIP_LAYOUT) return;
    special++;
    if (previous >= 0 && index - previous - 1 < rules.layout_rules.min_group_gap) gapWarnings.push(page.page_no);
    previous = index;
    if (page.status === "flagged") flagged.push(page.page_no);
    if (plan) used += rules.layouts[layout as StripLayoutName]?.cost ?? 0;
  });
  return { sequence, special, groups: ordered.length, budget_used: used, budget_total: plan?.budget ?? 0, gap_warnings: gapWarnings, flagged };
}

export function formatRhythm(chapter: number, rhythm: ReturnType<typeof chapterRhythm>) {
  return `第${chapter}章  ${rhythm.sequence.join(" ")}  特殊 ${rhythm.special}/${rhythm.groups}  预算 ${rhythm.budget_used}/${rhythm.budget_total}  间隔提示 ${rhythm.gap_warnings.length}  flagged ${rhythm.flagged.length}`;
}
