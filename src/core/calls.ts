import type { Log } from "./ports.js";

export function apiStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

export function isTransient(error: unknown): boolean {
  const status = apiStatus(error);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

export function isTimeout(error: unknown): boolean {
  const detail = error as { name?: string; message?: string; code?: string };
  return /timeout|timed.?out|ETIMEDOUT/i.test(`${detail?.name} ${detail?.message} ${detail?.code}`);
}

export function isRefusal(error: unknown): boolean {
  const detail = error as { code?: string; message?: string; error?: unknown };
  return apiStatus(error) === 400 && /moderation|content.?policy|safety|content.?filter|data.?inspection.?failed|sensitive.?content/i.test(`${detail?.code} ${detail?.message} ${JSON.stringify(detail?.error)}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function retryApi<T>(call: () => Promise<T>, backoff: number[], log: Log, signal?: AbortSignal): Promise<T> {
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted();
    try { return await call(); }
    catch (error) {
      if (!isTransient(error) || retry >= backoff.length || signal?.aborted) throw error;
      log("warning", `API ${apiStatus(error)}; retrying in ${backoff[retry]} seconds`);
      await delay(backoff[retry] * 1000, signal);
    }
  }
}
