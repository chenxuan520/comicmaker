import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import { configSchema } from "../../schemas/index.js";
import { budgetReport } from "../core/budget.js";
import { ComicError, errorInfo, PreconditionError } from "../core/errors.js";
import { createProject, importNovel } from "../core/project.js";
import { runChapter } from "../core/pipeline.js";
import { getStatus } from "../core/status.js";
import { adaptChapter } from "../core/steps/adapt.js";
import { exportChapter } from "../core/steps/export.js";
import { prepareBook } from "../core/steps/prepare.js";
import { generateRefs, lockRef } from "../core/steps/refs.js";
import { redoPage, renderChapter } from "../core/steps/render.js";
import { apiKey, loadConfig, mergeConfig, parseConfigYaml, validateConfig } from "./config.js";
import { exportFont, WorkspaceRuntime } from "./runtime.js";
import { LocalTemplateStore } from "./templates.js";

const actionSchema = z.object({
  action: z.enum(["prepare", "refs", "lock", "adapt", "render", "run", "export", "redo"]),
  chapter: z.number().int().positive().optional(), kind: z.enum(["style", "outfit", "location"]).optional(),
  target: z.string().optional(), ref_id: z.string().optional(), page_id: z.string().optional(),
  note: z.string().optional(), force: z.boolean().optional(), ignore_limit: z.boolean().optional(),
}).strict();
type Action = z.infer<typeof actionSchema>;
export interface Job {
  id: string;
  project_id: string;
  action: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: ReturnType<typeof errorInfo>;
  events: { time: string; level: string; message: string; details?: unknown }[];
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ComicError("Upload exceeds web.max_upload_mb", 1);
    chunks.push(new Uint8Array(chunk));
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".ico": "image/x-icon", ".woff2": "font/woff2" };

export async function startServer(workspace: WorkspaceRuntime, options: { host: string; port: number }) {
  if (!["127.0.0.1", "localhost", "::1"].includes(options.host)) throw new PreconditionError("Web studio only supports loopback hosts");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new PreconditionError("Invalid server port");
  let job: Job | null = null;
  let jobController: AbortController | undefined;
  let running: Promise<void> = Promise.resolve();
  let mutationBusy = false;
  let mutationRequest: IncomingMessage | undefined;
  let mutationDone: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  const idle = () => {
    if (shuttingDown) throw new PreconditionError("Server is shutting down");
    if (job?.status === "running") throw new PreconditionError("Another generation is running; wait or cancel it first", { job_id: job.id });
    if (mutationBusy) throw new PreconditionError("Another workspace mutation is running; wait until it finishes");
  };
  const requireField = <T>(value: T | undefined, name: string): T => { if (value === undefined || value === "") throw new PreconditionError(`${name} is required`); return value; };
  const startJob = (projectId: string, action: Action): Job => {
    idle();
    const active: Job = { id: ulid(), project_id: projectId, action: action.action, status: "running", started_at: new Date().toISOString(), events: [] };
    job = active;
    jobController = new AbortController();
    const signal = jobController.signal;
    running = (async () => {
      let handle: Awaited<ReturnType<WorkspaceRuntime["context"]>> | undefined;
      let status: Job["status"] = "running";
      try {
        handle = await workspace.context(projectId, { ignoreLimit: action.ignore_limit, signal, log: (level, message, details) => active.events.push({ time: new Date().toISOString(), level, message, details }) });
        const ctx = handle.ctx;
        switch (action.action) {
          case "prepare": active.result = await prepareBook(ctx, { force: action.force }); break;
          case "refs": active.result = await generateRefs(ctx, { kind: requireField(action.kind, "kind"), target: action.target, force: action.force }); break;
          case "lock": active.result = await lockRef(ctx, requireField(action.ref_id, "ref_id")); break;
          case "adapt": active.result = await adaptChapter(ctx, requireField(action.chapter, "chapter"), { force: action.force }); break;
          case "render": active.result = await renderChapter(ctx, requireField(action.chapter, "chapter"), { force: action.force }); break;
          case "run": active.result = await runChapter(ctx, requireField(action.chapter, "chapter"), { force: action.force, font: await exportFont(ctx, workspace.root) }); break;
          case "export": active.result = await exportChapter(ctx, requireField(action.chapter, "chapter"), { force: action.force, font: await exportFont(ctx, workspace.root) }); break;
          case "redo": active.result = await redoPage(ctx, requireField(action.page_id, "page_id"), action.note); break;
        }
        status = signal.aborted ? "cancelled" : "completed";
      } catch (error) {
        active.error = errorInfo(error);
        status = signal.aborted ? "cancelled" : "failed";
      } finally {
        try { await handle?.close(); if (signal.aborted) status = "cancelled"; }
        catch (error) { active.error = errorInfo(error); status = "failed"; }
        active.status = status;
        active.finished_at = new Date().toISOString();
      }
    })();
    return active;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    let finishMutation: (() => void) | undefined;
    let pendingReply: { status: number; value: unknown } | undefined;
    const replyJson = (status: number, value: unknown) => {
      if (finishMutation) pendingReply = { status, value };
      else sendJson(response, status, value);
    };
    try {
      const host = request.headers.host ?? "";
      const hostName = new URL(`http://${host}`).hostname;
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName) || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        replyJson(403, { error: { message: "Only same-origin local access is allowed", code: 1 } }); return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if ((request.method === "POST" || request.method === "PUT")
        && !(parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "actions")
        && !(parts[0] === "api" && parts[1] === "jobs" && parts[3] === "cancel")) {
        idle();
        mutationBusy = true;
        mutationRequest = request;
        mutationDone = new Promise<void>((resolve) => { finishMutation = resolve; });
      }
      const loaded = await loadConfig(workspace.repository, workspace.root);
      const limit = loaded.config.web.max_upload_mb * 1024 * 1024;
      const jsonBody = async () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await body(request, limit)));
      if (request.method === "GET" && url.pathname === "/api/workspace") {
        replyJson(200, { projects: await workspace.store.list(), current_project: await workspace.currentProject(), api_key_configured: Boolean(await apiKey(workspace.root, loaded.config)), workspace_path: workspace.root, settings: { poll_interval_ms: loaded.config.web.poll_interval_ms }, job }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/budget") { replyJson(200, await budgetReport(workspace.ledger, loaded.config.budget)); return; }
      if (url.pathname === "/api/jobs/current" && request.method === "GET") { replyJson(200, { job }); return; }
      if (parts[0] === "api" && parts[1] === "jobs" && parts[3] === "cancel" && request.method === "POST") {
        if (job?.id !== parts[2] || job.status !== "running") throw new PreconditionError("This job is not running");
        jobController!.abort(new Error("Cancelled; progress saved"));
        replyJson(200, { job }); return;
      }
      if (url.pathname === "/api/projects" && request.method === "POST") {
        const input = z.object({ id: z.string(), title: z.string(), style: z.string().optional() }).strict().parse(await jsonBody());
        const project = await createProject(workspace.store, input.id, input.title, input.style);
        await workspace.selectProject(input.id);
        replyJson(201, project); return;
      }
      if (url.pathname === "/api/config") {
        const id = url.searchParams.get("project") ?? undefined;
        const handle = id ? await workspace.store.open(id) : undefined;
        try {
          if (request.method === "PUT") {
            const input = z.object({ yaml: z.string() }).strict().parse(await jsonBody());
            const value = parseConfigYaml(input.yaml);
            if (id && value.id !== undefined && value.id !== id) throw new PreconditionError("Project ID cannot be changed through configuration");
            validateConfig(configSchema.parse(id ? mergeConfig(loaded.defaults, loaded.workspaceRaw, value) : mergeConfig(loaded.defaults, value)));
            if (id) {
              await handle!.fs.writeText("project.yaml", input.yaml);
              if (typeof value.title === "string") await handle!.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('title', ?)", [value.title]);
            }
            else {
              await writeFile(join(workspace.root, "config.yaml"), input.yaml, "utf8");
            }
          } else if (request.method !== "GET") throw new PreconditionError("Unsupported method");
          const yaml = id ? await handle!.fs.readText("project.yaml") : await readFile(join(workspace.root, "config.yaml"), "utf8");
          if (id && request.method === "GET") {
            try { validateConfig(configSchema.parse(mergeConfig(loaded.defaults, loaded.workspaceRaw, parseConfigYaml(yaml ?? "")))); }
            catch (error) {
              replyJson(200, { yaml, merged: null, sources: {}, validation_error: errorInfo(error) }); return;
            }
          }
          const current = await loadConfig(workspace.repository, workspace.root, id);
          replyJson(200, { yaml, merged: current.config, sources: current.sources }); return;
        } finally { await handle?.db.close(); }
      }
      if (parts[0] === "api" && parts[1] === "projects" && parts[2]) {
        const id = parts[2];
        if (parts[3] === "actions" && request.method === "POST") { replyJson(202, { job: startJob(id, actionSchema.parse(await jsonBody())) }); return; }
        const handle = await workspace.context(id);
        try {
          if (parts.length === 3 && request.method === "GET") {
            const status = await getStatus(handle.ctx);
            const fileUrl = (path: string) => `/api/projects/${encodeURIComponent(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
            replyJson(200, { ...status, pages: status.pages.map((page) => ({ ...page, image_url: page.image_path ? `${fileUrl(page.image_path)}?attempt=${page.final_attempt_id}` : null })), refs: status.refs.map((ref) => ({ ...ref, image_url: fileUrl(ref.path!) })) }); return;
          }
          if (parts[3] === "import" && request.method === "POST") {
            replyJson(200, await importNovel(handle.ctx, await body(request, limit), { force: url.searchParams.get("force") === "true" })); return;
          }
          if (parts[3] === "prompts") {
            const store = new LocalTemplateStore(workspace.repository, workspace.root, id);
            if (parts.length === 4 && request.method === "GET") { replyJson(200, { templates: await store.list() }); return; }
            if (request.method === "PUT" && parts.length > 4) {
              const input = z.object({ content: z.string() }).strict().parse(await jsonBody());
              const name = parts.slice(4).join("/");
              await store.put(name, input.content, "project");
              replyJson(200, await store.get(name)); return;
            }
          }
          if (parts[3] === "files" && request.method === "GET") {
            const path = parts.slice(4).join("/");
            if (!/^(?:refs\/.+\.png|chapters\/\d+\/(?:pages|attempts)\/.+\.png|chapters\/\d+\/export\/(?:index\.html|chapter\.pdf))$/.test(path)) throw new PreconditionError("This project file is not public");
            const bytes = await handle.ctx.fs.readBytes(path);
            if (!bytes) { replyJson(404, { error: { message: "File not found", code: 1 } }); return; }
            response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream", "Cache-Control": path.includes("/pages/") || path.includes("/export/") ? "no-store" : "private, max-age=31536000, immutable" });
            response.end(bytes); return;
          }
        } finally { await handle.close(); }
      }
      if (url.pathname.startsWith("/api/")) { replyJson(404, { error: { message: "API route not found", code: 1 } }); return; }
      if (request.method !== "GET") { replyJson(405, { error: { message: "Method not allowed", code: 1 } }); return; }
      const root = resolve(workspace.repository, "dist", "web");
      const file = resolve(root, `.${url.pathname}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new PreconditionError("Invalid asset path");
      let bytes: Uint8Array;
      let extension = extname(file);
      try { bytes = new Uint8Array(await readFile(file)); }
      catch (error) {
        if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code!)) throw error;
        if (extension) { replyJson(404, { error: { message: "Asset not found", code: 1 } }); return; }
        try { bytes = new Uint8Array(await readFile(join(root, "index.html"))); extension = ".html"; }
        catch { throw new PreconditionError("Web assets are missing. Run pnpm build before comic serve."); }
      }
      response.writeHead(200, { "Content-Type": contentTypes[extension] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      response.end(bytes);
    } catch (error) {
      const info = errorInfo(error);
      if (!response.headersSent) replyJson(info.code === 3 ? 402 : info.code === 2 ? 409 : 400, { error: info });
      else response.end();
    } finally {
      if (finishMutation) {
        mutationBusy = false;
        mutationRequest = undefined;
        finishMutation();
        if (pendingReply) sendJson(response, pendingReply.status, pendingReply.value);
      }
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, url: `http://${options.host === "::1" ? "[::1]" : options.host}:${port}`, close: async () => {
    shuttingDown = true;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    jobController?.abort(new Error("Server is shutting down; progress saved"));
    mutationRequest?.destroy();
    await Promise.all([running, mutationDone, closed]);
  } };
}

export async function serve(workspace: WorkspaceRuntime, options: { host: string; port: number; signal: AbortSignal; json?: boolean }) {
  const instance = await startServer(workspace, options);
  process.stdout.write(options.json ? JSON.stringify({ url: instance.url, workspace: workspace.root }) + "\n" : `Comic studio: ${instance.url}\nWorkspace: ${workspace.root}\n`);
  try {
    if (!options.signal.aborted) await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally { await instance.close(); }
}
