import { ulid } from "ulid";
import { BudgetError } from "./errors.js";
import type { Db, Log, TokenUsage } from "./ports.js";

export interface BudgetPolicy {
  limit_usd: number | null;
  period: "month" | "week" | "none";
  cycle_start_day: number;
  timezone: string;
}

function localDate(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const part = (name: string) => Number(parts.find((value) => value.type === name)!.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function midnight(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (name: string) => Number(parts.find((value) => value.type === name)!.value);
    const displayed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += target - displayed;
  }
  return new Date(guess);
}

export function budgetWindow(policy: BudgetPolicy, now = new Date()): { start: string | null; reset_at: string | null } {
  if (policy.period === "none") return { start: null, reset_at: null };
  const date = localDate(now, policy.timezone);
  if (policy.period === "week") {
    const weekday = (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7 + 1;
    const offset = (weekday - policy.cycle_start_day + 7) % 7;
    const start = new Date(Date.UTC(date.year, date.month - 1, date.day - offset));
    const end = new Date(Date.UTC(date.year, date.month - 1, date.day - offset + 7));
    return {
      start: midnight(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), policy.timezone).toISOString(),
      reset_at: midnight(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), policy.timezone).toISOString(),
    };
  }
  const boundary = (year: number, month: number) => {
    const normalized = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return midnight(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, Math.min(policy.cycle_start_day, lastDay), policy.timezone);
  };
  let start = boundary(date.year, date.month);
  let end = boundary(date.year, date.month + 1);
  if (now < start) {
    end = start;
    start = boundary(date.year, date.month - 1);
  }
  return { start: start.toISOString(), reset_at: end.toISOString() };
}

export async function budgetReport(ledger: Db, policy: BudgetPolicy, projectId?: string, now = new Date()) {
  const window = budgetWindow(policy, now);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (window.start) { conditions.push("created_at >= ?"); params.push(window.start); }
  if (window.reset_at) { conditions.push("created_at < ?"); params.push(window.reset_at); }
  if (projectId) { conditions.push("project_id = ?"); params.push(projectId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await ledger.get<{ total: number }>(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend ${where}`, params);
  const spent = total!.total;
  return {
    spent_usd: spent,
    limit_usd: policy.limit_usd,
    remaining_usd: policy.limit_usd === null ? null : Math.max(0, policy.limit_usd - spent),
    period: policy.period,
    timezone: policy.timezone,
    reset_at: window.reset_at,
    by_project: await ledger.all<{ project_id: string; cost_usd: number }>(`SELECT project_id, SUM(cost_usd) AS cost_usd FROM spend ${where} GROUP BY project_id ORDER BY cost_usd DESC`, params),
    by_step: await ledger.all<{ step: string; cost_usd: number }>(`SELECT step, SUM(cost_usd) AS cost_usd FROM spend ${where} GROUP BY step ORDER BY cost_usd DESC`, params),
  };
}

export class Budget {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly ledger: Db,
    public readonly projectId: string,
    private readonly workspacePolicy: BudgetPolicy,
    private readonly projectPolicy: BudgetPolicy | null,
    private readonly ignoreLimit = false,
  ) {}

  async begin(step: string, model: string, estimate: number, ref: string): Promise<string> {
    const operation = this.queue.then(async () => {
      if (!this.ignoreLimit) {
        for (const [scope, policy] of [["workspace", this.workspacePolicy], ["project", this.projectPolicy]] as const) {
          if (!policy || policy.limit_usd === null) continue;
          const report = await budgetReport(this.ledger, policy, scope === "project" ? this.projectId : undefined);
          if (report.spent_usd + estimate > policy.limit_usd) {
            throw new BudgetError(`${scope} budget exceeded: spent $${report.spent_usd.toFixed(4)}, next estimate $${estimate.toFixed(4)}, limit $${policy.limit_usd}`, { scope, estimate_usd: estimate, ...report });
          }
        }
      }
      const id = ulid();
      await this.ledger.run("INSERT INTO spend (id, project_id, step, model, input_tokens, output_tokens, cost_usd, estimated, ref, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?, ?)",
        [id, this.projectId, step, model, estimate, ref, new Date().toISOString()]);
      return id;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async settle(id: string, cost: number, usage?: TokenUsage, estimated = false): Promise<void> {
    await this.ledger.run("UPDATE spend SET cost_usd = ?, input_tokens = ?, output_tokens = ?, estimated = ? WHERE id = ?",
      [cost, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, estimated ? 1 : 0, id]);
  }
}

export function priceUsage(
  pricing: Record<string, { input?: number; output?: number; text_in?: number; image_in?: number; image_out?: number; per_image?: number; per_input_image?: number; free_input_images?: number }>,
  model: string,
  usage: TokenUsage | undefined,
  estimate: number,
  image: boolean,
  log: Log,
): { cost: number; estimated: boolean } {
  const price = pricing[model];
  if (image && price?.per_image !== undefined) {
    const count = usage?.image_count;
    const inputCount = price.per_input_image === undefined ? 0 : usage?.input_image_count;
    const cost = count === undefined || inputCount === undefined ? NaN : count * price.per_image + Math.max(0, inputCount - (price.free_input_images ?? 0)) * (price.per_input_image ?? 0);
    if (count !== undefined && Number.isInteger(count) && count >= 0 && inputCount !== undefined && Number.isInteger(inputCount) && inputCount >= 0 && Number.isFinite(cost)) return { cost, estimated: false };
    log("warning", `Missing image count or pricing for ${model}; recording estimate $${estimate}`);
    return { cost: estimate, estimated: true };
  }
  const tokens = usage ? [usage.input_tokens, usage.output_tokens, ...(image ? [usage.text_input_tokens, usage.image_input_tokens] : [])] : [];
  const validUsage = usage && tokens.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (!validUsage || !price || (image ? price.text_in === undefined || price.image_in === undefined || price.image_out === undefined || usage.text_input_tokens === undefined || usage.image_input_tokens === undefined : price.input === undefined || price.output === undefined)) {
    log("warning", `Missing usage or pricing for ${model}; recording estimate $${estimate}`);
    return { cost: estimate, estimated: true };
  }
  const cost = image
    ? (usage.text_input_tokens! * price.text_in! + usage.image_input_tokens! * price.image_in! + usage.output_tokens * price.image_out!) / 1_000_000
    : (usage.input_tokens * price.input! + usage.output_tokens * price.output!) / 1_000_000;
  if (!Number.isFinite(cost)) {
    log("warning", `Invalid usage for ${model}; recording estimate $${estimate}`);
    return { cost: estimate, estimated: true };
  }
  return { cost, estimated: false };
}
