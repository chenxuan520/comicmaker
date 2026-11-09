import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startServer, type Job } from "../src/adapters/server.js";
import { LocalTemplateStore } from "../src/adapters/templates.js";
import { fixture, MockAi } from "./helpers.js";

const project = "safety";
const novel = "第一章 初遇\n张三在街头遇见李四。\n第二章 重逢\n张三和李四再次相见。\n";
const replacement = "第一章 新篇\n李四独自离开了小镇。\n";
const options = { timeout: 10_000 };
type Server = Awaited<ReturnType<typeof startServer>>;
type Studio = Awaited<ReturnType<typeof studio>>;
type Mutation = { method: "POST" | "PUT"; path: string; body: string; status: number };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for server test")), 5_000);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("Server state did not settle");
}

async function json(server: Pick<Server, "url">, path: string, init: RequestInit = {}) {
  const response = await fetch(`${server.url}${path}`, init);
  return { status: response.status, data: await response.json() };
}

async function idleJson(server: Pick<Server, "url">, path: string, init: RequestInit) {
  return eventually(async () => {
    const response = await json(server, path, init);
    return response.status === 409 && response.data.error?.message === "Another workspace mutation is running; wait until it finishes" ? undefined : response;
  });
}

function post(input: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) };
}

function put(yaml: string): RequestInit {
  return { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yaml }) };
}

async function studio(t: TestContext, ai = new MockAi(), release?: () => void) {
  const f = await fixture(ai);
  const pending: ClientRequest[] = [];
  let server: Server | undefined;
  t.after(async () => {
    release?.();
    for (const client of pending) client.destroy();
    try { if (server?.server.listening) await server.close(); }
    finally { await f.close(); }
  });
  server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  const result = { ...f, ...server, ai, pending };
  const created = await json(result, "/api/projects", post({ id: project, title: "Safety" }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return result;
}

async function seed(server: Server) {
  const imported = await idleJson(server, `/api/projects/${project}/import`, { method: "POST", body: novel });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const other = await idleJson(server, "/api/projects", post({ id: "other", title: "Other" }));
  assert.equal(other.status, 201, JSON.stringify(other.data));
}

async function slowBody(server: Studio, mutation: Pick<Mutation, "path" | "method" | "body">, headers: Record<string, string> = {}) {
  const accepted = once(server.server, "request");
  const bytes = Buffer.from(mutation.body);
  let client!: ClientRequest;
  const result = new Promise<Awaited<ReturnType<typeof json>>>((resolve, reject) => {
    client = request(`${server.url}${mutation.path}`, {
      method: mutation.method, agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": bytes.length, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    client.on("error", reject);
  });
  void result.catch(() => undefined);
  server.pending.push(client);
  const split = Math.floor(bytes.length / 2);
  client.flushHeaders();
  client.write(bytes.subarray(0, split));
  await within(accepted);
  return { client, result, finish: () => client.end(bytes.subarray(split)) };
}

function heldAi() {
  const ai = new MockAi();
  const entered = deferred();
  const release = deferred();
  const structured = ai.structured.bind(ai);
  ai.structured = async (input) => {
    entered.resolve();
    await release.promise;
    return structured(input);
  };
  return { ai, entered: entered.promise, release: release.resolve };
}

async function finished(server: Server): Promise<Job> {
  return eventually(async () => {
    const current = await json(server, "/api/jobs/current");
    assert.equal(current.status, 200);
    const job = current.data.job as Job | null;
    return job && job.status !== "running" ? job : undefined;
  });
}

const mutations = [
  { name: "forced upload", build: () => ({ method: "POST", path: `/api/projects/${project}/import?force=true`, body: replacement, status: 200 }) },
  { name: "project creation", build: () => ({ method: "POST", path: "/api/projects", body: JSON.stringify({ id: "created", title: "Created" }), status: 201 }) },
  { name: "workspace config", build: () => ({ method: "PUT", path: "/api/config", body: JSON.stringify({ yaml: "web:\n  max_upload_mb: 8\n" }), status: 200 }) },
  { name: "project config", build: () => ({ method: "PUT", path: `/api/config?project=${project}`, body: JSON.stringify({ yaml: `id: ${project}\ntitle: Updated\n` }), status: 200 }) },
  { name: "project prompt", build: async (server: Studio) => {
    const store = new LocalTemplateStore(server.workspace.repository, server.root, project);
    const template = (await store.list())[0]!;
    return {
      method: "PUT", path: `/api/projects/${project}/prompts/${template.name.split("/").map(encodeURIComponent).join("/")}`,
      body: JSON.stringify({ content: template.content }), status: 200,
    };
  } },
] satisfies { name: string; build: (server: Studio) => Mutation | Promise<Mutation> }[];

for (const mutation of mutations) {
  test(`${mutation.name} reserves the workspace before its body finishes`, options, async (t) => {
    const server = await studio(t);
    await seed(server);
    const input = await mutation.build(server);
    const pending = await slowBody(server, input);
    for (const id of [project, "other"]) {
      const action = await json(server, `/api/projects/${id}/actions`, post({ action: "prepare" }));
      assert.equal(action.status, 409, JSON.stringify(action.data));
      assert.equal(action.data.error.code, 2);
    }
    const competing = await json(server, "/api/projects", post({ id: "competing", title: "Competing" }));
    assert.equal(competing.status, 409);
    const current = await json(server, "/api/jobs/current");
    assert.equal(current.status, 200);
    assert.equal(current.data.job, null);
    assert.equal(server.ai.structuredCalls.length, 0);
    pending.finish();
    const response = await within(pending.result);
    assert.equal(response.status, input.status, JSON.stringify(response.data));
    if (mutation.name === "forced upload") {
      const imported = await json(server, `/api/projects/${project}`);
      assert.equal(imported.status, 200);
      assert.equal(imported.data.chapters.length, 1);
    }
    assert.equal((await idleJson(server, "/api/projects", post({ id: "after", title: "After" }))).status, 201);
  });

  test(`${mutation.name} rejects before reading its body while prepare runs`, options, async (t) => {
    const block = heldAi();
    const server = await studio(t, block.ai, block.release);
    await seed(server);
    const input = await mutation.build(server);
    const action = await json(server, `/api/projects/${project}/actions`, post({ action: "prepare" }));
    assert.equal(action.status, 202, JSON.stringify(action.data));
    await within(block.entered);
    const before = await json(server, `/api/projects/${project}`);
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.ok(Array.isArray(before.data.chapters));
    assert.equal(before.data.chapters.length, 2);
    const pending = await slowBody(server, input);
    const response = await within(pending.result);
    assert.equal(response.status, 409, JSON.stringify(response.data));
    assert.equal(response.data.error.details?.job_id, action.data.job.id, JSON.stringify(response.data));
    pending.client.destroy();
    const after = await json(server, `/api/projects/${project}`);
    assert.equal(after.status, 200, JSON.stringify(after.data));
    assert.deepEqual(after.data.chapters, before.data.chapters);
    const cancelled = await json(server, `/api/jobs/${action.data.job.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    block.release();
    const terminal = await finished(server);
    assert.equal(terminal.status, "cancelled", JSON.stringify(terminal));
    assert.ok(terminal.finished_at);
    assert.ok(Array.isArray(terminal.events));
    const retry = await json(server, input.path, { method: input.method, body: input.body });
    assert.equal(retry.status, input.status, JSON.stringify(retry.data));
  });
}

test("an action checks the gate after parsing its delayed body", options, async (t) => {
  const server = await studio(t);
  await seed(server);
  const action = await slowBody(server, { method: "POST", path: `/api/projects/${project}/actions`, body: JSON.stringify({ action: "prepare" }) });
  const upload = await slowBody(server, { method: "POST", path: `/api/projects/${project}/import?force=true`, body: replacement });
  action.finish();
  assert.equal((await within(action.result)).status, 409);
  upload.finish();
  assert.equal((await within(upload.result)).status, 200);
  assert.equal((await json(server, "/api/jobs/current")).data.job, null);
});

test("a delayed action body does not reserve the mutation gate", options, async (t) => {
  const block = heldAi();
  const server = await studio(t, block.ai, block.release);
  await seed(server);
  const action = await slowBody(server, { method: "POST", path: `/api/projects/${project}/actions`, body: JSON.stringify({ action: "prepare" }) });
  assert.equal((await json(server, "/api/projects", post({ id: "before-action", title: "Before" }))).status, 201);
  action.finish();
  const response = await within(action.result);
  assert.equal(response.status, 202, JSON.stringify(response.data));
  await within(block.entered);
  assert.equal((await json(server, `/api/jobs/${response.data.job.id}/cancel`, { method: "POST" })).status, 200);
  block.release();
  assert.equal((await finished(server)).status, "cancelled");
});

test("the mutation gate stays held through commit", options, async (t) => {
  const release = deferred();
  const entered = deferred();
  const server = await studio(t, new MockAi(), release.resolve);
  const select = server.workspace.selectProject.bind(server.workspace);
  server.workspace.selectProject = async (id) => {
    await select(id);
    entered.resolve();
    await release.promise;
  };
  const creation = json(server, "/api/projects", post({ id: "committing", title: "Committing" }));
  await within(entered.promise);
  assert.equal((await json(server, `/api/projects/${project}/actions`, post({ action: "prepare" }))).status, 409);
  assert.equal((await json(server, "/api/projects", post({ id: "interleaved", title: "Interleaved" }))).status, 409);
  release.resolve();
  assert.equal((await creation).status, 201);
});

for (const cancel of [false, true]) {
  test(cancel ? "cancellation remains effective during job context cleanup" : "the job gate stays held until its context closes", options, async (t) => {
    const release = deferred();
    const entered = deferred();
    const ai = new MockAi();
    ai.structured = async () => { throw new Error("Mock generation failure"); };
    const server = await studio(t, ai, release.resolve);
    await seed(server);
    const context = server.workspace.context.bind(server.workspace);
    server.workspace.context = async (id, settings) => {
      const handle = await context(id, settings);
      if (!settings?.signal) return handle;
      const close = handle.close.bind(handle);
      return { ...handle, close: async () => { entered.resolve(); await release.promise; await close(); } };
    };
    const action = await json(server, `/api/projects/${project}/actions`, post({ action: "prepare" }));
    assert.equal(action.status, 202);
    await within(entered.promise);
    assert.equal((await json(server, "/api/jobs/current")).data.job.status, "running");
    assert.equal((await json(server, "/api/projects", post({ id: "during-close", title: "During close" }))).status, 409);
    if (cancel) assert.equal((await json(server, `/api/jobs/${action.data.job.id}/cancel`, { method: "POST" })).status, 200);
    release.resolve();
    const terminal = await finished(server);
    assert.equal(terminal.status, cancel ? "cancelled" : "failed");
    assert.match(terminal.error!.message, /Mock generation failure/);
    assert.equal((await json(server, "/api/projects", post({ id: "after-close", title: "After close" }))).status, 201);
  });
}

test("failed and aborted request bodies release the mutation gate", options, async (t) => {
  const server = await studio(t);
  const invalid = await json(server, "/api/projects", { method: "POST", body: "{" });
  assert.equal(invalid.status, 400);
  const pending = await slowBody(server, { method: "POST", path: `/api/projects/${project}/import?force=true`, body: replacement });
  pending.client.destroy();
  await assert.rejects(pending.result);
  await eventually(async () => {
    const response = await json(server, "/api/projects", post({ id: "after-abort", title: "After abort" }));
    if (response.status === 201) return response;
    assert.equal(response.status, 409, JSON.stringify(response.data));
    return undefined;
  });
});

test("shutdown drains a stalled mutation and closes its context", options, async (t) => {
  const server = await studio(t);
  const opened = deferred();
  let contextClosed = false;
  const context = server.workspace.context.bind(server.workspace);
  server.workspace.context = async (id, settings) => {
    const handle = await context(id, settings);
    const close = handle.close.bind(handle);
    opened.resolve();
    return { ...handle, close: async () => { await close(); contextClosed = true; } };
  };
  const pending = await slowBody(server, { method: "POST", path: `/api/projects/${project}/import?force=true`, body: replacement });
  await within(opened.promise);
  const closed = server.close();
  await assert.rejects(pending.result);
  await within(closed);
  assert.equal(server.server.listening, false);
  assert.equal(contextClosed, true);
});

test("raw project config remains readable and repairable after a valid workspace update", options, async (t) => {
  const server = await studio(t);
  const initial = await json(server, "/api/config");
  assert.equal(initial.status, 200);
  const { min_panels: min, max_panels: max } = initial.data.merged.storyboard;
  assert.ok(max > min);
  const original = `id: ${project}\ntitle: Original\nstoryboard:\n  min_panels: ${max}\n`;
  assert.equal((await idleJson(server, `/api/config?project=${project}`, put(original))).status, 200);
  const workspace = await idleJson(server, "/api/config", put(`storyboard:\n  max_panels: ${min}\n`));
  assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
  assert.equal(workspace.data.validation_error, undefined);
  const invalid = await json(server, `/api/config?project=${project}`);
  assert.equal(invalid.status, 200, JSON.stringify(invalid.data));
  assert.equal(invalid.data.yaml, original);
  assert.equal(invalid.data.merged, null);
  assert.deepEqual(invalid.data.sources, {});
  assert.equal(typeof invalid.data.validation_error.message, "string");
  assert.equal(invalid.data.validation_error.code, 1);
  const rejected = await idleJson(server, `/api/config?project=${project}`, put(`id: ${project}\nstoryboard:\n  min_panels: ${max + 1}\n`));
  assert.equal(rejected.status, 400);
  assert.equal((await json(server, `/api/config?project=${project}`)).data.yaml, original);
  const corrective = `id: ${project}\ntitle: Repaired\nstoryboard:\n  min_panels: ${min}\n`;
  const repaired = await idleJson(server, `/api/config?project=${project}`, put(corrective));
  assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
  assert.equal(repaired.data.yaml, corrective);
  assert.equal(repaired.data.merged.storyboard.min_panels, min);
  assert.equal(repaired.data.merged.storyboard.max_panels, min);
  assert.equal(repaired.data.validation_error, undefined);
  assert.ok(Object.keys(repaired.data.sources).length > 0);
  const reread = await json(server, `/api/config?project=${project}`);
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.data, repaired.data);
});

test("project config repair responses do not mask workspace validation errors", options, async (t) => {
  const server = await studio(t);
  await writeFile(join(server.root, "config.yaml"), "storyboard:\n  min_panels: 8\n  max_panels: 2\n", "utf8");
  for (const path of ["/api/config", `/api/config?project=${project}`]) {
    const response = await json(server, path);
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.equal(response.data.error.code, 1);
    assert.equal(response.data.validation_error, undefined);
  }
});

test("missing static files return 404 rather than the application HTML", options, async (t) => {
  const server = await studio(t);
  for (const path of ["/assets/not-present.js", "/robots.txt", "/llms.txt", "/ai-catalog.json"]) {
    const response = await json(server, path);
    assert.equal(response.status, 404);
    assert.equal(response.data.error.message, "Asset not found");
  }
});

test("loopback, same-origin and private-file restrictions remain enforced", options, async (t) => {
  const server = await studio(t);
  await assert.rejects(startServer(server.workspace, { host: "0.0.0.0", port: 0 }), /loopback/);
  const deniedHeaders: Record<string, string>[] = [{ Host: "example.com" }, { Origin: "http://127.0.0.1:1" }];
  for (const headers of deniedHeaders) {
    const pending = await slowBody(server, { method: "POST", path: "/api/projects", body: JSON.stringify({ id: "denied", title: "Denied" }) }, headers);
    pending.finish();
    assert.equal((await within(pending.result)).status, 403);
  }
  const accepted = await json(server, "/api/projects", { ...post({ id: "allowed", title: "Allowed" }), headers: { Origin: server.url } });
  assert.equal(accepted.status, 201);
  for (const path of ["project.yaml", "chapters/1/raw.txt"]) {
    assert.equal((await json(server, `/api/projects/${project}/files/${path}`)).status, 409);
  }
});
