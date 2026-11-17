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
import { planLayouts } from "../src/core/layoutPlan.js";
import { renderStepPrompt } from "../src/core/pipeline.js";
import { isStripLayout } from "../src/core/types.js";
import { adaptation, fixture, mockOutput, MockAi, novel, storyboard } from "./helpers.js";

const defaults = configSchema.parse(parse(await readFile(new URL("../config.default.yaml", import.meta.url), "utf8")));

function budgetRules(overrides: Partial<Config["storyboard"]> = {}) {
  return configSchema.parse({ ...defaults, storyboard: { ...defaults.storyboard, format: "strip", layout_mode: "budget", ...overrides } }).storyboard;
}

function beats(count = 40): Scene[] {
  return [{ ...structuredClone(adaptation.scenes[0]), beats: Array.from({ length: count }, (_, index) => ({ ...structuredClone(adaptation.scenes[0].beats[0]), id: `b${index + 1}`, importance: 1, beat_type: "reaction", dialogue: [] })) }];
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
