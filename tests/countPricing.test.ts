import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { configSchema, summarySchema, type Config } from "../schemas/index.js";
import { loadConfig } from "../src/adapters/config.js";
import { encodeBase64 } from "../src/core/ai.js";
import { priceUsage } from "../src/core/budget.js";
import { generateImage } from "../src/core/image.js";
import { structuredCall } from "../src/core/llm.js";
import { createProject } from "../src/core/project.js";
import { fixture, MockAi, png } from "./helpers.js";
import { startMockOpenai } from "./mockOpenai.js";

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "Count-pricing tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; });

const model = "gpt-image-2.6-sunburst";
const imageResponse = { data: [{ b64_json: encodeBase64(png) }] };
const imageOptions = { refId: "ref", prompt: { text: "Draw the test image", sources: {} }, images: [], refPaths: [], path: () => "refs/style/ref.png" };

async function pricedOpenai(t: TestContext, price: Config["pricing"][string], response: unknown = imageResponse, limit = 10) {
  const mock = await startMockOpenai(response);
  const f = await fixture();
  let handle: Awaited<ReturnType<typeof f.workspace.context>> | undefined;
  t.after(async () => { await handle?.close(); await f.close(); await mock.close(); });
  await writeFile(join(f.root, "config.yaml"), stringify({
    openai: { base_url: `${mock.url}/v1`, api_key_env: "COMIC_COUNT_PRICING_TEST_KEY" },
    image: { provider: "openai", model, quality: "low", timeout_sec: 5, retry_backoff_sec: [] },
    pricing: { [model]: price }, budget: { limit_usd: limit, period: "none" },
  }));
  await writeFile(join(f.root, ".env"), "COMIC_COUNT_PRICING_TEST_KEY=count-pricing-test-key\n");
  await createProject(f.workspace.store, "book", "Book");
  handle = await f.workspace.context("book");
  return { ...f, mock, ctx: handle.ctx };
}

test("per-request pricing takes precedence over image counts and token rates, including zero", () => {
  const pricing = { model: { per_request: 0.3, per_image: 0.04, input: 1, output: 2, text_in: 5, image_in: 8, image_out: 30 } };
  const usage = { input_tokens: 120, output_tokens: 20, text_input_tokens: 80, image_input_tokens: 40, image_count: 2, input_image_count: 3 };
  for (const image of [false, true]) {
    for (const value of [undefined, usage]) assert.deepEqual(priceUsage(pricing, "model", value, 0.25, image, () => {}), { cost: 0.3, estimated: false });
    assert.deepEqual(priceUsage({ model: { per_request: 0 } }, "model", undefined, 0.25, image, () => {}), { cost: 0, estimated: false });
  }
});

test("per-request rates are validated as finite nonnegative prices", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { config } = await loadConfig(f.workspace.repository, f.root);
  for (const per_request of [-1, NaN, Infinity]) assert.equal(configSchema.safeParse({ ...config, pricing: { [model]: { per_request } } }).success, false);
  assert.equal(configSchema.safeParse({ ...config, pricing: { [model]: { per_request: 0 } } }).success, true);
});

for (const withUsage of [false, true]) test(`OpenAI per-image pricing records output counts ${withUsage ? "with" : "without"} token usage`, async (t) => {
  const response = { ...imageResponse, ...(withUsage ? { usage: { input_tokens: 120, output_tokens: 20, input_tokens_details: { text_tokens: 80, image_tokens: 40 } } } : {}) };
  const f = await pricedOpenai(t, { per_image: 0.04 }, response);
  const attempt = await generateImage(f.ctx, imageOptions);
  assert.equal(attempt.cost_usd, 0.04);
  const spend = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend");
  assert.deepEqual({ ...spend }, { cost_usd: 0.04, estimated: 0 });
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].path, "/v1/images/generations");
  assert.equal(f.mock.requests[0].payload.n, 1);
});

for (const chargeInputs of [false, true]) test(`OpenAI edits ${chargeInputs ? "include configured" : "do not invent"} reference-input charges`, async (t) => {
  const price = chargeInputs ? { per_image: 0.04, per_input_image: 0.01, free_input_images: 1 } : { per_image: 0.04 };
  const f = await pricedOpenai(t, price);
  const images = ["style", "character"].map((name) => ({ data: png, name: `${name}.png`, label: name }));
  const attempt = await generateImage(f.ctx, { ...imageOptions, images, refPaths: images.map((image) => image.name) });
  assert.equal(attempt.cost_usd, chargeInputs ? 0.05 : 0.04);
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].path, "/v1/images/edits");
  assert.equal(f.mock.requests[0].files.length, 2);
  assert.ok(f.mock.requests[0].files.every((file) => Buffer.from(file.data).equals(Buffer.from(png))));
  assert.equal((await f.workspace.ledger.get<{ estimated: number }>("SELECT estimated FROM spend"))!.estimated, 0);
});

for (const perRequest of [false, true]) test(`OpenAI charges ${perRequest ? "one request" : "returned image count"} when a gateway returns multiple image entries`, async (t) => {
  const f = await pricedOpenai(t, { per_image: 0.04, ...(perRequest ? { per_request: 0.3 } : {}) }, { data: [...imageResponse.data, ...imageResponse.data] });
  const attempt = await generateImage(f.ctx, imageOptions);
  assert.equal(attempt.cost_usd, perRequest ? 0.3 : 0.08);
  assert.equal(f.mock.requests.length, 1);
});

for (const price of [{ per_request: 0.5 }, { per_image: 0.5 }, { per_image: 0.3, per_input_image: 0.2, free_input_images: 1 }]) test(`known OpenAI count pricing ${JSON.stringify(price)} blocks before a request exceeds the budget`, async (t) => {
  const f = await pricedOpenai(t, price, imageResponse, 0.49);
  const images = ["first", "second"].map((name) => ({ data: png, name: `${name}.png`, label: name }));
  await assert.rejects(generateImage(f.ctx, { ...imageOptions, images, refPaths: images.map((image) => image.name) }), (error: { code?: number }) => error.code === 3);
  assert.equal(f.mock.requests.length, 0);
  assert.equal((await f.workspace.ledger.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend"))!.n, 0);
});

test("zero per-request pricing does not fall back to the image estimate", async (t) => {
  const f = await pricedOpenai(t, { per_request: 0 }, imageResponse, 0);
  assert.equal((await generateImage(f.ctx, imageOptions)).cost_usd, 0);
  assert.equal(f.mock.requests.length, 1);
});

test("successful OpenAI responses without image bytes retain the fixed request fee", async (t) => {
  const f = await pricedOpenai(t, { per_request: 0.3 }, {});
  await assert.rejects(generateImage(f.ctx, imageOptions), /b64_json/);
  assert.deepEqual({ ...await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend") }, { cost_usd: 0.3, estimated: 0 });
  assert.equal(f.mock.requests.length, 1);
});

for (const data of [undefined, [], [{}], [null]]) test(`OpenAI per-image pricing retains an estimate when returned image entries are unreliable: ${JSON.stringify(data)}`, async (t) => {
  const f = await pricedOpenai(t, { per_image: 0.04 }, { data });
  await assert.rejects(generateImage(f.ctx, imageOptions), /b64_json/);
  assert.deepEqual({ ...await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend") }, { cost_usd: 0.04, estimated: 1 });
  assert.equal(f.mock.requests.length, 1);
});

test("OpenAI malformed generated bytes retain a known per-image fee without redrawing", async (t) => {
  const f = await pricedOpenai(t, { per_image: 0.04 }, { data: [{ b64_json: "%%%invalid%%%" }] });
  await assert.rejects(generateImage(f.ctx, imageOptions), /base64/);
  assert.deepEqual({ ...await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend") }, { cost_usd: 0.04, estimated: 0 });
  assert.equal(f.mock.requests.length, 1);
});

test("OpenAI image counts do not turn missing token usage into a free token-priced image", async (t) => {
  const f = await pricedOpenai(t, {});
  const attempt = await generateImage(f.ctx, imageOptions);
  assert.equal(attempt.cost_usd, f.ctx.config.budget.estimates.image);
  assert.equal((await f.workspace.ledger.get<{ estimated: number }>("SELECT estimated FROM spend"))!.estimated, 1);
});

for (const cancel of [false, true]) test(`${cancel ? "cancellation" : "timeout"} after invocation retains the fixed request-fee estimate`, async (t) => {
  const ai = new MockAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "Book");
  const controller = new AbortController();
  const handle = await f.workspace.context("book", { signal: controller.signal });
  t.after(async () => { await handle.close(); await f.close(); });
  handle.ctx.config.pricing[model] = { per_request: 0.4 };
  ai.onImage = () => {
    if (cancel) controller.abort();
    throw Object.assign(new Error(cancel ? "Cancelled" : "Request timed out"), { name: cancel ? "AbortError" : "APIConnectionTimeoutError" });
  };
  await assert.rejects(generateImage(handle.ctx, imageOptions));
  assert.deepEqual({ ...await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend") }, { cost_usd: 0.4, estimated: 1 });
  assert.equal(ai.imageCalls.length, 1);
});

test("structured calls use fixed per-request pricing instead of token rates", async (t) => {
  const f = await pricedOpenai(t, {});
  const textModel = f.ctx.config.models.extract;
  f.ctx.config.pricing[textModel] = { per_request: 0.3, input: 1, output: 2 };
  await structuredCall(f.ctx, { step: "prepare", template: "summary", model: textModel, schema: summarySchema, data: { chapters: [] }, estimate: 0.01 });
  assert.deepEqual({ ...await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend") }, { cost_usd: 0.3, estimated: 0 });
  assert.equal(f.mock.requests.length, 1);
});

test("structured per-request pricing is reserved before calling the model", async (t) => {
  const f = await pricedOpenai(t, {}, imageResponse, 0.29);
  const textModel = f.ctx.config.models.extract;
  f.ctx.config.pricing[textModel] = { per_request: 0.3 };
  await assert.rejects(structuredCall(f.ctx, { step: "prepare", template: "summary", model: textModel, schema: summarySchema, data: { chapters: [] }, estimate: 0.01 }), (error: { code?: number }) => error.code === 3);
  assert.equal(f.mock.requests.length, 0);
  assert.equal((await f.workspace.ledger.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend"))!.n, 0);
});
