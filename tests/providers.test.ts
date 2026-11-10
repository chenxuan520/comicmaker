import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { stringify } from "yaml";
import { aiConnection, aiKeys } from "../src/adapters/ai.js";
import { apiKey, loadConfig } from "../src/adapters/config.js";
import { startServer } from "../src/adapters/server.js";
import { encodeBase64 } from "../src/core/ai.js";
import { priceUsage } from "../src/core/budget.js";
import { generateImage, pngSize } from "../src/core/image.js";
import { structuredCall } from "../src/core/llm.js";
import { createProject, importNovel } from "../src/core/project.js";
import { runChapter } from "../src/core/pipeline.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { summarySchema } from "../schemas/index.js";
import { fixture, mockOutput, novel, png } from "./helpers.js";

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "Provider tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; });

interface RecordedRequest { path: string; headers: IncomingHttpHeaders; payload: Record<string, unknown> }
interface MockReply { status?: number; body: unknown }

async function providerFixture(t: TestContext, provider: "seedream" | "qwen" = "seedream") {
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const requests: RecordedRequest[] = [];
  const replies = new Map<string, MockReply>();
  let url: string;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ path, headers: request.headers, payload });
    let reply = replies.get(path);
    if (!reply && path.endsWith("/chat/completions")) {
      const format = payload.response_format;
      const name = format.json_schema?.name ?? payload.messages[0].content.match(/JSON schema \(([^)]+)\):/)[1];
      reply = { body: { choices: [{ message: { content: JSON.stringify(mockOutput({ model: payload.model, system: "", user: "", schema: format, schema_name: name })), reasoning_content: "Ignored reasoning" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } } };
    } else if (!reply && path.endsWith("/images/generations")) {
      reply = { body: { data: [{ b64_json: encodeBase64(png) }], usage: { generated_images: 1, output_tokens: 20 } } };
    } else if (!reply && path.endsWith("/multimodal-generation/generation")) {
      reply = { body: { output: { choices: [{ message: { content: [{ image: `${url}/generated.png` }] } }] }, usage: { image_count: 1, input_tokens: 0, output_tokens: 0 } } };
    } else if (!reply && path === "/generated.png") reply = { body: png };
    reply ??= { status: 404, body: { message: `Unexpected mock path ${path}` } };
    response.writeHead(reply.status ?? 200, { "Content-Type": reply.body instanceof Uint8Array ? "image/png" : "application/json" });
    response.end(reply.body instanceof Uint8Array ? reply.body : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const f = await fixture();
  cleanup.push(f.close);
  const model = provider === "seedream" ? "doubao-seedream-4-5-251128" : "qwen-image-2.0";
  await writeFile(join(f.root, "config.yaml"), stringify({
    openai: { base_url: `${url}/openai/v1`, api_key_env: "COMIC_TEST_VISION_KEY" },
    llm: { provider: "deepseek", base_url: `${url}/deepseek`, api_key_env: "COMIC_TEST_TEXT_KEY", timeout_sec: 5, retry_backoff_sec: [] },
    models: { extract: "deepseek-flash", adapt: "deepseek-flash", storyboard: "deepseek-flash", storyboard_review: "deepseek-flash", rewrite: "deepseek-flash" },
    image: { provider, model, base_url: `${url}/${provider}/api/${provider === "qwen" ? "v1" : "v3"}`, api_key_env: "COMIC_TEST_IMAGE_KEY", size: "1664x2496", timeout_sec: 5, retry_backoff_sec: [] },
    pricing: { "deepseek-flash": { input: 1, output: 2 }, [model]: { per_image: 0.04 } },
    refs: { candidates: 1 }, export: { pdf: false, reading_image_kb: null }, budget: { limit_usd: 10, period: "none" },
  }));
  await writeFile(join(f.root, ".env"), "COMIC_TEST_TEXT_KEY=text-test-key\nCOMIC_TEST_VISION_KEY=vision-test-key\nCOMIC_TEST_IMAGE_KEY=image-test-key\n");
  await createProject(f.workspace.store, "book", "Book");
  return { ...f, url, requests, replies, model, cleanup };
}

const imageOptions = { refId: "ref", prompt: { text: "Draw the page exactly as described", sources: {} }, images: [], refPaths: [], path: () => "refs/style/ref.png" };

test("provider connections retain OpenAI defaults and allow independent endpoint and key overrides", async (t) => {
  const f = await providerFixture(t);
  const { config } = await loadConfig(f.workspace.repository, f.root, "book");
  assert.deepEqual(aiConnection(config, "vision"), config.openai);
  const defaults = structuredClone(config);
  defaults.llm.base_url = null; defaults.llm.api_key_env = null;
  defaults.image.base_url = null; defaults.image.api_key_env = null;
  assert.deepEqual(aiConnection(defaults, "text"), { base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" });
  assert.deepEqual(aiConnection(defaults, "image"), { base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "ARK_API_KEY" });
  defaults.image.provider = "qwen";
  assert.deepEqual(aiConnection(defaults, "image"), { base_url: "https://dashscope.aliyuncs.com/api/v1", api_key_env: "DASHSCOPE_API_KEY" });
  assert.deepEqual(await aiKeys(f.root, config), { text: "text-test-key", vision: "vision-test-key", image: "image-test-key" });
  const previous = process.env.COMIC_TEST_TEXT_KEY;
  process.env.COMIC_TEST_TEXT_KEY = "environment-test-key";
  try { assert.equal(await apiKey(f.root, aiConnection(config, "text")), "environment-test-key"); }
  finally { if (previous === undefined) delete process.env.COMIC_TEST_TEXT_KEY; else process.env.COMIC_TEST_TEXT_KEY = previous; }
});

test("DeepSeek JSON mode includes the schema and permits text calls without image or vision credentials", async (t) => {
  const f = await providerFixture(t);
  await writeFile(join(f.root, ".env"), "COMIC_TEST_TEXT_KEY=text-test-key\n");
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  handle.ctx.ai.ready("text");
  assert.throws(() => handle.ctx.ai.ready("vision"), /API key/);
  assert.throws(() => handle.ctx.ai.ready("image"), /API key/);
  const result = await structuredCall(handle.ctx, { step: "prepare", template: "summary", model: "deepseek-flash", schema: summarySchema, data: { chapters: [] } });
  assert.equal(result.chapters.length, 1);
  const recorded = f.requests[0];
  assert.equal(recorded.path, "/deepseek/chat/completions");
  assert.equal(recorded.headers.authorization, "Bearer text-test-key");
  assert.deepEqual(recorded.payload.response_format, { type: "json_object" });
  const messages = recorded.payload.messages as { content: unknown }[];
  assert.equal(typeof messages[1].content, "string");
  assert.match(messages[0].content as string, /JSON schema \(summary\):/);
  assert.match(messages[0].content as string, /"required":\["chapters"\]/);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0.0002);
});

test("DeepSeek vision models receive image inputs when review is explicitly routed to DeepSeek", async (t) => {
  const f = await providerFixture(t);
  await writeFile(join(f.root, "projects/book/project.yaml"), stringify({ review: { provider: "deepseek", base_url: `${f.url}/deepseek`, api_key_env: "COMIC_TEST_TEXT_KEY" } }));
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await handle.ctx.ai.structured({ model: "deepseek-flash", schema: { type: "json_schema", json_schema: { schema: {} } }, schema_name: "review_text", system: "Read text", user: "Read the page", images: [{ data: png, name: "page.png", label: "Comic page" }] });
  const recorded = f.requests[0];
  assert.equal(recorded.path, "/deepseek/chat/completions");
  assert.equal(recorded.headers.authorization, "Bearer text-test-key");
  const messages = recorded.payload.messages as { content: { type: string; image_url?: { url: string } }[] }[];
  assert.equal(messages[1].content.find((part) => part.type === "image_url")!.image_url!.url, `data:image/png;base64,${encodeBase64(png)}`);
});

test("invalid DeepSeek JSON structures still undergo Zod validation, paid schema retry and accounting", async (t) => {
  const f = await providerFixture(t);
  f.replies.set("/deepseek/chat/completions", { body: { choices: [{ message: { content: '{"chapters":"invalid"}' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } } });
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await assert.rejects(structuredCall(handle.ctx, { step: "prepare", template: "summary", model: "deepseek-flash", schema: summarySchema, data: { chapters: [] } }));
  assert.equal(f.requests.length, 2);
  const spend = await f.workspace.ledger.all<{ cost_usd: number; estimated: number }>("SELECT * FROM spend");
  assert.equal(spend.length, 2);
  assert.ok(spend.every((row) => row.cost_usd === 0.0002 && row.estimated === 0));
});

test("image generation does not require text or review credentials", async (t) => {
  const f = await providerFixture(t);
  await writeFile(join(f.root, ".env"), "COMIC_TEST_IMAGE_KEY=image-test-key\n");
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await generateImage(handle.ctx, imageOptions);
  assert.equal(f.requests.length, 1);
  assert.throws(() => handle.ctx.ai.ready("text"), /API key/);
  assert.throws(() => handle.ctx.ai.ready("vision"), /API key/);
});

test("Seedream sends reference images as JSON and converts JPEG pixels to PNG without resizing", async (t) => {
  const f = await providerFixture(t);
  const encoded = jpeg.encode({ width: 2, height: 3, data: Buffer.alloc(2 * 3 * 4, 255) }, 90).data;
  f.replies.set("/seedream/api/v3/images/generations", { body: { data: [{ b64_json: encodeBase64(encoded) }], usage: { generated_images: 1, output_tokens: 20 } } });
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  const refs = [{ data: png, name: "first.png", label: "Style" }, { data: png, name: "second.png", label: "Character" }];
  const attempt = await generateImage(handle.ctx, { ...imageOptions, images: refs, refPaths: ["first.png", "second.png"] });
  const data = (await handle.ctx.fs.readBytes(attempt.path!))!;
  assert.deepEqual(pngSize(data), { width: 2, height: 3 });
  assert.deepEqual(PNG.sync.read(Buffer.from(data)).data, jpeg.decode(encoded).data);
  const recorded = f.requests[0];
  assert.equal(recorded.path, "/seedream/api/v3/images/generations");
  assert.equal(recorded.headers.authorization, "Bearer image-test-key");
  assert.deepEqual(recorded.payload.image, refs.map(() => `data:image/png;base64,${encodeBase64(png)}`));
  assert.equal(recorded.payload.response_format, "b64_json");
  assert.equal(recorded.payload.size, "1664x2496");
  assert.equal(recorded.payload.watermark, false);
  assert.equal(recorded.payload.quality, undefined);
  assert.equal(recorded.payload.output_format, undefined);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!.cost_usd, 0.04);
});

test("Qwen uses native multimodal generation and downloads PNGs without sending API credentials to image storage", async (t) => {
  const f = await providerFixture(t, "qwen");
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await generateImage(handle.ctx, { ...imageOptions, images: [{ data: png, name: "style.png", label: "Style" }], refPaths: ["style.png"] });
  const [generation, download] = f.requests;
  assert.equal(generation.path, "/qwen/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(generation.headers.authorization, "Bearer image-test-key");
  assert.deepEqual(generation.payload.parameters, { size: "1664*2496", n: 1, watermark: false, prompt_extend: false });
  assert.deepEqual(generation.payload.input, { messages: [{ role: "user", content: [{ image: `data:image/png;base64,${encodeBase64(png)}` }, { text: imageOptions.prompt.text }] }] });
  assert.equal(download.path, "/generated.png");
  assert.equal(download.headers.authorization, undefined);
  const spend = (await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!;
  assert.deepEqual([spend.cost_usd, spend.estimated], [0.04, 0]);
});

for (const provider of ["seedream", "qwen"] as const) {
  test(`${provider} shares the existing prepare, references, page review, export and budget pipeline`, async (t) => {
    const f = await providerFixture(t, provider);
    const handle = await f.workspace.context("book");
    f.cleanup.push(handle.close);
    await importNovel(handle.ctx, new TextEncoder().encode(novel));
    await prepareBook(handle.ctx);
    for (const [kind, target] of [["style", "project"], ["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]] as const) {
      const result = await generateRefs(handle.ctx, { kind, target });
      await lockRef(handle.ctx, result.refs[0].id);
    }
    const result = await runChapter(handle.ctx, 1);
    assert.deepEqual(result.rendering.flagged, []);
    assert.ok(result.export.html);
    const textCalls = f.requests.filter((recorded) => recorded.path === "/deepseek/chat/completions");
    const visionCalls = f.requests.filter((recorded) => recorded.path === "/openai/v1/chat/completions");
    assert.equal(textCalls.length, 5);
    assert.equal(visionCalls.length, 2);
    assert.ok(textCalls.every((recorded) => recorded.headers.authorization === "Bearer text-test-key"));
    assert.ok(visionCalls.every((recorded) => recorded.headers.authorization === "Bearer vision-test-key"));
    assert.equal((await handle.ctx.db.all("SELECT * FROM attempts WHERE status = 'ok'")).length, 4);
    assert.equal((await f.workspace.ledger.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend"))!.n, 11);
  });

  test(`${provider} malformed successful responses retain the unknown-fee estimate`, async (t) => {
    const f = await providerFixture(t, provider);
    const path = provider === "seedream" ? "/seedream/api/v3/images/generations" : "/qwen/api/v1/services/aigc/multimodal-generation/generation";
    f.replies.set(path, { body: "{broken-json}" });
    const handle = await f.workspace.context("book");
    f.cleanup.push(handle.close);
    await assert.rejects(generateImage(handle.ctx, imageOptions), /could not be decoded/);
    const spend = (await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!;
    assert.deepEqual([spend.cost_usd, spend.estimated], [0.25, 1]);
  });

  test(`${provider} native safety refusals remain refused attempts with no successful-image charge`, async (t) => {
    const f = await providerFixture(t, provider);
    const path = provider === "seedream" ? "/seedream/api/v3/images/generations" : "/qwen/api/v1/services/aigc/multimodal-generation/generation";
    f.replies.set(path, { body: provider === "seedream"
      ? { error: { code: "OutputImageSensitiveContentDetected", message: "Image rejected" }, usage: { generated_images: 0 } }
      : { code: "DataInspectionFailed", message: "Image rejected" } });
    const handle = await f.workspace.context("book");
    f.cleanup.push(handle.close);
    await assert.rejects(generateImage(handle.ctx, imageOptions), /Image rejected/);
    const attempt = (await handle.ctx.db.get<{ status: string; cost_usd: number }>("SELECT * FROM attempts"))!;
    assert.deepEqual([attempt.status, attempt.cost_usd], ["refused", 0]);
    assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0);
  });

  test(`${provider} native errors redact credentials without relying on an sk prefix`, async (t) => {
    const f = await providerFixture(t, provider);
    const path = provider === "seedream" ? "/seedream/api/v3/images/generations" : "/qwen/api/v1/services/aigc/multimodal-generation/generation";
    f.replies.set(path, { body: provider === "seedream"
      ? { error: { code: "InvalidApiKey", message: "Invalid credential image-test-key" } }
      : { code: "InvalidApiKey", message: "Invalid credential image-test-key" } });
    const handle = await f.workspace.context("book");
    f.cleanup.push(handle.close);
    await assert.rejects(generateImage(handle.ctx, imageOptions), (error: Error) => !error.message.includes("image-test-key"));
    const attempt = (await handle.ctx.db.get<{ error: string }>("SELECT error FROM attempts"))!;
    assert.ok(!attempt.error.includes("image-test-key"));
  });
}

test("Seedream invalid image bytes retain the known per-image charge", async (t) => {
  const f = await providerFixture(t);
  f.replies.set("/seedream/api/v3/images/generations", { body: { data: [{ b64_json: "%%%invalid%%%" }], usage: { generated_images: 1 } } });
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await assert.rejects(generateImage(handle.ctx, imageOptions), /decoded/);
  const spend = (await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!;
  assert.deepEqual([spend.cost_usd, spend.estimated], [0.04, 0]);
});

test("native generated-image download failure retains spend and never repeats the paid generation", async (t) => {
  const f = await providerFixture(t, "qwen");
  f.replies.set("/generated.png", { status: 503, body: { message: "Storage unavailable" } });
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  handle.ctx.config.image.retry_backoff_sec = [0, 0];
  await assert.rejects(generateImage(handle.ctx, imageOptions), /download|decode/i);
  assert.equal(f.requests.filter((recorded) => recorded.path.endsWith("/generation")).length, 1);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0.04);
});

for (const content of [{}, [null]]) {
  for (const reported of [false, true]) {
    test(`malformed Qwen content ${JSON.stringify(content)} retains ${reported ? "known charges" : "the estimate"} without resubmitting generation`, async (t) => {
      const f = await providerFixture(t, "qwen");
      f.replies.set("/qwen/api/v1/services/aigc/multimodal-generation/generation", { body: { output: { choices: [{ message: { content } }] }, ...(reported ? { usage: { image_count: 1 } } : {}) } });
      const handle = await f.workspace.context("book");
      f.cleanup.push(handle.close);
      handle.ctx.config.image.retry_backoff_sec = [0, 0];
      await assert.rejects(generateImage(handle.ctx, imageOptions));
      const spend = (await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT * FROM spend"))!;
      assert.deepEqual([spend.cost_usd, spend.estimated], reported ? [0.04, 0] : [0.25, 1]);
      assert.equal(f.requests.length, 1);
    });
  }
}

test("per-image pricing requires reported image counts and never mistakes zero token placeholders for free images", () => {
  const pricing = { image: { per_image: 0.04 } };
  const log = () => {};
  assert.deepEqual(priceUsage(pricing, "image", { input_tokens: 0, output_tokens: 0, image_count: 2 }, 0.25, true, log), { cost: 0.08, estimated: false });
  for (const image_count of [undefined, NaN, -1]) assert.deepEqual(priceUsage(pricing, "image", { input_tokens: 0, output_tokens: 0, image_count }, 0.25, true, log), { cost: 0.25, estimated: true });
  assert.deepEqual(priceUsage(pricing, "image", undefined, 0.25, true, log), { cost: 0.25, estimated: true });
});

test("Web readiness uses project-effective per-kind key presence without exposing credentials", async (t) => {
  const f = await providerFixture(t);
  await writeFile(join(f.root, ".env"), "COMIC_TEST_TEXT_KEY=text-test-key\n");
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const workspace = await (await fetch(`${server.url}/api/workspace`)).json();
  assert.deepEqual(workspace.api_keys, { text: true, vision: false, image: false });
  assert.equal(workspace.review_required, true);
  await writeFile(join(f.root, "projects/book/project.yaml"), stringify({ image: { api_key_env: "COMIC_TEST_TEXT_KEY" }, review: { enabled: false } }));
  const response = await fetch(`${server.url}/api/projects/book`);
  const text = await response.text();
  assert.ok(!text.includes("text-test-key"));
  const project = JSON.parse(text);
  assert.deepEqual(project.api_keys, { text: true, vision: false, image: true });
  assert.equal(project.review_required, false);
  const { config } = await loadConfig(f.workspace.repository, f.root, "book");
  assert.equal(config.review.provider, "openai");
  assert.equal(config.image.provider, "seedream");
});
