import test from "node:test";
import assert from "node:assert/strict";
import { createProject, importNovel } from "../src/core/project.js";
import { addOutfit, prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { buildPagePrompt } from "../src/core/promptBuilder.js";
import { extraction, fixture, MockAi, mockOutput, storyboard } from "./helpers.js";

const stageNovel = "第一章 少年\n\n林青还是少年。\n\n第二章 晚年\n\n林青已经年老，须发皆白。";

function stageAi() {
  const ai = new MockAi();
  ai.onStructured = (request) => {
    if (request.schema_name === "summary") return { chapters: [1, 2].map((chapter) => ({ chapter, summary: `阶段${chapter}` })) };
    if (request.schema_name !== "extract") return mockOutput(request);
    const result = structuredClone(extraction);
    const character = result.characters[0];
    character.outfits.push({ ...character.outfits[0], id: "lin_qing.elder", name: "晚年阶段", desc: "年老，须发皆白，面有皱纹，穿朴素布衣。", chapters: [2] });
    character.evidence.push("2:1");
    result.locations[0].chapters.push(2);
    return result;
  };
  return ai;
}

test("character references use the requested life stage instead of always using first appearance", async (t) => {
  const ai = stageAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  await importNovel(ctx, new TextEncoder().encode(stageNovel));
  await prepareBook(ctx);
  ctx.config.refs.candidates = 1;
  const style = (await generateRefs(ctx, { kind: "style" })).refs[0];
  await lockRef(ctx, style.id);
  const young = (await generateRefs(ctx, { kind: "outfit", target: "lin_qing.daily" })).refs[0];
  await lockRef(ctx, young.id);
  const original = await ctx.fs.readBytes(young.path!);
  const elder = (await generateRefs(ctx, { kind: "outfit", target: "lin_qing.elder" })).refs[0];
  assert.notEqual(elder.id, young.id);
  assert.notEqual(elder.path, young.path);
  assert.match(elder.prompt, /晚年阶段/);
  assert.match(elder.prompt, /须发皆白/);
  assert.doesNotMatch(elder.prompt, /This sheet depicts the character's initial appearance/);
  assert.match(elder.prompt, /CURRENT TARGET/);
  await lockRef(ctx, elder.id);
  assert.equal((await ctx.db.get<{ status: string }>("SELECT status FROM refs WHERE id = ?", [young.id]))!.status, "locked");
  assert.deepEqual(await ctx.fs.readBytes(young.path!), original);
  const location = (await generateRefs(ctx, { kind: "location", target: "qinglan_peak" })).refs[0];
  await lockRef(ctx, location.id);
  const page = structuredClone(storyboard);
  page.panels.forEach((panel) => panel.characters.forEach((character) => { character.outfit = "lin_qing.elder"; }));
  const built = await buildPagePrompt(ctx, page, "", [], "002");
  assert(built.refs.some((ref) => ref.target_id === "lin_qing.elder"));
  assert(!built.refs.some((ref) => ref.target_id === "lin_qing.daily"));
  assert.match(built.prompt.text, /current outfit\/stage/i);
  assert.equal(ai.imageCalls.length, 4);
});

test("adding a character stage is source-backed, free and does not replace locked stages or chapter progress", async (t) => {
  const ai = stageAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  await importNovel(ctx, new TextEncoder().encode(stageNovel));
  const input = { ...extraction.characters[0].outfits[0], id: "lin_qing.late_work", name: "晚年劳动", desc: "年老、白发，朴素布衣。", chapters: [] as number[] };
  await assert.rejects(addOutfit(ctx, "lin_qing", input, 2, 1), /Prepare the novel/);
  await prepareBook(ctx);
  ctx.config.refs.candidates = 1;
  const style = (await generateRefs(ctx, { kind: "style" })).refs[0];
  await lockRef(ctx, style.id);
  const young = (await generateRefs(ctx, { kind: "outfit", target: "lin_qing.daily" })).refs[0];
  await lockRef(ctx, young.id);
  const original = await ctx.fs.readBytes(young.path!);
  const tables = ["chapters", "pages", "refs", "attempts", "meta", "locations"];
  const before = await Promise.all(tables.map((table) => ctx.db.all(`SELECT * FROM ${table}`)));
  const spend = await f.workspace.ledger.all("SELECT * FROM spend");
  const calls = ai.structuredCalls.length + ai.imageCalls.length;
  const sourceInput = structuredClone(input);
  assert.deepEqual(await addOutfit(ctx, "lin_qing", input, 2, 1), { character: "lin_qing", outfit: "lin_qing.late_work", source: "2:1" });
  assert.deepEqual(input, sourceInput);
  const stored = await ctx.db.get<{ spec: string }>("SELECT spec FROM outfits WHERE id = ?", [input.id]);
  assert.deepEqual(JSON.parse(stored!.spec).chapters, [2]);
  const character = JSON.parse((await ctx.db.get<{ spec: string }>("SELECT spec FROM characters WHERE id = 'lin_qing'"))!.spec);
  assert.deepEqual(character.outfits.map((outfit: { id: string }) => outfit.id), ["lin_qing.daily", "lin_qing.elder", input.id]);
  assert.deepEqual(JSON.parse((await ctx.fs.readText("bible/characters.json"))!)[0], character);
  for (const [index, table] of tables.entries()) assert.deepEqual(await ctx.db.all(`SELECT * FROM ${table}`), before[index]);
  assert.deepEqual(await ctx.fs.readBytes(young.path!), original);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend"), spend);
  assert.equal(ai.structuredCalls.length + ai.imageCalls.length, calls);
  await assert.rejects(addOutfit(ctx, "lin_qing", input, 2, 1), /already exists/);
});

test("invalid character-stage additions leave the bible, original refs and spend untouched", async (t) => {
  const ai = stageAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  await importNovel(ctx, new TextEncoder().encode(stageNovel));
  await prepareBook(ctx);
  const before = await ctx.db.all("SELECT * FROM characters");
  const outfits = await ctx.db.all("SELECT * FROM outfits");
  const mirror = await ctx.fs.readText("bible/characters.json");
  const spend = await f.workspace.ledger.all("SELECT * FROM spend");
  const input = { ...extraction.characters[0].outfits[0], id: "lin_qing.new_stage", name: "新时期", chapters: [2] };
  for (const [character, outfit, chapter, paragraph] of [
    ["missing", input, 2, 1], ["lin_qing", { ...input, id: "other.elder" }, 2, 1],
    ["lin_qing", { ...input, id: "lin_qing.daily" }, 2, 1], ["lin_qing", { ...input, chapters: [999] }, 2, 1],
    ["lin_qing", input, 999, 1], ["lin_qing", input, 2, 999], ["lin_qing", input, 2, 0],
    ["lin_qing", { ...input, name: " " }, 2, 1], ["lin_qing", { ...input, surprise: true }, 2, 1],
  ] as const) {
    await assert.rejects(addOutfit(ctx, character, outfit, chapter, paragraph));
    assert.deepEqual(await ctx.db.all("SELECT * FROM characters"), before);
    assert.deepEqual(await ctx.db.all("SELECT * FROM outfits"), outfits);
    assert.equal(await ctx.fs.readText("bible/characters.json"), mirror);
    assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend"), spend);
  }
});
