import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { parse } from "yaml";
import { adaptationSchema, adaptationLlmSchema, configSchema, sceneSchema, storyboardSchema, type Config, type Scene } from "../schemas/index.js";
import { createProject, importNovel } from "../src/core/project.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { adaptChapter, saveStoryboard } from "../src/core/steps/adapt.js";
import { getLayoutPlan } from "../src/core/data.js";
import { planLayouts, stripPanelSizes, type LayoutPlan, type StripLayoutName } from "../src/core/layoutPlan.js";
import { validateStoryboard } from "../src/core/storyboardCheck.js";
import type { Bible, Ref } from "../src/core/types.js";
import { renderStepPrompt } from "../src/core/pipeline.js";
import { buildPagePrompt } from "../src/core/promptBuilder.js";
import { renderChapter, renderPage } from "../src/core/steps/render.js";
import { isStripLayout } from "../src/core/types.js";
import { adaptation, extraction, fixture, mockOutput, MockAi, novel, png, storyboard } from "./helpers.js";

const defaults = configSchema.parse(parse(await readFile(new URL("../config.default.yaml", import.meta.url), "utf8")));

function budgetRules(overrides: Partial<Config["storyboard"]> = {}) {
  return configSchema.parse({ ...defaults, storyboard: { ...defaults.storyboard, format: "strip", layout_mode: "budget", ...overrides } }).storyboard;
}

function beats(count = 40): Scene[] {
  return [{ ...structuredClone(adaptation.scenes[0]), beats: Array.from({ length: count }, (_, index) => ({ ...structuredClone(adaptation.scenes[0].beats[0]), id: `b${index + 1}`, importance: 1, beat_type: "reaction", dialogue: [] })) }];
}

function plannedPage(layout: StripLayoutName, pageNo: number, beatId?: string) {
  const page = storyboardSchema.parse({ pages: [{ page_no: pageNo, layout, panels: stripPanelSizes[layout].map((size, index) => ({ ...structuredClone(storyboard.panels[0]), id: `p${index + 1}`, row: index + 1, size, shot: ["远景", "近景", "特写", "中景"][index], dialogue: [], beat_ids: [] })) }] }).pages[0];
  const hero = defaults.storyboard.layouts[layout]!.hero;
  if (beatId && hero) page.panels[hero - 1].beat_ids = [beatId];
  return page;
}

function checkLayouts(pages: ReturnType<typeof plannedPage>[], scenes: Scene[], plan: LayoutPlan, rules = budgetRules()) {
  const bible: Bible = { ...extraction, outfits: extraction.characters.flatMap((character) => character.outfits) };
  const refs = [{ kind: "style", target_id: "project", status: "locked" }, ...bible.outfits.map((item) => ({ kind: "outfit", target_id: item.id, status: "locked" })), ...bible.locations.map((item) => ({ kind: "location", target_id: item.id, status: "locked" }))] as Ref[];
  return validateStoryboard(pages, scenes, bible, refs, { ...defaults, storyboard: rules }, plan);
}

async function preparedFixture(t: TestContext, ai = new MockAi()) {
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "青岚纪");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  ctx.config.refs.candidates = 1;
  await importNovel(ctx, new TextEncoder().encode(novel));
  await prepareBook(ctx);
  for (const kind of ["style", "outfit", "location"] as const) {
    const refs = await generateRefs(ctx, { kind });
    for (const ref of refs.refs) await lockRef(ctx, ref.id);
  }
  return { ...f, ctx, ai };
}

function fourPanelPage() {
  return storyboardSchema.parse({ pages: [{ ...storyboard, layout: "strip-4", panels: Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(storyboard.panels[Math.min(index, 2)]), id: `p${index + 1}`, row: index + 1, size: "wide" })) }] }).pages[0];
}

async function continuityFixture(t: TestContext, ai = new MockAi()) {
  const f = await preparedFixture(t, ai);
  f.ctx.config.image.scene_continuity = true;
  f.ctx.config.image.max_refs = 4;
  f.ctx.config.storyboard.format = "strip";
  const structured = ai.onStructured;
  ai.onStructured = (request) => {
    if (request.schema_name === "review_text") return { panels: fourPanelPage().panels.map((panel, index) => ({ panel: index + 1, texts: panel.dialogue.map((line) => line.text) })) };
    if (request.schema_name === "review_visual") return { panel_count: 4, characters: Array.from({ length: 4 }, (_, index) => ({ panel: index + 1, char_id: "lin_qing", identity_match: 0.95, color_match: 0.95, issue: null })), content: [], artifacts: [], fix_instructions: "" };
    return structured ? structured(request) : mockOutput(request);
  };
  const scenes = structuredClone(adaptation.scenes);
  scenes.push({ ...structuredClone(scenes[0]), id: "s2", beats: scenes[0].beats.map((beat, index) => ({ ...beat, id: `b${index + 4}` })) });
  const pages = [fourPanelPage(), { ...fourPanelPage(), page_no: 2 }, { ...fourPanelPage(), page_no: 3 }];
  for (const panel of pages[2].panels) panel.beat_ids = panel.beat_ids.map((id) => `b${Number(id.slice(1)) + 3}`);
  await f.ctx.db.run("INSERT INTO adaptations (chapter_id,scenes,version) VALUES ('001',?,1)", [JSON.stringify(scenes)]);
  await saveStoryboard(f.ctx, "001", pages);
  await f.ctx.db.run("INSERT OR REPLACE INTO meta (key,value) VALUES ('storyboard.review.001',?)", [JSON.stringify({ completed: true, passed: true, issues: [] })]);
  return { ...f, pages };
}

for (const format of ["page", "strip"] as const) {
  test(`fixed ${format} adapt, storyboard and image prompts match the main baseline byte for byte`, async (t) => {
    const f = await preparedFixture(t);
    f.ctx.config.storyboard.format = format;
    await f.ctx.db.run("INSERT INTO adaptations (chapter_id, scenes, version) VALUES (?, ?, 1)", ["001", JSON.stringify(adaptation.scenes)]);
    await saveStoryboard(f.ctx, "001", [format === "page" ? structuredClone(storyboard) : fourPanelPage()]);
    const adapt = await renderStepPrompt(f.ctx, "adapt", { chapter: 1 }) as { system: string; user: string };
    const boards = await renderStepPrompt(f.ctx, "storyboard", { chapter: 1 }) as { system: string; user: string };
    const image = await renderStepPrompt(f.ctx, "image", { page: "001-p01" }) as { prompt: { text: string } };
    const snapshots = JSON.parse(await readFile(new URL("./fixtures/fixed-layout-prompts.json", import.meta.url), "utf8"));
    assert.deepEqual({ adapt: { system: adapt.system, user: adapt.user }, storyboard: { system: boards.system, user: boards.user }, image: image.prompt.text }, snapshots[format]);
  });
}

test("strip layout config defaults are fixed and reject invalid proportions, heroes, costs and names", async (t) => {
  const f = await preparedFixture(t), config = f.ctx.config;
  assert.equal(config.storyboard.layout_mode, "fixed");
  assert.deepEqual(config.storyboard.layouts["strip-2"], { rows: [65, 35], hero: 1, cost: 2 });
  assert.deepEqual(config.storyboard.layout_budget, { daily: 1, action: 2, climax: 4 });
  for (const change of [
    { "strip-4": { rows: [25, 25, 25, 25], hero: 1, cost: 0 } },
    { "strip-4": { rows: [25, 25, 25, 25], hero: null, cost: 1 } },
    { "strip-2": { rows: [65, 30], hero: 1, cost: 2 } },
    { "strip-2": { rows: [65, 35], hero: 3, cost: 2 } },
    { "strip-2": { rows: [65, 35], hero: 1, cost: -1 } },
    { "strip-3c": { rows: [50, 50], hero: 1, cost: 1 } },
  ]) assert.equal(configSchema.safeParse({ ...config, storyboard: { ...config.storyboard, layouts: { ...config.storyboard.layouts, ...change } } }).success, false);
  const noFixed = structuredClone(config);
  delete (noFixed.storyboard.layouts as Record<string, unknown>)["strip-4"];
  assert.equal(configSchema.safeParse(noFixed).success, false);
});

test("old untagged adaptations parse and fixed LLM schemas do not gain optional beat fields", () => {
  assert.deepEqual(adaptationSchema.parse(adaptation), adaptation);
  assert.deepEqual(sceneSchema.parse(adaptation.scenes[0]), adaptation.scenes[0]);
  const fixed = zodResponseFormat(adaptationSchema, "adapt").json_schema.schema;
  const budget = zodResponseFormat(adaptationLlmSchema, "adapt").json_schema.schema;
  assert.doesNotMatch(JSON.stringify(fixed), /beat_type|top_moments/);
  assert.match(JSON.stringify(budget), /beat_type/);
  assert.match(JSON.stringify(budget), /top_moments/);
  assert.equal(adaptationLlmSchema.safeParse(adaptation).success, false);
  assert.equal(storyboardSchema.safeParse({ pages: [{ ...storyboard, panels: [{ ...storyboard.panels[0], size: "splash" }] }] }).success, true);
});

test("layout allocation follows the ranked climax example and returns items in source order", () => {
  const scenes = beats();
  scenes[0].beats[29].beat_type = "climax";
  scenes[0].beats[29].dialogue = [{ speaker: null, type: "narration", text: "来了。" }];
  scenes[0].beats[27].beat_type = "action";
  scenes[0].beats[4].beat_type = "establishing";
  scenes[0].beats[11].beat_type = "dialogue";
  scenes[0].beats[11].dialogue = Array.from({ length: 4 }, () => ({ speaker: null, type: "narration" as const, text: "来了。" }));
  const plan = planLayouts(scenes, ["b30", "b28", "b5", "b12", "b20"], budgetRules());
  assert.equal(plan.budget_tier, "climax");
  assert.equal(plan.budget, 4);
  assert.deepEqual(plan.items, [{ beat_id: "b5", layout: "strip-3a" }, { beat_id: "b30", layout: "strip-1" }]);
  assert.deepEqual(plan.skipped, [{ beat_id: "b28", reason: "min_beat_gap" }, { beat_id: "b12", reason: "budget" }, { beat_id: "b20", reason: "budget" }]);
});

test("daily and action budgets allocate only their affordable leading layout", () => {
  const scenes = beats();
  scenes[0].beats[0].beat_type = "dialogue";
  scenes[0].beats[0].dialogue = [{ speaker: null, type: "narration", text: "早。" }];
  const daily = planLayouts(scenes, ["b1", "b20"], budgetRules());
  assert.equal(daily.budget_tier, "daily");
  assert.equal(daily.budget, 1);
  assert.deepEqual(daily.items, [{ beat_id: "b1", layout: "strip-3b" }]);
  assert.deepEqual(daily.skipped, [{ beat_id: "b20", reason: "budget" }]);
  scenes[0].beats[0].beat_type = "action";
  const action = planLayouts(scenes, ["b1", "b20"], budgetRules());
  assert.equal(action.budget_tier, "action");
  assert.equal(action.budget, 2);
  assert.deepEqual(action.items, [{ beat_id: "b1", layout: "strip-2" }]);
});

test("splash caps and unaffordable splashes fall back without altering beat rankings", () => {
  const scenes = beats();
  scenes[0].beats[0].beat_type = scenes[0].beats[19].beat_type = "climax";
  const rules = budgetRules({ layout_budget: { daily: 1, action: 2, climax: 5 } });
  assert.deepEqual(planLayouts(scenes, ["b1", "b20"], rules).items, [{ beat_id: "b1", layout: "strip-1" }, { beat_id: "b20", layout: "strip-2" }]);
  rules.layouts["strip-1"]!.cost = 99;
  assert.deepEqual(planLayouts(scenes, ["b1"], rules).items, [{ beat_id: "b1", layout: "strip-2" }]);
  rules.layouts = { "strip-4": rules.layouts["strip-4"], "strip-1": { rows: [100], hero: 1, cost: 1 } };
  assert.deepEqual(planLayouts(scenes, ["b1", "b20"], rules).skipped, [{ beat_id: "b20", reason: "splash_limit" }]);
});

test("layout planning deduplicates candidates, skips unknown or verbose beats and is immutable and deterministic", () => {
  const scenes = beats();
  scenes[0].beats[0].beat_type = "climax";
  const before = structuredClone(scenes), rules = budgetRules();
  const top = ["b99", "b1", "b1", "b20"];
  const plan = planLayouts(scenes, top, rules);
  assert.deepEqual(plan.skipped, [{ beat_id: "b99", reason: "unknown_beat" }]);
  assert.deepEqual(plan.items, [{ beat_id: "b1", layout: "strip-1" }, { beat_id: "b20", layout: "strip-3b" }]);
  assert.deepEqual(planLayouts(scenes, top, rules), plan);
  assert.deepEqual(scenes, before);
  assert.deepEqual(top, ["b99", "b1", "b1", "b20"]);
  scenes[0].beats[0].dialogue = Array.from({ length: 3 }, () => ({ speaker: null, type: "narration" as const, text: "话。" }));
  assert.deepEqual(planLayouts(scenes, ["b1"], rules).skipped, [{ beat_id: "b1", reason: "dialogue" }]);
  assert.deepEqual(planLayouts(adaptation.scenes, ["b1"], rules).items, []);
  assert.equal(planLayouts(adaptation.scenes, ["b1"], rules).budget, 0);
  assert.equal(planLayouts(scenes, ["b20", "b1"], budgetRules({ layout_rules: { ...rules.layout_rules, max_candidates: 1 } })).budget_tier, "daily");
});

test("tagged adaptation and layout plan share a transaction and the plan has a matching JSON mirror", async (t) => {
  const ai = new MockAi(), page = fourPanelPage();
  page.panels[3].shot = "近景";
  ai.onStructured = (request) => request.schema_name === "adapt" ? { ...adaptation, scenes: adaptation.scenes.map((scene) => ({ ...scene, beats: scene.beats.map((beat) => ({ ...beat, beat_type: "reaction" })) })), top_moments: ["b1"] } : request.schema_name === "storyboard" ? { pages: [page] } : mockOutput(request);
  const f = await preparedFixture(t, ai);
  f.ctx.config.storyboard = budgetRules({ layout_budget: { daily: 0, action: 0, climax: 0 } });
  const transaction = f.ctx.db.transaction.bind(f.ctx.db);
  let atomicPlan = false;
  f.ctx.db.transaction = async (statements) => {
    if (statements.some((item) => item.sql.startsWith("INSERT INTO adaptations"))) atomicPlan = statements.some((item) => item.params?.[0] === "layout.plan.001");
    await transaction(statements);
  };
  await adaptChapter(f.ctx, 1);
  assert.equal(atomicPlan, true);
  const stored = await getLayoutPlan(f.ctx, "001");
  assert.equal(stored!.budget, 0);
  assert.deepEqual(stored!.top_moments, ["b1"]);
  assert.deepEqual(await f.ctx.fs.readText("chapters/001/layout_plan.json").then((text) => JSON.parse(text!)), stored);
  const scenes = JSON.parse((await f.ctx.db.get<{ scenes: string }>("SELECT scenes FROM adaptations WHERE chapter_id='001'"))!.scenes);
  assert.equal(scenes[0].beats[0].beat_type, "reaction");
  assert.equal(Object.hasOwn(scenes, "top_moments"), false);
});

test("reusing an untagged completed adaptation writes an empty plan without another model request", async (t) => {
  const ai = new MockAi();
  ai.onStructured = (request) => request.schema_name === "storyboard" ? { pages: [fourPanelPage()] } : mockOutput(request);
  const f = await preparedFixture(t, ai);
  f.ctx.config.storyboard.format = "strip";
  await adaptChapter(f.ctx, 1);
  const calls = ai.structuredCalls.length;
  f.ctx.config.storyboard.layout_mode = "budget";
  const result = await adaptChapter(f.ctx, 1) as { skipped: boolean };
  assert.equal(result.skipped, true);
  assert.equal(ai.structuredCalls.length, calls);
  assert.deepEqual(JSON.parse((await f.ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key='layout.plan.001'"))!.value), { budget: 0, items: [] });
  assert.deepEqual(JSON.parse((await f.ctx.fs.readText("chapters/001/layout_plan.json"))!), { budget: 0, items: [] });
});

test("forced manuscript imports invalidate only their layout plans while keeping locked references", async (t) => {
  const f = await preparedFixture(t);
  await f.ctx.db.run("INSERT INTO meta (key,value) VALUES ('layout.plan.001',?)", [JSON.stringify({ budget: 0, items: [] })]);
  const refs = await f.ctx.db.all("SELECT * FROM refs ORDER BY id");
  await importNovel(f.ctx, new TextEncoder().encode(novel), { force: true });
  assert.equal(await getLayoutPlan(f.ctx, "001"), null);
  assert.deepEqual(await f.ctx.db.all("SELECT * FROM refs ORDER BY id"), refs);
});

test("budget storyboards accept exactly planned hero groups, even when special groups are adjacent", () => {
  const scenes = beats(), plan: LayoutPlan = { budget: 4, budget_tier: "climax", top_moments: ["b1", "b20"], items: [{ beat_id: "b1", layout: "strip-1" }, { beat_id: "b20", layout: "strip-3b" }], skipped: [] };
  assert.deepEqual(checkLayouts([plannedPage("strip-1", 1, "b1"), plannedPage("strip-3b", 2, "b20")], scenes, plan), []);
  const extra = checkLayouts([plannedPage("strip-1", 1, "b1"), plannedPage("strip-3b", 2, "b20"), plannedPage("strip-2", 3, "b30")], scenes, plan);
  assert.ok(extra.some((issue) => issue.detail.includes("unplanned")));
  const missing = checkLayouts([plannedPage("strip-3b", 1, "b20")], scenes, plan);
  assert.ok(missing.some((issue) => issue.detail.includes("b1") && issue.detail.includes("strip-1")));
});

test("hero beat checks report the real hero panel and built-in shapes reject incorrect counts or sizes", () => {
  const scenes = beats(), plan = planLayouts(scenes, ["b1"], budgetRules());
  const wrongHero = plannedPage("strip-3b", 1);
  wrongHero.panels[0].beat_ids = ["b1"];
  const issues = checkLayouts([wrongHero], scenes, plan);
  assert.ok(issues.some((issue) => issue.detail.includes("Planned beat b1") && issue.panel === "p3" && issue.type === "pacing"));
  const shape = fourPanelPage();
  shape.layout = "strip-3b";
  const invalid = checkLayouts([shape], scenes, plan);
  assert.ok(invalid.some((issue) => issue.fix.includes("3 panels, sizes wide, wide, large")));
  for (const name of ["strip-3c", "constructor"]) {
    const unknown = { ...wrongHero, layout: name };
    assert.ok(checkLayouts([unknown], scenes, plan).some((issue) => issue.detail.includes("Unknown strip layout")));
  }
});

test("one hero group cannot satisfy two distinct layout-plan items", () => {
  const scenes = beats(), plan: LayoutPlan = { budget: 2, budget_tier: "daily", top_moments: ["b1", "b20"], items: [{ beat_id: "b1", layout: "strip-3b" }, { beat_id: "b20", layout: "strip-3b" }], skipped: [] };
  const merged = plannedPage("strip-3b", 1, "b1");
  merged.panels[2].beat_ids.push("b20");
  assert.ok(checkLayouts([merged], scenes, plan).some((issue) => issue.detail.includes("multiple layout items")));
});

test("shot runs are checked in chapter reading order across groups and can be disabled", () => {
  const scenes = beats(), rules = budgetRules(), plan: LayoutPlan = { budget: 0, budget_tier: "daily", top_moments: [], items: [], skipped: [] };
  const page = fourPanelPage();
  const issues = checkLayouts([page], scenes, plan, rules);
  assert.equal(issues.filter((issue) => issue.detail.includes("consecutive panels")).length, 1);
  assert.equal(issues.find((issue) => issue.detail.includes("consecutive panels"))!.panel, "p4");
  assert.deepEqual(checkLayouts([page], scenes, plan, { ...rules, layout_rules: { ...rules.layout_rules, max_same_shot_run: 0 } }), []);
  const p1 = plannedPage("strip-1", 1, "b1"), p2 = plannedPage("strip-3b", 2, "b20");
  for (const panel of [...p1.panels, ...p2.panels]) panel.shot = "中景";
  plan.items = [{ beat_id: "b1", layout: "strip-1" }, { beat_id: "b20", layout: "strip-3b" }];
  const cross = checkLayouts([p2, p1], scenes, plan, rules);
  assert.ok(cross.some((issue) => issue.page === 2 && issue.panel === "p3" && issue.detail.includes("consecutive panels")));
});

test("program-invalid layout groups are revised before rendering and previews carry the same plan", async (t) => {
  const ai = new MockAi(), page = plannedPage("strip-3b", 1, "b1");
  page.panels[0].beat_ids = ["b2"];
  page.panels[1].beat_ids = ["b3"];
  let storyboards = 0;
  ai.onStructured = (request) => {
    if (request.schema_name === "adapt") return { ...adaptation, scenes: adaptation.scenes.map((scene) => ({ ...scene, beats: scene.beats.map((beat) => ({ ...beat, beat_type: "reaction" })) })), top_moments: ["b1"] };
    if (request.schema_name === "storyboard") return { pages: [storyboards++ === 0 ? fourPanelPage() : page] };
    return mockOutput(request);
  };
  const f = await preparedFixture(t, ai), images = ai.imageCalls.length;
  f.ctx.config.storyboard = budgetRules();
  const result = await adaptChapter(f.ctx, 1) as { passed: boolean; revisions: number };
  assert.equal(result.passed, true);
  assert.equal(result.revisions, 1);
  assert.equal(storyboards, 2);
  assert.equal(ai.imageCalls.length, images);
  assert.deepEqual(JSON.parse((await f.ctx.fs.readText("chapters/001/storyboard.json"))!), { pages: [page] });
  const calls = ai.structuredCalls.filter((request) => request.schema_name === "storyboard");
  for (const call of calls) assert.match(call.system, /b1：layout=strip-3b，3 格，size 依次为 wide、wide、large，重点格是第 3 格/);
  const preview = await renderStepPrompt(f.ctx, "storyboard", { chapter: 1 }) as { system: string };
  assert.match(preview.system, /b1：layout=strip-3b/);
});

test("a planned hero on a later group can be repaired without losing the legal cross-group revision", async (t) => {
  const ai = new MockAi(), scenes = beats(3);
  scenes[0].beats[0].beat_type = "climax";
  const initial = [plannedPage("strip-4", 1), plannedPage("strip-4", 2), plannedPage("strip-4", 3)];
  initial[0].panels[0].beat_ids = ["b2"];
  initial[1].panels[0].beat_ids = ["b3"];
  initial[2].panels[0].beat_ids = ["b1"];
  const corrected = plannedPage("strip-1", 3, "b1");
  let calls = 0;
  ai.onStructured = (request) => request.schema_name === "adapt" ? { scenes, suggested_pages: 3, top_moments: ["b1"] } : request.schema_name === "storyboard" ? { pages: calls++ === 0 ? initial : [corrected] } : mockOutput(request);
  const f = await preparedFixture(t, ai);
  f.ctx.config.storyboard = budgetRules();
  await adaptChapter(f.ctx, 1);
  const stored = JSON.parse((await f.ctx.fs.readText("chapters/001/storyboard.json"))!);
  assert.deepEqual(stored.pages, [initial[0], initial[1], corrected]);
  const revision = ai.structuredCalls.filter((request) => request.schema_name === "storyboard")[1];
  assert.match(revision.system, /size 只使用 small、medium、large、wide、splash/);
  assert.doesNotMatch(revision.system, /每组四个横向画格单列排列/);
});

test("unsupported built-in shapes are refused in config before any model calls", () => {
  for (const definition of [{ rows: [50, 25, 25], hero: 1, cost: 2 }, { rows: [65, 35], hero: 2, cost: 2 }]) {
    assert.equal(configSchema.safeParse({ ...defaults, storyboard: { ...defaults.storyboard, layouts: { ...defaults.storyboard.layouts, "strip-2": definition } } }).success, false);
  }
});

test("variable strip image prompts describe exact row heights and only the hero gets key-moment composition", async (t) => {
  const f = await preparedFixture(t), page = plannedPage("strip-2", 1, "b1");
  const built = await buildPagePrompt(f.ctx, page);
  assert.match(built.prompt.text, /Panel 1 occupies 65% of the canvas height, starting 0% from the top; this is the key panel of the strip\./);
  assert.match(built.prompt.text, /Panel 2 occupies 35% of the canvas height, starting 65% from the top\./);
  assert.equal((built.prompt.text.match(/Key moment:/g) ?? []).length, 1);
  const sections = built.prompt.text.split("[PANEL ");
  assert.match(sections[1], /Key moment:/);
  assert.doesNotMatch(sections[2], /Key moment:/);
  const fixed = await buildPagePrompt(f.ctx, fourPanelPage());
  assert.doesNotMatch(fixed.prompt.text, /occupies .*%|Key moment:/);
  await saveStoryboard(f.ctx, "001", [page]);
  const preview = await renderStepPrompt(f.ctx, "image/page.md", { page: "001-p01" }) as { text: string };
  assert.match(preview.text, /Panel 2 occupies 35%/);
});

test("same-scene groups render serially and include the prior selected original at full size", async (t) => {
  const ai = new MockAi(), f = await continuityFixture(t, ai), before = ai.imageCalls.length;
  f.ctx.config.image.concurrency = 3;
  let active = 0, maximum = 0;
  ai.onImage = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
  };
  await renderChapter(f.ctx, 1);
  assert.equal(maximum, 1);
  const calls = ai.imageCalls.slice(before);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.ok(call.images.some((image) => image.name === "qinglan_peak.png"));
  const reference = calls[1].images.find((image) => image.name === "001-p01.png");
  assert.ok(reference);
  assert.deepEqual(reference.data, png);
  assert.match(calls[1].prompt, /Use only its last panel/);
  assert.ok(!calls[0].images.some((image) => image.name.startsWith("001-p")));
  assert.ok(!calls[2].images.some((image) => image.name.startsWith("001-p")));
  const attempt = await f.ctx.db.get<{ ref_paths: string }>("SELECT ref_paths FROM attempts WHERE page_id='001-p02'");
  const paths = JSON.parse(attempt!.ref_paths) as string[];
  assert.ok(paths.some((path) => path === "chapters/001/attempts/p01-a1.png"));
  assert.ok(paths.every((path) => !path.includes("/pages/")));
});

test("scene continuity reserves location and prior-image slots instead of silently discarding identities", async (t) => {
  const f = await continuityFixture(t);
  await renderPage(f.ctx, "001-p01");
  f.ctx.config.image.max_refs = 3;
  const calls = f.ai.imageCalls.length;
  await assert.rejects(buildPagePrompt(f.ctx, f.pages[1], "", [], "001"), /max_refs >= 4/);
  assert.equal(f.ai.imageCalls.length, calls);
  f.ctx.config.image.max_refs = 4;
  f.ctx.config.image.include_location_ref = false;
  await assert.rejects(buildPagePrompt(f.ctx, f.pages[1], "", [], "001"), /include_location_ref=true/);
});

test("continuity references stop at time cuts and never propagate flagged or unpassed previous selections", async (t) => {
  const f = await continuityFixture(t);
  await renderPage(f.ctx, "001-p01");
  const nighttime = structuredClone(f.pages[1]);
  for (const panel of nighttime.panels) panel.time = "夜晚";
  assert.ok((await buildPagePrompt(f.ctx, nighttime, "", [], "001")).refs.every((ref) => ref.kind !== "continuity"));
  await f.ctx.db.run("UPDATE pages SET status='flagged' WHERE id='001-p01'");
  assert.ok((await buildPagePrompt(f.ctx, f.pages[1], "", [], "001")).refs.every((ref) => ref.kind !== "continuity"));
  await f.ctx.db.run("UPDATE pages SET status='exported' WHERE id='001-p01'");
  await f.ctx.db.run("UPDATE reviews SET passed=0 WHERE attempt_id=(SELECT final_attempt_id FROM pages WHERE id='001-p01')");
  assert.ok((await buildPagePrompt(f.ctx, f.pages[1], "", [], "001")).refs.every((ref) => ref.kind !== "continuity"));
});

test("auto-passed images made with visual review disabled are not inherited as model-reviewed references", async (t) => {
  const f = await continuityFixture(t);
  f.ctx.config.review.enabled = false;
  await renderPage(f.ctx, "001-p01");
  assert.equal((await f.ctx.db.get<{ status: string }>("SELECT status FROM pages WHERE id='001-p01'"))!.status, "passed");
  assert.ok((await buildPagePrompt(f.ctx, f.pages[1], "", [], "001")).refs.every((ref) => ref.kind !== "continuity"));
});

test("missing or changed continuity originals stop before new image fees", async (t) => {
  const f = await continuityFixture(t);
  await renderPage(f.ctx, "001-p01");
  const before = await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), calls = f.ai.imageCalls.length;
  await writeFile(join(f.root, "projects/book/chapters/001/attempts/p01-a1.png"), new Uint8Array([1, 2, 3]));
  await assert.rejects(renderPage(f.ctx, "001-p02"), /original is missing or changed/);
  assert.equal(f.ai.imageCalls.length, calls);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), before);
});

test("budget mode on paged comics warns and strip layout detection includes the built-in variants", async (t) => {
  const f = await fixture(new MockAi());
  t.after(f.close);
  await writeFile(join(f.root, "config.yaml"), "storyboard:\n  format: page\n  layout_mode: budget\n");
  await createProject(f.workspace.store, "book", "Book");
  const h = await f.workspace.context("book");
  try { assert.ok(h.events.some((event) => event.level === "warning" && event.message.includes("using fixed layouts"))); }
  finally { await h.close(); }
  for (const layout of ["strip-4", "strip-3a", "strip-3b", "strip-2", "strip-1"]) assert.equal(isStripLayout(layout), true);
  assert.equal(isStripLayout("1 wide | 2"), false);
});
