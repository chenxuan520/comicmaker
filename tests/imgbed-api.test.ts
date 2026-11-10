import test, { after, before, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imgBedCredentials, ImgBedUploader } from "../src/adapters/imgbed.js";

const originalFetch = globalThis.fetch;
const fetchOptions: (RequestInit | undefined)[] = [];
const envNames = ["IMG_BED_TOKEN", "IMG_BED_AUTH_CODE", "CLOUDFLARE_API_TOKEN"] as const;
const originalEnv = envNames.map((name) => [name, process.env[name]] as const);
const token = "fixture-upload-token";
const authCode = "fixture-auth-code";
const bytes = new Uint8Array([0, 255, 128, 13, 10, 1, 127]);
before(() => {
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "ImgBed tests must not contact external services");
    fetchOptions.push(options);
    return originalFetch(input, options);
  };
});
beforeEach(() => {
  for (const name of envNames) delete process.env[name];
  fetchOptions.length = 0;
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

interface RecordedRequest {
  method: string | undefined; path: string; headers: IncomingHttpHeaders; fields: string[];
  files: { field: string; name: string; type: string; data: Uint8Array }[];
}
interface MockReply { status?: number; body?: unknown; raw?: string; location?: string; hold?: boolean }

async function credentialFixture(t: TestContext, text?: string) {
  const root = await mkdtemp(join(process.env.COMIC_TEST_TEMP ?? tmpdir(), "comic-imgbed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (text !== undefined) await writeFile(join(root, ".env"), text, { mode: 0o600 });
  return root;
}

async function imgBedFixture(t: TestContext, reply: MockReply = { body: { src: "/stored.png" } }) {
  const requests: RecordedRequest[] = [];
  let receive!: () => void;
  const received = new Promise<void>((resolve) => { receive = resolve; });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const recorded: RecordedRequest = { method: request.method, path: request.url!, headers: request.headers, fields: [], files: [] };
      requests.push(recorded);
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.startsWith("multipart/form-data")) {
        const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
        for (const [field, value] of form) {
          if (typeof value === "string") recorded.fields.push(field);
          else recorded.files.push({ field, name: value.name, type: value.type, data: new Uint8Array(await value.arrayBuffer()) });
        }
      }
      receive();
      if (reply.hold) return;
      response.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...(reply.location ? { Location: reply.location } : {}) });
      response.end(reply.raw ?? JSON.stringify(reply.body));
    } catch {
      receive();
      response.writeHead(400).end();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, received, reply };
}

async function rejectsPrivately(operation: Promise<unknown>, extra: string[] = []) {
  await assert.rejects(operation, (error: Error) => {
    const output = `${error.message}\n${error.stack ?? ""}\n${String(error.cause ?? "")}`;
    const forbidden = [token, authCode, "private-upstream-key", "private-upstream-body", "url-user", "url-password", ...extra];
    assert.ok(forbidden.every((value) => !output.includes(value)), "Upload errors must not expose credentials or upstream private data");
    return true;
  });
}

const dotenv = "export IMG_BED_TOKEN='dotenv-token'\r\nIMG_BED_AUTH_CODE=\"dotenv-auth\"\r\nCLOUDFLARE_API_TOKEN=dotenv-management\r\n";
for (const [name, env, text, expected] of [
  ["absent credentials", {}, undefined, { token: undefined, authCode: undefined }],
  ["environment token only without dotenv", { IMG_BED_TOKEN: token }, undefined, { token, authCode: undefined }],
  ["environment auth code only without dotenv", { IMG_BED_AUTH_CODE: authCode }, undefined, { token: undefined, authCode }],
  ["environment credentials without dotenv", { IMG_BED_TOKEN: token, IMG_BED_AUTH_CODE: authCode }, undefined, { token, authCode }],
  ["dotenv token only", {}, "IMG_BED_TOKEN=dotenv-token\n", { token: "dotenv-token", authCode: undefined }],
  ["dotenv auth code only", {}, "IMG_BED_AUTH_CODE=dotenv-auth\n", { token: undefined, authCode: "dotenv-auth" }],
  ["dotenv credentials", {}, dotenv, { token: "dotenv-token", authCode: "dotenv-auth" }],
  ["environment overrides both dotenv values", { IMG_BED_TOKEN: token, IMG_BED_AUTH_CODE: authCode }, dotenv, { token, authCode }],
  ["environment token retains dotenv auth code", { IMG_BED_TOKEN: token }, dotenv, { token, authCode: "dotenv-auth" }],
  ["environment auth code retains dotenv token", { IMG_BED_AUTH_CODE: authCode }, dotenv, { token: "dotenv-token", authCode }],
  ["empty environment values fall back independently", { IMG_BED_TOKEN: "", IMG_BED_AUTH_CODE: "" }, dotenv, { token: "dotenv-token", authCode: "dotenv-auth" }],
  ["management token is not a fallback", { CLOUDFLARE_API_TOKEN: "fixture-management-token" }, "CLOUDFLARE_API_TOKEN=dotenv-management\n", { token: undefined, authCode: undefined }],
] as const) {
  test(`ImgBed credentials: ${name}`, async (t) => {
    Object.assign(process.env, env);
    assert.deepEqual(await imgBedCredentials(await credentialFixture(t, text)), expected);
  });
}

const credentialCases = [
  { name: "token only", credentials: { token }, authorization: `Bearer ${token}`, code: undefined },
  { name: "auth code only", credentials: { authCode }, authorization: undefined, code: authCode },
  { name: "token wins over auth code", credentials: { token, authCode }, authorization: `Bearer ${token}`, code: undefined },
] as const;
for (const { name, credentials, authorization, code } of credentialCases) {
  test(`ImgBed multipart upload with ${name}`, async (t) => {
    const f = await imgBedFixture(t);
    const uploader = new ImgBedUploader({ baseURL: `${f.url}/bed///`, ...credentials });
    for (const [relPath, mime, filename] of [
      ["chapters/007/export/p03.jpg", "image/jpeg", "p03.jpg"],
      ["chapters/007/export/p03.png", "image/png", "p03.png"],
      ["chapters/第七章/export/第3页.png", "image/png", undefined],
    ] as const) {
      assert.equal(await uploader.upload(relPath, bytes), `${f.url}/stored.png`);
      const request = f.requests.at(-1)!;
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/bed/upload?returnFormat=full&responseFormat=object&serverCompress=false");
      assert.equal(request.headers.authorization, authorization);
      assert.equal(request.headers.authcode, code);
      assert.match(request.headers["content-type"]!, /^multipart\/form-data; boundary=/);
      assert.deepEqual(request.fields, []);
      assert.equal(request.files.length, 1);
      const file = request.files[0];
      assert.equal(file.field, "file");
      assert.equal(file.type, mime);
      assert.deepEqual(file.data, bytes);
      if (filename) assert.equal(file.name, filename);
      else {
        assert.match(file.name, /^[\x20-\x7e]+\.png$/);
        assert.doesNotMatch(file.name, /[\\/"\r\n]|chapters|export/);
      }
      assert.equal(fetchOptions.at(-1)?.redirect, "error");
      assert.ok(fetchOptions.at(-1)?.signal instanceof AbortSignal);
    }
    assert.equal(f.requests.length, 3);
    assert.equal(fetchOptions.length, 3);
  });
}

for (const [name, padded] of [["trailing", `${authCode} `], ["leading", ` ${authCode}`]] as const) {
  test(`ImgBed normalizes ${name} auth code whitespace and rejects reflected credentials privately`, async (t) => {
    const credentials = await imgBedCredentials(await credentialFixture(t, `IMG_BED_AUTH_CODE='${padded}'\n`));
    assert.deepEqual(credentials, { token: undefined, authCode: padded });
    const f = await imgBedFixture(t, { body: { src: `/file/page.jpg?authCode=${authCode}` } });
    await rejectsPrivately(new ImgBedUploader({ baseURL: f.url, ...credentials }).upload("page.jpg", bytes));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].headers.authcode, authCode);
    assert.equal(f.requests[0].headers.authorization, undefined);
    assert.equal(fetchOptions.length, 1);
    assert.deepEqual(fetchOptions[0]?.headers, { authCode });
  });
}

for (const [name, padded] of [["trailing", `${token} `], ["leading", ` ${token}`]] as const) {
  test(`ImgBed normalizes ${name} token whitespace and rejects reflected credentials privately`, async (t) => {
    const credentials = await imgBedCredentials(await credentialFixture(t, `IMG_BED_TOKEN='${padded}'\nIMG_BED_AUTH_CODE=' ${authCode} '\n`));
    assert.deepEqual(credentials, { token: padded, authCode: ` ${authCode} ` });
    const f = await imgBedFixture(t, { body: { publicUrl: `/file/page.jpg?token=${token}` } });
    await rejectsPrivately(new ImgBedUploader({ baseURL: f.url, ...credentials }).upload("page.jpg", bytes));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(f.requests[0].headers.authcode, undefined);
    assert.equal(fetchOptions.length, 1);
    assert.deepEqual(fetchOptions[0]?.headers, { Authorization: `Bearer ${token}` });
  });
}

test("ImgBed falls back from a whitespace-only token to a normalized auth code", async (t) => {
  const f = await imgBedFixture(t);
  const uploader = new ImgBedUploader({ baseURL: f.url, token: " \t ", authCode: ` ${authCode} ` });
  assert.equal(await uploader.upload("page.png", bytes), `${f.url}/stored.png`);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers.authcode, authCode);
  assert.equal(fetchOptions.length, 1);
  assert.deepEqual(fetchOptions[0]?.headers, { authCode });
});

test("ImgBed rejects whitespace-only credentials before requesting", async (t) => {
  const f = await imgBedFixture(t);
  await rejectsPrivately(new ImgBedUploader({ baseURL: f.url, token: " \t ", authCode: "\t " }).upload("page.png", bytes));
  assert.equal(f.requests.length, 0);
  assert.equal(fetchOptions.length, 0);
});

test("ImgBed rejects missing credentials before requesting, without management-token fallback", async (t) => {
  process.env.CLOUDFLARE_API_TOKEN = "fixture-management-token";
  const f = await imgBedFixture(t);
  for (const credentials of [{}, { token: "", authCode: "" }]) {
    await assert.rejects(new ImgBedUploader({ baseURL: f.url, ...credentials }).upload("page.png", bytes));
  }
  assert.equal(f.requests.length, 0);
  assert.equal(fetchOptions.length, 0);
});

test("ImgBed decodes object and first-item array responses and resolves public links", async (t) => {
  const f = await imgBedFixture(t);
  const uploader = new ImgBedUploader({ baseURL: f.url, token });
  const cases = [
    [{ publicUrl: `${f.url}/public.png`, src: "/ignored.png" }, `${f.url}/public.png`],
    [{ publicUrl: "https://127.0.0.1/public.png" }, "https://127.0.0.1/public.png"],
    [{ src: "/root/page.png" }, `${f.url}/root/page.png`],
    [{ src: "relative/page.png" }, `${f.url}/relative/page.png`],
    [{ publicUrl: "", src: "/fallback.png" }, `${f.url}/fallback.png`],
    [{ publicUrl: 42, src: "/typed-fallback.png" }, `${f.url}/typed-fallback.png`],
    [[{ src: "/legacy.png" }, { publicUrl: "/ignored.png" }], `${f.url}/legacy.png`],
    [[{ publicUrl: "/legacy-public.png", src: "/ignored.png" }], `${f.url}/legacy-public.png`],
  ] as const;
  for (const [body, expected] of cases) {
    f.reply.body = body;
    assert.equal(await uploader.upload("page.png", bytes), expected);
  }
  assert.equal(f.requests.length, cases.length);
  assert.equal(fetchOptions.length, cases.length);
});

test("ImgBed accepts a public hostname that coincides with the auth code rather than treating it as a credential query", async (t) => {
  const f = await imgBedFixture(t);
  const uploader = new ImgBedUploader({ baseURL: f.url, authCode: "127.0.0.1" });
  assert.equal(await uploader.upload("page.png", bytes), `${f.url}/stored.png`);
});

const invalidReplies: [string, MockReply][] = [
  ["empty body", { raw: "" }],
  ["malformed JSON", { raw: '{"message":"private-upstream-key",broken' }],
  ["null", { body: null }], ["non-object", { body: "not an object" }],
  ["missing link", { body: {} }], ["empty array", { body: [] }],
  ["invalid first array item", { body: [{}, { src: "/must-not-use.png" }] }],
  ["null first array item", { body: [null, { src: "/must-not-use.png" }] }],
  ["empty links", { body: { publicUrl: "", src: "" } }],
  ["whitespace link", { body: { src: "  " } }],
  ["non-string links", { body: { publicUrl: 42, src: false } }],
  ["invalid preferred link", { body: { publicUrl: "ftp://127.0.0.1/mock.png", src: "/must-not-use.png" } }],
  ["credential-bearing link", { body: { publicUrl: `/file/mock.png?token=${token}` } }],
  ...["file:///mock.png", "data:image/png;base64,AA==", "javascript:void(0)", "ftp://127.0.0.1/mock.png", "http://[", "http://url-user:url-password@127.0.0.1/mock.png", "http://url-user@127.0.0.1/mock.png"]
    .map((src, index): [string, MockReply] => [`invalid URL ${index + 1}`, { body: { src } }]),
];
for (const [name, reply] of invalidReplies) {
  test(`ImgBed rejects ${name} without retrying or exposing private data`, async (t) => {
    const f = await imgBedFixture(t, reply);
    await rejectsPrivately(new ImgBedUploader({ baseURL: f.url, token }).upload("page.png", bytes));
    assert.equal(f.requests.length, 1);
    assert.equal(fetchOptions.length, 1);
  });
}

for (const status of [401, 500]) for (const { name, credentials } of credentialCases) {
  test(`ImgBed ${status} with ${name} does not echo upstream bodies or retry`, async (t) => {
    const f = await imgBedFixture(t, { status, body: { error: { message: `private-upstream-body ${token} ${authCode} private-upstream-key` } } });
    await rejectsPrivately(new ImgBedUploader({ baseURL: f.url, ...credentials }).upload("page.png", bytes));
    assert.equal(f.requests.length, 1);
    assert.equal(fetchOptions.length, 1);
  });
}

for (const status of [302, 307, 308]) for (const { name, credentials } of credentialCases) {
  test(`ImgBed ${status} with ${name} never follows redirects or leaks their targets`, async (t) => {
    const target = await imgBedFixture(t);
    const location = `${target.url}/capture?private-upstream-key=${authCode}`;
    const source = await imgBedFixture(t, { status, location });
    await rejectsPrivately(new ImgBedUploader({ baseURL: source.url, ...credentials }).upload("page.png", bytes), [location]);
    assert.equal(source.requests.length, 1);
    assert.equal(target.requests.length, 0);
    assert.equal(fetchOptions.length, 1);
  });
}

for (const cancellation of ["caller", "timeout"] as const) {
  test(`ImgBed in-flight ${cancellation} cancellation settles without retrying`, { timeout: 5000 }, async (t) => {
    const f = await imgBedFixture(t, { hold: true });
    const caller = new AbortController();
    const deadline = new AbortController();
    t.after(() => { caller.abort(); deadline.abort(); });
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 120_000);
      return deadline.signal;
    });
    const settled = assert.rejects(new ImgBedUploader({ baseURL: f.url, authCode }).upload("page.png", bytes, caller.signal));
    await f.received;
    (cancellation === "caller" ? caller : deadline).abort();
    await settled;
    assert.equal(f.requests.length, 1);
    assert.equal(fetchOptions.length, 1);
  });
}

test("ImgBed does not send a pre-aborted upload", { timeout: 5000 }, async (t) => {
  const f = await imgBedFixture(t);
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(new ImgBedUploader({ baseURL: f.url, token }).upload("page.png", bytes, caller.signal));
  assert.equal(f.requests.length, 0);
  assert.ok(fetchOptions.length <= 1);
});
