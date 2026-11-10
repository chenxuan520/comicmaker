import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { APIConnectionError } from "openai";
import { OpenAiProvider, encodeBase64 } from "../src/core/ai.js";
import { summarySchema } from "../schemas/index.js";
import { structuredCall } from "../src/core/llm.js";
import { reviewAttempt } from "../src/core/review.js";
import { createProject, importNovel } from "../src/core/project.js";
import { generateImage, pngSize, recoverPendingImages } from "../src/core/image.js";
import { generateRefs } from "../src/core/steps/refs.js";
import { renderPage } from "../src/core/steps/render.js";
import { exportChapter } from "../src/core/steps/export.js";
import { getStatus } from "../src/core/status.js";
import { errorInfo } from "../src/core/errors.js";
import { fixture, MockAi, png, novel, storyboard } from "./helpers.js";

for (const encoded of [undefined, "%%%invalid%%%"] as const) {
  test(`successful image payload ${encoded ? "with invalid base64" : "without bytes"} retains known usage and charges`, async () => {
    const server = createServer(async (request, response) => {
      for await (const _ of request) {}
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: encoded }], usage: { input_tokens: 120, input_tokens_details: { text_tokens: 80, image_tokens: 40 }, output_tokens: 20, total_tokens: 140 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const provider = new OpenAiProvider({ apiKey: "test-key", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, llmTimeout: 5000, imageTimeout: 5000 });
    const f = await fixture(provider);
    try {
      await createProject(f.workspace.store, "book", "Book");
      const handle = await f.workspace.context("book");
      try {
        await assert.rejects(generateImage(handle.ctx, { refId: "ref", prompt: { text: "test", sources: {} }, images: [], refPaths: [], path: () => "refs/style/ref.png" }));
        const spend = await f.workspace.ledger.get<{ cost_usd: number; estimated: number; input_tokens: number }>("SELECT * FROM spend");
        assert.equal(spend!.cost_usd, 0.00132);
        assert.equal(spend!.estimated, 0);
        assert.equal(spend!.input_tokens, 120);
        const attempt = await handle.ctx.db.get<{ cost_usd: number; input_tokens: number; status: string }>("SELECT * FROM attempts");
        assert.equal(attempt!.cost_usd, 0.00132);
        assert.equal(attempt!.input_tokens, 120);
        assert.equal(attempt!.status, "error");
      } finally { await handle.close(); }
    } finally {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("reference persistence failure recovers the existing paid image without generation", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      handle.ctx.config.refs.candidates = 1;
      const original = handle.ctx.db.run.bind(handle.ctx.db);
      let failed = false;
      handle.ctx.db.run = async (sql, params) => {
        if (!failed && sql.startsWith("UPDATE refs SET path")) { failed = true; throw new Error("Persistence interrupted"); }
        return original(sql, params);
      };
      await assert.rejects(generateRefs(handle.ctx, { kind: "style" }), /Persistence interrupted/);
      handle.ctx.db.run = original;
      const recovered = await generateRefs(handle.ctx, { kind: "style" });
      assert.equal(recovered.refs.length, 1);
      assert.equal(recovered.refs[0].status, "candidate");
      assert.ok(await handle.ctx.fs.readBytes(recovered.refs[0].path!));
      assert.equal(ai.imageCalls.length, 1);
      assert.equal((await handle.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts"))!.n, 1);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("truncated immutable PNGs stay error attempts during recovery", async () => {
  const f = await fixture(new MockAi());
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      assert.throws(() => pngSize(png.subarray(0, 24)), /incomplete/);
      await handle.ctx.fs.writeImage("chapters/001/attempts/p01-a1.png", png.subarray(0, 24));
      await handle.ctx.db.run("INSERT INTO attempts (id,page_id,seq,status,path) VALUES ('partial','001-p01',1,'pending','chapters/001/attempts/p01-a1.png')");
      await recoverPendingImages(handle.ctx, "001-p01");
      assert.equal((await handle.ctx.db.get<{ status: string }>("SELECT status FROM attempts WHERE id = 'partial'"))!.status, "error");
      assert.equal((await handle.ctx.fs.readBytes("chapters/001/attempts/p01-a1.png"))!.length, 24);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("an unfinished new adaptation cannot render or export old passed pages", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      await handle.ctx.db.run("INSERT INTO adaptations (chapter_id, scenes, version) VALUES ('001', '[]', 2)");
      await handle.ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status, final_attempt_id) VALUES ('001-p01', '001', 1, ?, 'passed', 'old-image')", [JSON.stringify(storyboard)]);
      await assert.rejects(renderPage(handle.ctx, "001-p01"), (error: { code?: number }) => error.code === 2);
      await assert.rejects(renderPage(handle.ctx, "001-p01", { redo: true }), (error: { code?: number }) => error.code === 2);
      await assert.rejects(exportChapter(handle.ctx, 1), (error: { code?: number }) => error.code === 2);
      assert.equal(ai.imageCalls.length, 0);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("force import clears obsolete redo notes but retains immutable history", async () => {
  const f = await fixture(new MockAi());
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      await handle.ctx.db.run("INSERT INTO meta (key,value) VALUES ('render.note.001-p01','obsolete dialogue'),('render.start.001-p01','4')");
      await handle.ctx.db.run("INSERT INTO attempts (id,page_id,seq,prompt,status) VALUES ('history','001-p01',4,'obsolete dialogue','ok')");
      await importNovel(handle.ctx, new TextEncoder().encode(novel.replace("弟子来了", "我回来了")), { force: true });
      assert.equal((await handle.ctx.db.all("SELECT key FROM meta WHERE key LIKE 'render.%'")).length, 0);
      assert.equal((await handle.ctx.db.get<{ prompt: string }>("SELECT prompt FROM attempts WHERE id = 'history'"))!.prompt, "obsolete dialogue");
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("status fetches review history once and preserves per-page attempt order", async () => {
  const f = await fixture(new MockAi());
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      await importNovel(handle.ctx, new TextEncoder().encode(novel));
      for (let pageNo = 1; pageNo <= 25; pageNo++) {
        const id = `001-p${String(pageNo).padStart(2, "0")}`;
        await handle.ctx.db.run("INSERT INTO pages (id,chapter_id,page_no,storyboard,status) VALUES (?, '001', ?, ?, 'planned')", [id, pageNo, JSON.stringify({ ...storyboard, page_no: pageNo })]);
        for (let seq = 1; seq <= 3; seq++) {
          await handle.ctx.db.run("INSERT INTO attempts (id,page_id,seq,status) VALUES (?,?,?,'ok')", [`${id}-a${seq}`, id, seq]);
          await handle.ctx.db.run("INSERT INTO reviews (id,attempt_id,score,passed) VALUES (?,?,?,0)", [`${id}-r${seq}`, `${id}-a${seq}`, seq]);
        }
      }
      const original = handle.ctx.db.all.bind(handle.ctx.db);
      let reviewQueries = 0;
      handle.ctx.db.all = async (sql, params) => {
        if (sql.includes("FROM reviews")) reviewQueries++;
        return original(sql, params);
      };
      const status = await getStatus(handle.ctx, 1);
      assert.equal(reviewQueries, 1);
      assert.equal(status.pages.length, 25);
      assert.deepEqual(status.pages[0].reviews.map((review) => review.score), [1, 2, 3]);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

test("API key-like strings are redacted from error messages", () => {
  assert.equal(errorInfo(new Error("Invalid API key sk-fake_credential-123")).message, "Invalid API key [redacted]");
});

async function responseFixture(t: TestContext, payload: unknown, status = 200, apiKey = "test-key") {
  const server = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(new OpenAiProvider({ apiKey, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, llmTimeout: 5000, imageTimeout: 5000 }));
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.context("book");
  t.after(async () => {
    await handle.close();
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { ...f, ...handle };
}

const imageOptions = { refId: "ref", prompt: { text: "test", sources: {} }, images: [], refPaths: [], path: () => "refs/style/ref.png" };

for (const step of ["image", "llm"] as const) {
  test(`HTTP 200 invalid JSON retains the ${step} estimate`, async (t) => {
    const f = await responseFixture(t, "{broken-json}");
    if (step === "image") await assert.rejects(generateImage(f.ctx, imageOptions), /could not be decoded/);
    else await assert.rejects(structuredCall(f.ctx, { step: "prepare", template: "summary", model: f.ctx.config.models.extract, schema: summarySchema, data: { chapters: [] } }), /could not be decoded/);
    const row = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend");
    assert.equal(row!.cost_usd, step === "image" ? f.ctx.config.budget.estimates.image : f.ctx.config.budget.estimates.llm);
    assert.equal(row!.estimated, 1);
  });
}

for (const step of ["image", "llm"] as const) {
  test(`incomplete ${step} usage never writes NULL or NaN spend`, async (t) => {
    const payload = step === "image"
      ? { data: [{ b64_json: encodeBase64(png) }], usage: { input_tokens: 120, input_tokens_details: { text_tokens: 80, image_tokens: 40 } } }
      : { choices: [{ message: { content: JSON.stringify({ chapters: [{ chapter: 1, summary: "摘要。" }] }) } }], usage: { total_tokens: 150 } };
    const f = await responseFixture(t, payload);
    if (step === "image") await generateImage(f.ctx, imageOptions);
    else await structuredCall(f.ctx, { step: "prepare", template: "summary", model: f.ctx.config.models.extract, schema: summarySchema, data: { chapters: [] } });
    const row = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend");
    assert.equal(row!.cost_usd, step === "image" ? f.ctx.config.budget.estimates.image : f.ctx.config.budget.estimates.llm);
    assert.equal(row!.estimated, 1);
    assert.ok(Number.isFinite(row!.cost_usd));
  });
}

test("compatible service credentials without an sk prefix are redacted at the provider boundary", async (t) => {
  const key = "compatible-provider-test-credential";
  const f = await responseFixture(t, { error: { message: `Invalid credential ${key}`, type: "invalid_request_error", code: "invalid_api_key" } }, 400, key);
  await assert.rejects(structuredCall(f.ctx, { step: "prepare", template: "summary", model: f.ctx.config.models.extract, schema: summarySchema, data: { chapters: [] } }), (error: unknown) => !errorInfo(error).message.includes(key));
  const call = await f.ctx.db.get<{ id: string; error: string }>("SELECT id,error FROM llm_calls");
  assert.ok(!call!.error.includes(key));
  assert.ok(!(await f.ctx.fs.readText(`logs/llm-${call!.id}.json`))!.includes(key));
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0);
});

test("already-cancelled reference generation does not reserve or call the provider", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      const controller = new AbortController();
      controller.abort(new Error("Already cancelled"));
      handle.ctx.signal = controller.signal;
      await assert.rejects(generateRefs(handle.ctx, { kind: "style" }), /Already cancelled/);
      assert.equal(ai.imageCalls.length, 0);
      assert.equal((await f.workspace.ledger.all("SELECT * FROM spend")).length, 0);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});

for (const step of ["image", "llm"] as const) {
  test(`cancellation after ${step} reservation but before invocation refunds known-uninvoked spend`, async () => {
    const ai = new MockAi();
    const f = await fixture(ai);
    try {
      await createProject(f.workspace.store, "book", "Book");
      const handle = await f.workspace.context("book");
      try {
        const controller = new AbortController();
        handle.ctx.signal = controller.signal;
        const original = handle.ctx.budget.begin.bind(handle.ctx.budget);
        handle.ctx.budget.begin = async (...args) => {
          const id = await original(...args);
          controller.abort(new Error("Cancelled before invocation"));
          return id;
        };
        if (step === "image") await assert.rejects(generateImage(handle.ctx, imageOptions), /Cancelled before invocation/);
        else await assert.rejects(structuredCall(handle.ctx, { step: "prepare", template: "summary", model: handle.ctx.config.models.extract, schema: summarySchema, data: { chapters: [] } }), /Cancelled before invocation/);
        assert.equal(ai.imageCalls.length + ai.structuredCalls.length, 0);
        assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0);
      } finally { await handle.close(); }
    } finally { await f.close(); }
  });
}

for (const step of ["image", "llm"] as const) {
  test(`${step} connection resets retain the unknown-fee estimate without retrying`, async () => {
    const ai = new MockAi();
    const disconnected = () => { throw new APIConnectionError({ cause: new Error("read ECONNRESET") }); };
    ai.onImage = disconnected;
    ai.onStructured = disconnected;
    const f = await fixture(ai);
    try {
      await createProject(f.workspace.store, "book", "Book");
      const handle = await f.workspace.context("book");
      try {
        if (step === "image") await assert.rejects(generateImage(handle.ctx, imageOptions), APIConnectionError);
        else await assert.rejects(structuredCall(handle.ctx, { step: "prepare", template: "summary", model: handle.ctx.config.models.extract, schema: summarySchema, data: { chapters: [] } }), APIConnectionError);
        const spend = (await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!;
        assert.equal(spend.cost_usd, step === "image" ? handle.ctx.config.budget.estimates.image : handle.ctx.config.budget.estimates.llm);
        assert.equal(spend.estimated, 1);
        assert.equal(ai.imageCalls.length + ai.structuredCalls.length, 1);
        if (step === "image") {
          const attempt = (await handle.ctx.db.get<{ cost_usd: number; error: string }>("SELECT * FROM attempts"))!;
          assert.equal(attempt.cost_usd, spend.cost_usd);
          assert.equal(JSON.parse(attempt.error).kind, "network");
        }
      } finally { await handle.close(); }
    } finally { await f.close(); }
  });
}

test("a failed call-log mirror does not demote or repeat completed OCR", async () => {
  const ai = new MockAi();
  const f = await fixture(ai);
  try {
    await createProject(f.workspace.store, "book", "Book");
    const handle = await f.workspace.context("book");
    try {
      handle.ctx.config.review.checks = { text: true, identity: false, color: false, content: false, artifacts: false, panel_count: false };
      const original = handle.ctx.fs.writeJson.bind(handle.ctx.fs);
      let failed = false;
      handle.ctx.fs.writeJson = async (path, value) => {
        if (!failed && path.startsWith("logs/llm-")) { failed = true; throw new Error("Mirror unavailable"); }
        await original(path, value);
      };
      await reviewAttempt(handle.ctx, "saved-image", storyboard, png);
      await reviewAttempt(handle.ctx, "saved-image", storyboard, png);
      assert.equal(ai.structuredCalls.length, 1);
      assert.equal((await handle.ctx.db.get<{ status: string }>("SELECT status FROM llm_calls"))!.status, "ok");
      assert.ok(await handle.ctx.db.get("SELECT value FROM meta WHERE key = ?", ["review.text.saved-image"]));
    } finally { await handle.close(); }
  } finally { await f.close(); }
});
