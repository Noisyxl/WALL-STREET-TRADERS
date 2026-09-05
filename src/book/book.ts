import type { BookState, Level, Side } from "../types.js";

/** Read-only arithmetic on a book snapshot. Nothing here mutates anything. */

export const bestBid = (b: BookState): Level | undefined => b.bids[0];
export const bestAsk = (b: BookState): Level | undefined => b.asks[0];

export function mid(b: BookState): number {
  const bid = bestBid(b)?.price ?? 0;
  const ask = bestAsk(b)?.price ?? 0;
  if (!bid || !ask) return bid || ask;
  return (bid + ask) / 2;
}

export function spreadBps(b: BookState): number {
  const bid = bestBid(b)?.price ?? 0;
  const ask = bestAsk(b)?.price ?? 0;
  const m = mid(b);
  if (!m) return 0;
  return +(((ask - bid) / m) * 10_000).toFixed(2);
}

/** Total displayed size within `levels` of the touch, one side. */
export function depth(b: BookState, side: Side, levels = 5): number {
  const rows = side === "buy" ? b.asks : b.bids;
  return rows.slice(0, levels).reduce((s, l) => s + l.size, 0);
}

/**
 * Imbalance at the touch, -1..+1. Positive means more size resting on the bid
 * than the offer. The quant desk gets this in its brief; it is not a signal on
 * its own, it is context.
 */
export function imbalance(b: BookState, levels = 3): number {
  const bidSize = b.bids.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const askSize = b.asks.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const total = bidSize + askSize;
  if (total === 0) return 0;
  return +(((bidSize - askSize) / total)).toFixed(4);
}

/** Price at which a market order of `size` would finish, ignoring limits. */
export function clearingPrice(b: BookState, side: Side, size: number): number {
  const rows = side === "buy" ? b.asks : b.bids;
  let left = size;
  let last = 0;
  for (const l of rows) {
    if (left <= 0) break;
    last = l.price;
    left -= l.size;
  }
  return last;
}

/** A monospaced ladder for the terminal and the floorview drawer. */
export function ladder(b: BookState, levels = 5): string[] {
  const out: string[] = [];
  const asks = b.asks.slice(0, levels).reverse();
  const maxSize = Math.max(
    1,
    ...b.asks.slice(0, levels).map((l) => l.size),
    ...b.bids.slice(0, levels).map((l) => l.size),
  );
  const barOf = (n: number): string => "▇".repeat(Math.max(1, Math.round((n / maxSize) * 12)));

  for (const l of asks) {
    out.push(`  ${l.price.toFixed(2)}  ${String(l.size).padStart(7)}  ${barOf(l.size)}`);
  }
  out.push(`  ${"─".repeat(34)}  ${spreadBps(b).toFixed(1)} bps`);
  for (const l of b.bids.slice(0, levels)) {
    out.push(`  ${l.price.toFixed(2)}  ${String(l.size).padStart(7)}  ${barOf(l.size)}`);
  }
  return out;
}
