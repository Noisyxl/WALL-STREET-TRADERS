import { createHash, randomBytes } from "node:crypto";

/**
 * Ticket ids are readable on purpose: a human reading a receipt file at
 * midnight should be able to say which desk wrote what without a lookup.
 *
 *   Q-0147-NVDA   quant desk, 147th ticket of the session, NVDA
 */
export function ticketId(desk: string, n: number, symbol: string): string {
  return `${desk[0]!.toUpperCase()}-${String(n).padStart(4, "0")}-${symbol}`;
}

export function sessionId(ts = Date.now()): string {
  const d = new Date(ts);
  const day = d.toISOString().slice(0, 10);
  return `${day}-${randomBytes(2).toString("hex")}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * A seeded generator. The synthetic tape uses it so that a session with the
 * same seed replays identically — which is the only way a claim about a run
 * can be checked by someone else.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller on top of a seeded uniform, so shocks are normal, not flat. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
