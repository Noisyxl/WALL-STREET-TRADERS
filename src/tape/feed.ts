import type { TapeSnapshot, TapeEvent, Quote, BookState } from "../types.js";

/**
 * A feed is anything that can answer three questions: what does the board look
 * like now, what does the book for one name look like now, and is the session
 * over. Everything downstream — desks, gate, execution, ledger — is written
 * against this interface and has never heard of a data vendor.
 *
 * Two implementations ship: `synthetic` (seeded, offline, reproducible) and
 * `csv` (your own bars). A third one that speaks to a real vendor is thirty
 * lines and is deliberately not included; see docs/SAFETY.md for why.
 */
export interface Feed {
  readonly name: string;
  readonly universe: readonly string[];

  /** Advance to the next tick and return the whole board. */
  tick(): TapeSnapshot | null;

  /** The current snapshot without advancing. */
  peek(): TapeSnapshot;

  /** The book for one name at the current instant. */
  book(symbol: string): BookState;

  /** Market minutes elapsed. */
  readonly minute: number;

  /** True once the session length configured has been reached. */
  readonly done: boolean;
}

/**
 * The tape read: the difference between two snapshots, expressed as events a
 * desk can act on. This is pure arithmetic and runs before any model is asked
 * anything — the tape seat's model then ranks and narrates these, it does not
 * invent them.
 */
export function readTape(
  prev: TapeSnapshot | null,
  now: TapeSnapshot,
  opts: { breakPct?: number; volumeMult?: number; spreadBps?: number } = {},
): TapeEvent[] {
  if (!prev) return [];
  const breakPct = opts.breakPct ?? 0.35;
  const volumeMult = opts.volumeMult ?? 2.2;
  const spreadBps = opts.spreadBps ?? 12;

  const out: TapeEvent[] = [];

  for (const [symbol, q] of Object.entries(now.quotes)) {
    const p = prev.quotes[symbol];
    if (!p) continue;

    const move = ((q.last - p.last) / p.last) * 100;
    const dVol = q.volume - p.volume;
    const pVol = Math.max(1, p.volume - (p.volume ? 0 : 1));
    const spread = ((q.ask - q.bid) / q.last) * 10_000;

    if (Math.abs(move) >= breakPct) {
      out.push({
        ts: now.ts,
        symbol,
        kind: "break",
        note: `${move > 0 ? "up" : "down"} ${Math.abs(move).toFixed(2)}% on the tick, ${q.last.toFixed(2)}`,
        weight: Math.min(1, Math.abs(move) / (breakPct * 3)),
      });
    }

    const prevMove = p.changePct;
    if (Math.sign(q.changePct) !== Math.sign(prevMove) && Math.abs(prevMove) > 0.4) {
      out.push({
        ts: now.ts,
        symbol,
        kind: "reversal",
        note: `crossed the session line, ${prevMove.toFixed(2)}% to ${q.changePct.toFixed(2)}%`,
        weight: 0.6,
      });
    }

    if (dVol > 0 && pVol > 0 && dVol / (pVol / Math.max(1, now.minute || 1)) >= volumeMult) {
      out.push({
        ts: now.ts,
        symbol,
        kind: "volume",
        note: `${Math.round(dVol).toLocaleString("en-US")} shares in one tick, above the session pace`,
        weight: 0.5,
      });
    }

    if (spread >= spreadBps) {
      out.push({
        ts: now.ts,
        symbol,
        kind: "spread",
        note: `spread ${spread.toFixed(1)} bps, ${q.bidSize} x ${q.askSize} at the touch`,
        weight: 0.35,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      ts: now.ts,
      symbol: "*",
      kind: "quiet",
      note: `nothing moved more than ${breakPct}% on the tick`,
      weight: 0.05,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** Board-level readings the desks share, derived from the quotes themselves. */
export function breadth(quotes: Record<string, Quote>): number {
  const all = Object.values(quotes);
  const up = all.filter((q) => q.changePct > 0).length;
  const down = all.filter((q) => q.changePct < 0).length;
  // At the bell nothing has moved, and 0% breadth would read as a collapse.
  if (up + down === 0) return 50;
  return (up / (up + down)) * 100;
}
