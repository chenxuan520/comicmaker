import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zodResponseFormat } from "openai/helpers/zod";
import { adaptationSchema, adaptationLlmSchema, configSchema, sceneSchema, storyboardSchema } from "../schemas/index.js";
import { createProject, importNovel } from "../src/core/project.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { saveStoryboard } from "../src/core/steps/adapt.js";
import { renderStepPrompt } from "../src/core/pipeline.js";
import { isStripLayout } from "../src/core/types.js";
import { adaptation, fixture, MockAi, novel, storyboard } from "./helpers.js";

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
