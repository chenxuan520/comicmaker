import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { encodeBase64, ImageResponseError } from "../src/core/ai.js";
import { isTimeout } from "../src/core/calls.js";
import { generateImage } from "../src/core/image.js";
import { createProject } from "../src/core/project.js";
import { fixture, png } from "./helpers.js";

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "Image URL tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; });

async function imageUrlFixture(t: TestContext) {
  const requests: { path: string; query: string; method: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const replies = new Map<string, { status?: number; body: unknown }>();
  let url: string;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    const target = new URL(request.url!, "http://127.0.0.1");
    requests.push({ path: target.pathname, query: target.search, method: request.method, headers: request.headers });
    const reply = replies.get(target.pathname) ?? (target.pathname === "/download.png"
      ? { body: png }
      : { body: { data: [{ url: `${url}/download.png?token=download-signature` }] } });
    response.writeHead(reply.status ?? 200, { "Content-Type": reply.body instanceof Uint8Array ? "image/png" : "application/json" });
    response.end(reply.body instanceof Uint8Array ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const f = await fixture();
  let handle: Awaited<ReturnType<typeof f.workspace.context>> | undefined;
  t.after(async () => {
    await handle?.close(); await f.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await writeFile(join(f.root, "config.yaml"), stringify({
    openai: { base_url: `${url}/v1`, api_key_env: "COMIC_IMAGE_URL_TEST_KEY" },
    image: { timeout_sec: 5, retry_backoff_sec: [0, 0] },
    pricing: { "gpt-image-2.6-sunburst": { per_image: 0.04 } },
  }));
  await writeFile(join(f.root, ".env"), "COMIC_IMAGE_URL_TEST_KEY=image-url-test-key\n");
  await createProject(f.workspace.store, "book", "Book");
  handle = await f.workspace.context("book");
  return { ...f, ctx: handle.ctx, url, requests, replies };
}

const options = { refId: "ref", prompt: { text: "Draw the image", sources: {} }, images: [], refPaths: [], path: () => "refs/style/ref.png" };

for (const edit of [false, true]) test(`OpenAI ${edit ? "editing" : "generation"} downloads URL PNGs without forwarding credentials`, async (t) => {
  const f = await imageUrlFixture(t);
  const images = edit ? [{ data: png, name: "style.png", label: "Style" }] : [];
  const attempt = await generateImage(f.ctx, { ...options, images, refPaths: images.map((image) => image.name) });
  assert.deepEqual(await f.ctx.fs.readBytes(attempt.path!), png);
  assert.equal(attempt.cost_usd, 0.04);
  assert.deepEqual(f.requests.map((request) => request.path), [edit ? "/v1/images/edits" : "/v1/images/generations", "/download.png"]);
  assert.equal(f.requests[0].headers.authorization, "Bearer image-url-test-key");
  assert.equal(f.requests[1].headers.authorization, undefined);
  assert.equal(f.requests[1].headers.cookie, undefined);
  assert.equal(f.requests[1].query, "?token=download-signature");
  assert.equal((await f.workspace.ledger.get<{ estimated: number }>("SELECT estimated FROM spend"))!.estimated, 0);
});

test("base64 PNGs remain preferred when the response also contains a URL", async (t) => {
  const f = await imageUrlFixture(t);
  f.replies.set("/v1/images/generations", { body: { data: [{ b64_json: encodeBase64(png), url: `${f.url}/download.png` }] } });
  const attempt = await generateImage(f.ctx, options);
  assert.deepEqual(await f.ctx.fs.readBytes(attempt.path!), png);
  assert.equal(f.requests.length, 1);
});

test("URL download failures preserve known image fees and do not retry generation", async (t) => {
  const f = await imageUrlFixture(t);
  f.replies.set("/download.png", { status: 503, body: { error: "Storage unavailable" } });
  await assert.rejects(generateImage(f.ctx, options), (error: unknown) => error instanceof ImageResponseError);
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(f.requests.filter((request) => request.path === "/download.png").length, 1);
  const spend = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend");
  assert.deepEqual({ ...spend }, { cost_usd: 0.04, estimated: 0 });
});

for (const cancel of [false, true]) test(`image URL ${cancel ? "cancellation" : "timeout"} preserves the paid generation without exposing a retryable timeout`, async (t) => {
  const f = await imageUrlFixture(t);
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  const previousFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/download.png") {
      downloads++;
      if (cancel) controller.abort();
      throw Object.assign(new Error("Image request timed out"), { name: cancel ? "AbortError" : "TimeoutError" });
    }
    return previousFetch(input, init);
  };
  try {
    await assert.rejects(generateImage(f.ctx, options), (error: unknown) => error instanceof ImageResponseError && !isTimeout(error));
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(downloads, 1);
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0.04);
});

test("a downloaded non-image response is rejected without redrawing or dropping fees", async (t) => {
  const f = await imageUrlFixture(t);
  f.replies.set("/download.png", { body: { error: "Not an image" } });
  await assert.rejects(generateImage(f.ctx, options), /PNG/);
  assert.deepEqual(f.requests.map((request) => request.path), ["/v1/images/generations", "/download.png"]);
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0.04);
});

for (const imageUrl of ["file:///etc/passwd", "data:image/png;base64,AAAA", "not-a-url", "http://user:password@127.0.0.1/download.png"]) test(`non-downloadable image URL is rejected without fetching it: ${imageUrl}`, async (t) => {
  const f = await imageUrlFixture(t);
  f.replies.set("/v1/images/generations", { body: { data: [{ url: imageUrl }] } });
  await assert.rejects(generateImage(f.ctx, options), (error: unknown) => error instanceof ImageResponseError);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.workspace.ledger.get<{ cost_usd: number }>("SELECT cost_usd FROM spend"))!.cost_usd, 0.04);
});
