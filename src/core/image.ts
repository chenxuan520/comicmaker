import { ulid } from "ulid";
import { priceUsage } from "./budget.js";
import { ImageResponseError, ResponseDecodeError } from "./ai.js";
import { errorInfo } from "./errors.js";
import { isConnectionError, isRefusal, isTimeout, isTransient, retryApi } from "./calls.js";
import type { ImageInput } from "./ports.js";
import type { RenderedPrompt } from "./prompts.js";
import type { Attempt, Context } from "./types.js";

export function pngSize(data: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 24 || signature.some((byte, index) => data[index] !== byte)) throw new Error("Expected a PNG image");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) throw new Error("PNG dimensions must be positive");
  let offset = 8;
  let hasPixels = false;
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > data.length) break;
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (offset === 8 && (type !== "IHDR" || length !== 13)) break;
    if (type === "IDAT" && length > 0) hasPixels = true;
    if (type === "IEND") {
      if (length === 0 && end === data.length && hasPixels) return { width, height };
      break;
    }
    offset = end;
  }
  throw new Error("PNG image is incomplete");
}

export async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generateImage(ctx: Context, options: {
  pageId?: string;
  refId?: string;
  prompt: RenderedPrompt;
  images: ImageInput[];
  refPaths: string[];
  path: (seq: number) => string;
}): Promise<Attempt> {
  ctx.signal?.throwIfAborted();
  ctx.ai.ready("image");
  const id = ulid();
  const estimate = ctx.config.budget.estimates.image;
  const spendId = await ctx.budget.begin("image", ctx.config.image.model, estimate, id);
  const sequence = await ctx.db.get<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM attempts WHERE ${options.pageId ? "page_id" : "ref_id"} = ?`, [options.pageId ?? options.refId!]);
  const seq = sequence!.seq;
  const path = options.path(seq);
  await ctx.db.run("INSERT INTO attempts (id, page_id, ref_id, seq, model, quality, prompt, ref_paths, template_sources, status, path, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)",
    [id, options.pageId ?? null, options.refId ?? null, seq, ctx.config.image.model, ctx.config.image.quality, options.prompt.text, JSON.stringify(options.refPaths), JSON.stringify(options.prompt.sources), path, estimate, new Date().toISOString()]);
  let cost = estimate;
  let charged = false;
  let invoked = false;
  try {
    ctx.log("info", `Generating ${options.pageId ?? options.refId}, attempt ${seq}`);
    const response = await retryApi(() => {
      invoked = true;
      return ctx.ai.image({
        model: ctx.config.image.model, prompt: options.prompt.text, size: ctx.config.image.size,
        quality: ctx.config.image.quality, images: options.images, signal: ctx.signal,
      });
    }, ctx.config.image.retry_backoff_sec, ctx.log, ctx.signal);
    const price = priceUsage(ctx.config.pricing, ctx.config.image.model, response.usage, estimate, true, ctx.log);
    cost = price.cost;
    charged = true;
    await ctx.budget.settle(spendId, cost, response.usage, price.estimated);
    pngSize(response.data);
    const hash = await ctx.fs.writeImage(path, response.data);
    await ctx.db.run("UPDATE attempts SET status = 'ok', sha256 = ?, input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?",
      [hash.sha256, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, cost, id]);
    return (await ctx.db.get<Attempt>("SELECT * FROM attempts WHERE id = ?", [id]))!;
  } catch (error) {
    const refusal = isRefusal(error);
    const estimated = invoked && (isTimeout(error) || isConnectionError(error) || Boolean(ctx.signal?.aborted) || error instanceof ResponseDecodeError);
    if (!charged) {
      if (error instanceof ImageResponseError) {
        const price = priceUsage(ctx.config.pricing, ctx.config.image.model, error.usage, estimate, true, ctx.log);
        cost = price.cost;
        await ctx.budget.settle(spendId, cost, error.usage, price.estimated);
        await ctx.db.run("UPDATE attempts SET input_tokens = ?, output_tokens = ? WHERE id = ?", [error.usage?.input_tokens ?? 0, error.usage?.output_tokens ?? 0, id]);
      } else {
        cost = estimated ? estimate : 0;
        await ctx.budget.settle(spendId, cost, undefined, true);
      }
    }
    const kind = !invoked ? "cancelled" : refusal ? "refused" : isConnectionError(error) && !isTimeout(error) ? "network" : estimated ? "timeout" : isTransient(error) ? "network" : "error";
    await ctx.db.run("UPDATE attempts SET status = ?, cost_usd = ?, error = ? WHERE id = ?", [refusal ? "refused" : "error", cost, JSON.stringify({ kind, message: errorInfo(error).message }), id]);
    throw error;
  }
}

export async function recoverPendingImages(ctx: Context, pageId?: string, refId?: string): Promise<void> {
  const pending = await ctx.db.all<Attempt>(`SELECT * FROM attempts WHERE ${pageId ? "page_id" : "ref_id"} = ? AND status IN ('pending', 'error') ORDER BY seq`, [pageId ?? refId!]);
  for (const attempt of pending) {
    const bytes = attempt.path ? await ctx.fs.readBytes(attempt.path) : null;
    let complete = false;
    if (bytes) {
      try { pngSize(bytes); complete = true; } catch {}
    }
    if (bytes && complete) {
      await ctx.db.run("UPDATE attempts SET status = 'ok', sha256 = ? WHERE id = ?", [await sha256(bytes), attempt.id]);
      ctx.log("warning", `Recovered saved image ${attempt.id}; usage remains estimated if interrupted before accounting`);
    } else if (attempt.status === "pending") {
      await ctx.db.run("UPDATE attempts SET status = 'error', error = ? WHERE id = ?", [JSON.stringify({ kind: "timeout", message: "Interrupted request; estimated spend retained" }), attempt.id]);
    }
  }
}
