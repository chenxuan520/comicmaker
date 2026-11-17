import type { Config, Scene, PageStoryboard } from "../../schemas/index.js";

export type StripLayoutName = keyof Config["storyboard"]["layouts"];
export interface LayoutPlanItem { beat_id: string; layout: StripLayoutName }
export interface LayoutPlan {
  budget: number;
  budget_tier: "daily" | "action" | "climax";
  top_moments: string[];
  items: LayoutPlanItem[];
  skipped: { beat_id: string; reason: "budget" | "min_beat_gap" | "dialogue" | "splash_limit" | "unknown_beat" }[];
}

export const stripPanelSizes: Record<StripLayoutName, PageStoryboard["panels"][number]["size"][]> = {
  "strip-4": ["wide", "wide", "wide", "wide"],
  "strip-3a": ["large", "wide", "wide"],
  "strip-3b": ["wide", "wide", "large"],
  "strip-2": ["large", "wide"],
  "strip-1": ["splash"],
};

export function layoutPlanData(plan: LayoutPlan | null, rules: Config["storyboard"]) {
  return (plan?.items ?? []).map((item) => ({ ...item, panel_count: rules.layouts[item.layout]!.rows.length, hero: rules.layouts[item.layout]!.hero, sizes: stripPanelSizes[item.layout] }));
}

export function planLayouts(scenes: Scene[], topMoments: string[], rules: Config["storyboard"]): LayoutPlan {
  const beats = scenes.flatMap((scene) => scene.beats);
  const candidates = [...new Set(topMoments)].slice(0, rules.layout_rules.max_candidates);
  const positions = new Map(beats.map((beat, index) => [beat.id, { beat, index }]));
  const plan: LayoutPlan = { budget: 0, budget_tier: "daily", top_moments: [...topMoments], items: [], skipped: [] };
  if (rules.format !== "strip" || rules.layout_mode !== "budget" || !beats.some((beat) => beat.beat_type != null)) return plan;
  const types = candidates.map((id) => positions.get(id)?.beat.beat_type);
  plan.budget_tier = types.includes("climax") ? "climax" : types.includes("action") ? "action" : "daily";
  plan.budget = rules.layout_budget[plan.budget_tier];
  let remaining = plan.budget;
  let splashes = 0;
  const selected: number[] = [];
  for (const id of candidates) {
    const entry = positions.get(id);
    let reason: LayoutPlan["skipped"][number]["reason"] | undefined;
    if (!entry) reason = "unknown_beat";
    else if (remaining === 0) reason = "budget";
    else if (entry.beat.dialogue.length > rules.layout_rules.max_hero_dialogue) reason = "dialogue";
    else if (selected.some((index) => Math.abs(index - entry.index) < rules.layout_rules.min_beat_gap)) reason = "min_beat_gap";
    if (reason) {
      plan.skipped.push({ beat_id: id, reason });
      continue;
    }
    const preferences: StripLayoutName[] = entry!.beat.beat_type === "climax" ? ["strip-1", "strip-2", "strip-3b"]
      : entry!.beat.beat_type === "action" ? ["strip-2", "strip-3b"]
      : entry!.beat.beat_type === "establishing" ? ["strip-3a"] : ["strip-3b"];
    const blocked = new Set<"budget" | "splash_limit">();
    const layout = preferences.find((name) => {
      const definition = rules.layouts[name];
      if (!definition) return false;
      if (definition.cost > remaining) { blocked.add("budget"); return false; }
      if (name === "strip-1" && splashes >= rules.layout_rules.max_splash_per_chapter) { blocked.add("splash_limit"); return false; }
      return true;
    });
    if (!layout) {
      plan.skipped.push({ beat_id: id, reason: blocked.size === 1 && blocked.has("splash_limit") ? "splash_limit" : "budget" });
      continue;
    }
    plan.items.push({ beat_id: id, layout });
    remaining -= rules.layouts[layout]!.cost;
    selected.push(entry!.index);
    if (layout === "strip-1") splashes++;
  }
  plan.items.sort((a, b) => positions.get(a.beat_id)!.index - positions.get(b.beat_id)!.index);
  return plan;
}
