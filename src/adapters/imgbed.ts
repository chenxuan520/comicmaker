import { basename } from "node:path";
import { PreconditionError } from "../core/errors.js";
import type { ImageHostUploader } from "../core/ports.js";
import { apiKey } from "./config.js";

export async function imgBedCredentials(workspace: string) {
  const [token, authCode] = await Promise.all([
    apiKey(workspace, { api_key_env: "IMG_BED_TOKEN" }),
    apiKey(workspace, { api_key_env: "IMG_BED_AUTH_CODE" }),
  ]);
  return { token, authCode };
}

export class ImgBedUploader implements ImageHostUploader {
  constructor(private readonly options: { baseURL: string; token?: string; authCode?: string }) {}

  async upload(relPath: string, data: Uint8Array, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const token = this.options.token?.trim();
    const authCode = this.options.authCode?.trim();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` }
      : authCode ? { authCode } : {};
    if (!token && !authCode) throw new PreconditionError("Set IMG_BED_TOKEN with upload permission or IMG_BED_AUTH_CODE in the environment or workspace .env");
    const baseURL = this.options.baseURL.replace(/\/+$/, "");
    const url = new URL(`${baseURL}/upload`);
    url.search = new URLSearchParams({ returnFormat: "full", responseFormat: "object", serverCompress: "false" }).toString();
    const name = basename(relPath).replace(/[^A-Za-z0-9_.-]/g, "_");
    const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.png$/i.test(name) ? "image/png" : "application/octet-stream";
    const form = new FormData();
    form.set("file", new Blob([data.slice().buffer], { type }), name);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", headers, body: form, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("ImgBed upload request failed; completion is unknown. Check the image host before retrying.");
    }
    if (!response.ok) throw new Error(`ImgBed upload failed (HTTP ${response.status}); check upload permission and image host configuration`);
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch {
      signal?.throwIfAborted();
      throw new Error("ImgBed returned invalid JSON; check the image host before retrying the upload");
    }
    const item = Array.isArray(decoded) ? decoded[0] : decoded;
    if (!item || typeof item !== "object") throw new Error("ImgBed returned an invalid upload result");
    const result = item as { publicUrl?: unknown; src?: unknown };
    const link = typeof result.publicUrl === "string" && result.publicUrl.trim() ? result.publicUrl : result.src;
    if (typeof link !== "string" || !link.trim()) throw new Error("ImgBed upload result has no publicUrl or src");
    let resolved: URL;
    try { resolved = new URL(link.trim(), `${baseURL}/`); }
    catch { throw new Error("ImgBed returned an invalid image URL"); }
    if (!["http:", "https:"].includes(resolved.protocol) || resolved.username || resolved.password) throw new Error("ImgBed image URL must use HTTP(S) without credentials");
    if ([...resolved.searchParams].some(([name, value]) => ["authcode", "token"].includes(name.toLowerCase()) && [token, authCode].includes(value))) throw new Error("ImgBed returned a credential-bearing image URL");
    return resolved.href;
  }
}
