export class ComicError extends Error {
  constructor(message: string, public readonly code = 1, public readonly details?: unknown) {
    super(message);
    this.name = "ComicError";
  }
}

export class PreconditionError extends ComicError {
  constructor(message: string, details?: unknown) {
    super(message, 2, details);
  }
}

export class BudgetError extends ComicError {
  constructor(message: string, details: unknown) {
    super(message, 3, details);
  }
}

export function errorInfo(error: unknown): { message: string; code: number; details?: unknown } {
  const message = (error instanceof Error ? error.message : String(error)).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
  if (error instanceof ComicError) return { message, code: error.code, details: error.details };
  return { message, code: 1 };
}
