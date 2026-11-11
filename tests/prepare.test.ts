import test from "node:test";
import assert from "node:assert/strict";
import { createProject, importNovel } from "../src/core/project.js";
import { PromptEngine } from "../src/core/prompts.js";
import { addSettings, prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { buildPagePrompt } from "../src/core/promptBuilder.js";
import { generateImage } from "../src/core/image.js";
import { MockAi, extraction, fixture, mockOutput, novel, storyboard } from "./helpers.js";

test("M1 extracts settings, retries invalid JSON once, and skips completed preprocessing", async () => {
  const ai = new MockAi();
  ai.onStructured = (request) => ai.structuredCalls.length === 1 ? "invalid json" : mockOutput(request);
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "青岚纪");
    const handle = await f.workspace.context("book");
    try {
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      await prepareBook(handle.ctx);
      assert.equal(ai.structuredCalls.length, 3);
      assert.deepEqual(JSON.parse((await handle.ctx.fs.readText("bible/characters.json"))!), extraction.characters);
      assert.equal((await handle.ctx.db.get<{ summary: string }>("SELECT summary FROM chapters WHERE id = '001'"))!.summary, "林青在青岚峰与师父相见。");
      const count = ai.structuredCalls.length;
      assert.equal((await prepareBook(handle.ctx)).skipped, true);
      assert.equal(ai.structuredCalls.length, count);
      assert.equal((await f.workspace.ledger.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend"))!.n, 3);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("adding missing settings preserves existing originals, progress, caches and spend", async (t) => {
  const ai = new MockAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  await importNovel(ctx, new TextEncoder().encode(novel));
  await prepareBook(ctx);
  ctx.config.refs.candidates = 1;
  const style = (await generateRefs(ctx, { kind: "style" })).refs[0];
  await lockRef(ctx, style.id);
  await ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p01', '001', 1, ?, 'planned')", [JSON.stringify(storyboard)]);
  const tables = ["characters", "outfits", "locations", "chapters", "pages", "refs", "attempts", "meta"];
  const before = await Promise.all(tables.map((table) => ctx.db.all(`SELECT * FROM ${table}`)));
  const original = await ctx.fs.readBytes(style.path!);
  const spend = await f.workspace.ledger.all("SELECT * FROM spend");
  const calls = ai.structuredCalls.length + ai.imageCalls.length;
  const character = { ...structuredClone(extraction.characters[0]), id: "teacher", name: "师父" };
  character.outfits[0].id = "teacher.daily";
  const location = { ...extraction.locations[0], id: "hut_gate", name: "柴门" };
  const additions = { characters: [character], locations: [location] };
  const input = structuredClone(additions);
  assert.deepEqual(await addSettings(ctx, additions), { characters: ["teacher"], outfits: ["teacher.daily"], locations: ["hut_gate"] });
  for (const [index, table] of tables.entries()) {
    const after = await ctx.db.all<{ id?: string }>(`SELECT * FROM ${table}`);
    assert.deepEqual(after.filter((row) => !["teacher", "teacher.daily", "hut_gate"].includes(row.id ?? "")), before[index]);
  }
  assert.deepEqual(JSON.parse((await ctx.fs.readText("bible/characters.json"))!), [...extraction.characters, character]);
  assert.deepEqual(JSON.parse((await ctx.fs.readText("bible/locations.json"))!), [...extraction.locations, location]);
  assert.deepEqual(await ctx.fs.readBytes(style.path!), original);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend"), spend);
  assert.equal(ai.structuredCalls.length + ai.imageCalls.length, calls);
  assert.deepEqual(additions, input);
});

test("missing-setting additions validate every entity before writing", async (t) => {
  const ai = new MockAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  await importNovel(ctx, new TextEncoder().encode(novel));
  await assert.rejects(addSettings(ctx, extraction), /Prepare the novel/);
  await prepareBook(ctx);
  const character = { ...structuredClone(extraction.characters[0]), id: "teacher", name: "师父" };
  character.outfits[0].id = "teacher.daily";
  const location = { ...extraction.locations[0], id: "hut_gate", name: "柴门" };
  const valid = { characters: [character], locations: [location] };
  const before = await ctx.db.all("SELECT * FROM characters");
  const mirror = await ctx.fs.readText("bible/characters.json");
  const calls = ai.structuredCalls.length;
  for (const change of ["no evidence", "unknown paragraph", "unknown evidence chapter", "unknown outfit chapter", "wrong owner", "existing location", "unknown location chapter", "empty location chapters", "duplicate ID", "existing character"]) {
    const invalid = structuredClone(valid);
    if (change === "no evidence") invalid.characters[0].evidence = [];
    if (change === "unknown paragraph") invalid.characters[0].evidence = ["1:999"];
    if (change === "unknown evidence chapter") invalid.characters[0].evidence = ["2:1"];
    if (change === "unknown outfit chapter") invalid.characters[0].outfits[0].chapters = [2];
    if (change === "wrong owner") invalid.characters[0].outfits[0].id = "other.daily";
    if (change === "existing location") invalid.locations = extraction.locations;
    if (change === "unknown location chapter") invalid.locations[0].chapters = [2];
    if (change === "empty location chapters") invalid.locations[0].chapters = [];
    if (change === "duplicate ID") invalid.characters.push(invalid.characters[0]);
    if (change === "existing character") invalid.characters = extraction.characters;
    await assert.rejects(addSettings(ctx, invalid), change);
    assert.deepEqual(await ctx.db.all("SELECT * FROM characters"), before);
    assert.deepEqual((await ctx.db.all<{ id: string }>("SELECT id FROM outfits")).map((item) => item.id), ["lin_qing.daily"]);
    assert.deepEqual((await ctx.db.all<{ id: string }>("SELECT id FROM locations")).map((item) => item.id), ["qinglan_peak"]);
    assert.equal(await ctx.fs.readText("bible/characters.json"), mirror);
    assert.equal(ai.structuredCalls.length, calls);
  }
  await assert.rejects(addSettings(ctx, { characters: [], locations: [] }), /at least one/);
});

test("forced preparation clears old summaries atomically and resumes an interrupted new summary", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    const ctx = handle.ctx;
    try {
      await importNovel(ctx, new TextEncoder().encode(novel));
      await prepareBook(ctx);
      ctx.config.refs.candidates = 1;
      const style = (await generateRefs(ctx, { kind: "style" })).refs[0];
      await lockRef(ctx, style.id);
      const refs = await ctx.db.all("SELECT * FROM refs ORDER BY id");
      const attempts = await ctx.db.all("SELECT * FROM attempts ORDER BY id");
      const image = await ctx.fs.readBytes(style.path!);
      let interrupted = false;
      ai.onStructured = async (request) => {
        if (request.schema_name === "extract") {
          assert.equal((await ctx.db.get<{ summary: string | null }>("SELECT summary FROM chapters WHERE id = '001'"))!.summary, null);
          assert.deepEqual(await ctx.db.all("SELECT * FROM meta WHERE key LIKE 'prepare.%'"), []);
        }
        if (request.schema_name === "summary") {
          if (!interrupted) { interrupted = true; throw new Error("new summary interrupted"); }
          return { chapters: [{ chapter: 1, summary: "林青推开柴门，回应师父。" }] };
        }
        return mockOutput(request);
      };
      await assert.rejects(prepareBook(ctx, { force: true }), /new summary interrupted/);
      assert.equal((await ctx.db.get<{ summary: string | null }>("SELECT summary FROM chapters WHERE id = '001'"))!.summary, null);
      assert.equal((await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'prepare.extract.completed'"))!.value, "true");
      assert.equal(await ctx.db.get("SELECT value FROM meta WHERE key = 'prepare.summary.completed'"), undefined);
      await prepareBook(ctx);
      assert.deepEqual(ai.structuredCalls.map((call) => call.schema_name), ["extract", "summary", "extract", "summary", "summary"]);
      assert.equal((await ctx.db.get<{ summary: string }>("SELECT summary FROM chapters WHERE id = '001'"))!.summary, "林青推开柴门，回应师父。");
      assert.equal((await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'prepare.summary.completed'"))!.value, "true");
      assert.deepEqual(await ctx.db.all("SELECT * FROM refs ORDER BY id"), refs);
      assert.deepEqual(await ctx.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
      assert.deepEqual(await ctx.fs.readBytes(style.path!), image);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

for (const change of ["partition", "text", "model", "unchanged"]) {
  test(`interrupted extraction resumes with ${change} input without applying another chunk's cache`, async () => {
    const ai = new MockAi();
    const f = await fixture(ai);
    try {
      await createProject(f.workspace.store, "book", "Book");
      const handle = await f.workspace.context("book");
      const ctx = handle.ctx;
      try {
        const chapters = [1, 2, 3, 4].map((idx) => ({ idx, title: `第${idx}章`, text: `Person ${idx} speaks.` }));
        await importNovel(ctx, new TextEncoder().encode(chapters.map((chapter) => `${chapter.title}\n\n${chapter.text}`).join("\n\n")));
        ctx.config.llm.full_book_max_tokens = 1;
        ctx.config.llm.chunk_chapters = 2;
        ctx.prompts = new PromptEngine({
          get: async (name) => ({ name, content: name.endsWith("/system.md") ? "{{project.title}}" : "{{json this}}", source: "repository" }),
          list: async () => [], put: async () => { throw new Error("Unexpected template write"); },
        }, { project: ctx.project, config: ctx.config, vars: {} });
        const extracts: number[][] = [];
        let interrupted = false;
        ai.onStructured = (request) => {
          const data = JSON.parse(request.user) as { chapters: { idx: number }[]; extractions: typeof extraction[] };
          if (request.schema_name === "extract") {
            extracts.push(data.chapters.map((chapter) => chapter.idx));
            if (!interrupted && extracts.length === 2) { interrupted = true; throw new Error("second extraction interrupted"); }
            return {
              characters: data.chapters.map(({ idx }) => {
                const character = structuredClone(extraction.characters[0]);
                character.id = `person_${idx}`;
                character.name = `Person ${idx}`;
                character.evidence = [`${idx}:1`];
                character.outfits = [{ ...character.outfits[0], id: `${character.id}.daily`, chapters: [idx] }];
                return character;
              }),
              locations: [],
            };
          }
          if (request.schema_name === "merge") return { characters: data.extractions.flatMap((item) => item.characters), locations: [] };
          if (request.schema_name === "summary") return { chapters: data.chapters.map(({ idx }) => ({ chapter: idx, summary: `Chapter ${idx} summary` })) };
          return mockOutput(request);
        };
        await assert.rejects(prepareBook(ctx), /second extraction interrupted/);
        const cached = await ctx.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'prepare.chunk.extract.%'");
        assert.equal(cached.length, 1);
        assert.deepEqual(JSON.parse(cached[0].value).characters.map((character: { evidence: string[] }) => character.evidence), [["1:1"], ["2:1"]]);
        if (change === "partition") ctx.config.llm.chunk_chapters = 3;
        if (change === "text") await ctx.db.run("UPDATE chapters SET text = 'Person 1 speaks again.' WHERE idx = 1");
        if (change === "model") ctx.config.models.extract = "alternate-test-extract-model";
        await prepareBook(ctx);
        const resumed = change === "partition" ? [[1, 2, 3], [4]] : change === "unchanged" ? [[3, 4]] : [[1, 2], [3, 4]];
        assert.deepEqual(extracts, [[1, 2], [3, 4], ...resumed]);
        assert.deepEqual((await ctx.db.all<{ id: string }>("SELECT id FROM characters ORDER BY id")).map((character) => character.id), ["person_1", "person_2", "person_3", "person_4"]);
        const caches = await ctx.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'prepare.chunk.extract.%'");
        assert.ok(caches.every((entry) => /^prepare\.chunk\.extract\.[a-f0-9]{64}$/.test(entry.key)));
        assert.equal((await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [cached[0].key]))!.value, cached[0].value);
      } finally { await handle.close(); }
    } finally { await f.close(); }
  });
}

test("M1 locks style before outfits, saves immutable refs, builds configurable prompts and renders a handwritten page", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "青岚纪");
    const handle = await f.workspace.context("book");
    const ctx = handle.ctx;
    try {
      ctx.config.refs.candidates = 1;
      await importNovel(ctx, new TextEncoder().encode(novel));
      await prepareBook(ctx);
      await assert.rejects(generateRefs(ctx, { kind: "outfit" }), (error: { code?: number }) => error.code === 2);
      const style = (await generateRefs(ctx, { kind: "style" })).refs[0];
      assert.ok(await ctx.fs.readBytes(style.path!));
      await lockRef(ctx, style.id);
      const outfit = (await generateRefs(ctx, { kind: "outfit" })).refs[0];
      await lockRef(ctx, outfit.id);
      const location = (await generateRefs(ctx, { kind: "location" })).refs[0];
      await lockRef(ctx, location.id);
      assert.equal(ai.imageCalls[0].images.length, 0);
      assert.equal(ai.imageCalls[1].images.length, 1);
      assert.deepEqual((await generateRefs(ctx, { kind: "outfit" })).refs, []);
      const built = await buildPagePrompt(ctx, storyboard);
      assert.deepEqual(built.refs.map((ref) => ref.kind), ["style", "outfit", "location"]);
      assert.match(built.prompt.text, /墨黑 #1A1A1A/);
      assert.match(built.prompt.text, /Speech bubble.*弟子来了。/);
      assert.ok(!built.prompt.text.includes("null"));
      await ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p01', '001', 1, ?, 'planned')", [JSON.stringify(storyboard)]);
      const attempt = await generateImage(ctx, { pageId: "001-p01", prompt: built.prompt, images: built.images, refPaths: built.refs.map((ref) => ref.path), path: (seq) => `chapters/001/attempts/p01-a${seq}.png` });
      assert.equal(attempt.status, "ok");
      assert.equal(attempt.path, "chapters/001/attempts/p01-a1.png");
      assert.equal(attempt.cost_usd, 0.00132);
      assert.equal(attempt.sha256?.length, 64);
      await assert.rejects(ctx.fs.writeImage(attempt.path!, new Uint8Array([1])));
      ctx.config.image.ref_strategy = "none";
      assert.equal((await buildPagePrompt(ctx, storyboard)).refs.length, 1);
      ctx.config.image.include_style_ref = false;
      ctx.config.image.max_refs = 0;
      assert.equal((await buildPagePrompt(ctx, storyboard)).refs.length, 0);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("429 backoff does not create multiple attempts and missing image pricing records estimates", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      handle.ctx.config.image.retry_backoff_sec = [0, 0];
      handle.ctx.config.image.model = "custom-unpriced-model";
      ai.onImage = () => { if (ai.imageCalls.length < 3) throw Object.assign(new Error("rate limited"), { status: 429 }); };
      const refs = await generateRefs(handle.ctx, { kind: "style" });
      assert.equal(ai.imageCalls.length, 5);
      assert.equal(refs.refs.length, 3);
      assert.equal((await handle.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts"))!.n, 3);
      const spend = await f.workspace.ledger.all<{ estimated: number; cost_usd: number }>("SELECT estimated, cost_usd FROM spend");
      assert.ok(spend.every((entry) => entry.estimated === 1 && entry.cost_usd === handle.ctx.config.budget.estimates.image));
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("summary length is enforced by the configured schema and invalid output is retried", async () => {
  const ai = new MockAi();
  let summaries = 0;
  ai.onStructured = (request) => request.schema_name === "summary"
    ? { chapters: [{ chapter: 1, summary: ++summaries === 1 ? "林青登山拜师。" : "林青登山。" }] }
    : mockOutput(request);
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      handle.ctx.config.summary.max_chars = 5;
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      await prepareBook(handle.ctx);
      assert.equal(summaries, 2);
      assert.equal((await handle.ctx.db.get<{ summary: string }>("SELECT summary FROM chapters WHERE id = '001'"))!.summary, "林青登山。");
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("outfit ownership validation retries with the failed output and exact parent-ID feedback", async () => {
  const ai = new MockAi();
  ai.onStructured = (request) => {
    const output = mockOutput(request);
    if (request.schema_name === "extract" && ai.structuredCalls.length === 1) (output as typeof extraction).characters[0].outfits[0].id = "incorrect_owner.daily";
    return output;
  };
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      await prepareBook(handle.ctx);
      assert.equal(ai.structuredCalls.length, 3);
      assert.match(ai.structuredCalls[1].user, /incorrect_owner.daily/);
      assert.match(ai.structuredCalls[1].user, /lin_qing\./);
      const ids = await handle.ctx.db.all<{ id: string }>("SELECT id FROM outfits");
      assert.deepEqual(ids.map((item) => item.id), ["lin_qing.daily"]);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});
