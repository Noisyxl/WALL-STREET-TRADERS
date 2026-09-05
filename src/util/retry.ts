/**
 * One retry policy for every outbound call.
 *
 * A model endpoint that rate-limits is the normal case during a busy minute,
 * not an error. The floor waits rather than dropping a seat: a session where
 * the risk gate silently stopped answering is worse than a slow one.
 */

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Return false to give up immediately, e.g. on a 400. */
  retryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  const code = (err as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 8_000;
  const retryable = opts.retryable ?? isRetryable;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) break;
      const wait = Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      opts.onRetry?.(i + 1, Math.round(wait), err);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** A hard ceiling on how long one seat may hold up the floor. */
export async function withDeadline<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([fn(), bell]);
  } finally {
    clearTimeout(timer!);
  }
}
