import { ulid } from "ulid";
import { zodResponseFormat } from "openai/helpers/zod";
import { ZodError, type ZodType } from "zod";
import { priceUsage } from "./budget.js";
import { isConnectionError, isTimeout, retryApi } from "./calls.js";
import { errorInfo } from "./errors.js";
import { ResponseDecodeError } from "./ai.js";
import type { ImageInput } from "./ports.js";
import type { Context } from "./types.js";

export async function structuredCall<T>(ctx: Context, options: {
  step: string;
  template: string;
  model: string;
  schema: ZodType<T>;
  data: Record<string, unknown>;
  images?: ImageInput[];
  estimate?: number;
}): Promise<T> {
  ctx.ai.ready(options.images?.length ? "vision" : "text");
  const basePrompt = await ctx.prompts.pair(options.template, options.data);
  let prompt = basePrompt;
  const responseFormat = zodResponseFormat(options.schema, options.template.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const estimate = options.estimate ?? ctx.config.budget.estimates.llm;
  for (let retry = 0; ; retry++) {
    ctx.signal?.throwIfAborted();
    const id = ulid();
    const spendId = await ctx.budget.begin(options.step, options.model, estimate, id);
    await ctx.db.run("INSERT INTO llm_calls (id, step, model, prompt, template_sources, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      [id, options.step, options.model, JSON.stringify({ system: prompt.system, user: prompt.user }), JSON.stringify(prompt.sources), new Date().toISOString()]);
    let raw: string | undefined;
    let charged = false;
    let invoked = false;
    try {
      ctx.log("info", `${options.step}: ${options.model}`);
      const response = await retryApi(() => {
        invoked = true;
        return ctx.ai.structured({
          model: options.model, system: prompt.system, user: prompt.user,
          schema: responseFormat, schema_name: options.template,
          images: options.images, signal: ctx.signal,
        });
      }, ctx.config.llm.retry_backoff_sec, ctx.log, ctx.signal);
      raw = response.text;
      const price = priceUsage(ctx.config.pricing, options.model, response.usage, estimate, false, ctx.log);
      charged = true;
      await ctx.budget.settle(spendId, price.cost, response.usage, price.estimated);
      const result = options.schema.parse(JSON.parse(raw));
      await ctx.db.run("UPDATE llm_calls SET status = 'ok', output = ? WHERE id = ?", [JSON.stringify(result), id]);
      try {
        await ctx.fs.writeJson(`logs/llm-${id}.json`, { id, step: options.step, model: options.model, ...prompt, output: result, usage: response.usage, ...price });
      } catch (error) {
        ctx.log("warning", `Call ${id} completed but its log mirror could not be written`, errorInfo(error).message);
      }
      return result;
    } catch (error) {
      const message = errorInfo(error).message;
      if (!charged) await ctx.budget.settle(spendId, invoked && (isTimeout(error) || isConnectionError(error) || ctx.signal?.aborted || error instanceof ResponseDecodeError) ? estimate : 0, undefined, true);
      await ctx.db.run("UPDATE llm_calls SET status = 'error', output = ?, error = ? WHERE id = ?", [raw ?? null, message, id]);
      await ctx.fs.writeJson(`logs/llm-${id}.json`, { id, step: options.step, model: options.model, ...prompt, output: raw, error: message });
      if (charged && (error instanceof SyntaxError || error instanceof ZodError) && retry < ctx.config.llm.schema_retry && !ctx.signal?.aborted) {
        ctx.log("warning", `${options.step}: invalid structured output; retry ${retry + 1}`, message);
        const feedback = await ctx.prompts.render("partials/validation_feedback.md", { issues: error instanceof ZodError ? error.issues : [{ message }], previous_output: raw ?? "" });
        prompt = { ...basePrompt, user: `${basePrompt.user}\n\n${feedback.text}`, sources: { ...basePrompt.sources, ...feedback.sources } };
        continue;
      }
      throw error;
    }
  }
}
