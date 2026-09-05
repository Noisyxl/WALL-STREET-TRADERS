import type { BookState, Execution, Fill, Level, Side } from "../types.js";

/**
 * Working an order.
 *
 * A market order is one instruction: take whatever is there. On a five-level
 * book that is a decision to pay every level at once, and the price you get is
 * the last one you reached, not the one you saw. Working the same order is a
 * sequence of child orders, each one bounded by how much of the displayed size
 * it is willing to take, that stops when the next level costs more than the
 * limit allows.
 *
 * The difference is the whole reason this module exists, and it is a number:
 * `sweep` and `work` on the same book, same size, report different average
 * prices, and `outcry book <symbol> --size N` prints both side by side.
 *
 *   ask levels    185.91 x 1 200
 *                 185.93 x   900
 *                 185.95 x   600
 *
 *   sweep 2 400   → 185.925 avg, three levels in one instruction
 *   work  2 400   → 185.913 avg, stopped at level 2 under a 185.94 limit
 *
 * No model is involved here. This is arithmetic, and it is tested.
 */

export interface WorkOptions {
  /** `work` walks level by level; `sweep` takes everything at once. */
  style: "work" | "sweep";
  /** How deep a single order may reach, in levels. */
  maxLevels: number;
  /** Percent of a level's displayed size one child order may take. */
  participationPct: number;
  /** Smallest child order worth sending, in shares. */
  minChild: number;
  /** Worst price accepted. Absent means the book decides. */
  limit?: number;
  /**
   * How much of a taken level comes back before the next child order, as a
   * percent of what was just taken.
   *
   * **This assumption is the whole advantage `work` claims, so it is a
   * parameter and not a constant.** A book that never refreshes makes working
   * an order pointless: you would climb the same ladder as a sweep, one rung
   * at a time, for the same average price. A book that fully refreshes makes
   * it free. Neither is true, and the truth is name-specific.
   *
   * The default of 60 says a level gives back roughly three fifths of what was
   * lifted before the next child arrives, which is the behaviour of a liquid
   * name in normal conditions and is optimistic in a fast one.
   *
   * Set it to 0 to price an order against a book that does not come back, and
   * every claim this repository makes about execution is measured again with
   * that assumption removed: `outcry book <sym> --size N --replenish 0`.
   */
  replenishPct: number;
}

const DEFAULTS: WorkOptions = {
  style: "work",
  maxLevels: 5,
  participationPct: 8,
  minChild: 1,
  replenishPct: 60,
};

/** Safety valve: a high replenish rate must not be able to loop forever. */
const MAX_CHILD_ORDERS = 400;

/** The side of the book an order consumes. Buys lift offers, sells hit bids. */
export function takingSide(book: BookState, side: Side): Level[] {
  return side === "buy" ? book.asks : book.bids;
}

const worseThanLimit = (price: number, limit: number, side: Side): boolean =>
  side === "buy" ? price > limit + 1e-9 : price < limit - 1e-9;

/**
 * Walk `size` shares through `book`.
 *
 * Returns every child fill with the level it reached, so a receipt can show
 * the ladder the order actually climbed rather than a single average.
 */
export function walk(
  book: BookState,
  side: Side,
  size: number,
  ticketId: string,
  opts: Partial<WorkOptions> = {},
): Execution {
  const o: WorkOptions = { ...DEFAULTS, ...opts };
  const levels = takingSide(book, side);
  const touch = levels[0]?.price ?? 0;

  const fills: Fill[] = [];
  let remaining = Math.max(0, Math.floor(size));
  let unfilledReason: string | undefined;

  const depth = o.style === "sweep" ? levels.length : Math.min(o.maxLevels, levels.length);

  if (o.style === "sweep") {
    // One instruction. Every level at once, at whatever it costs, and the book
    // does not get a chance to come back in between.
    for (let i = 0; i < depth && remaining > 0; i++) {
      const level = levels[i]!;
      if (o.limit !== undefined && worseThanLimit(level.price, o.limit, side)) {
        unfilledReason = `limit ${o.limit} reached at level ${i} (${level.price})`;
        break;
      }
      const take = Math.min(remaining, level.size);
      if (take < o.minChild) break;
      fills.push({ ts: book.ts, price: level.price, size: take, level: i });
      remaining -= take;
    }
    if (remaining > 0 && !unfilledReason) {
      unfilledReason = `book exhausted after ${levels.length} levels`;
    }
  } else {
    // A sequence of child orders. Each takes its share of what is displayed at
    // the best level available, and the level gives some of it back before the
    // next one arrives (see `replenishPct`). The order only steps to a worse
    // price when the level in front of it is genuinely used up.
    const remainingAt = levels.slice(0, depth).map((l) => l.size);
    let i = 0;
    let children = 0;

    while (remaining > 0 && i < depth) {
      const level = levels[i]!;

      if (o.limit !== undefined && worseThanLimit(level.price, o.limit, side)) {
        unfilledReason = `limit ${o.limit} reached at level ${i} (${level.price})`;
        break;
      }
      if (children >= MAX_CHILD_ORDERS) {
        unfilledReason = `stopped after ${MAX_CHILD_ORDERS} child orders with ${remaining} shares left`;
        break;
      }

      const displayed = remainingAt[i]!;
      const slice = Math.max(o.minChild, Math.floor((level.size * o.participationPct) / 100));
      const take = Math.min(remaining, slice, displayed);

      if (take < o.minChild) {
        i++;
        continue;
      }

      fills.push({ ts: book.ts, price: level.price, size: take, level: i });
      remaining -= take;
      children++;

      const back = Math.floor((take * o.replenishPct) / 100);
      remainingAt[i] = displayed - take + back;
      if (remainingAt[i]! < o.minChild) i++;
    }

    if (remaining > 0 && !unfilledReason) {
      unfilledReason = `${remaining} shares left after ${depth} levels at ${o.participationPct}% participation`;
    }
  }

  const filledSize = fills.reduce((s, f) => s + f.size, 0);
  const notional = fills.reduce((s, f) => s + f.size * f.price, 0);
  const avgPrice = filledSize > 0 ? notional / filledSize : 0;
  const slippageBps =
    filledSize > 0 && touch > 0
      ? ((side === "buy" ? avgPrice - touch : touch - avgPrice) / touch) * 10_000
      : 0;

  return {
    ticketId,
    symbol: book.symbol,
    side,
    fills,
    avgPrice: +avgPrice.toFixed(6),
    filledSize,
    requestedSize: Math.max(0, Math.floor(size)),
    slippageBps: +slippageBps.toFixed(2),
    ...(unfilledReason ? { unfilledReason } : {}),
  };
}

/**
 * What one order would cost both ways, for the CLI and the floorview.
 * This is the comparison that justifies the execution seat's existence.
 */
export function compare(
  book: BookState,
  side: Side,
  size: number,
  opts: Partial<WorkOptions> = {},
): { work: Execution; sweep: Execution; savedBps: number } {
  const work = walk(book, side, size, "compare", { ...opts, style: "work" });
  const sweep = walk(book, side, size, "compare", { ...opts, style: "sweep" });
  const savedBps = +(sweep.slippageBps - work.slippageBps).toFixed(2);
  return { work, sweep, savedBps };
}

/** Notional a size would consume, for the gate's sizing arithmetic. */
export function notionalFor(book: BookState, side: Side, size: number): number {
  const e = walk(book, side, size, "size-probe", { style: "sweep" });
  return +(e.avgPrice * e.filledSize).toFixed(2);
}

/** How many shares a notional buys, rounded down to a whole share. */
export function sizeForNotional(book: BookState, side: Side, notional: number): number {
  const levels = takingSide(book, side);
  let left = notional;
  let shares = 0;
  for (const level of levels) {
    const affordable = Math.floor(left / level.price);
    if (affordable <= 0) break;
    const take = Math.min(affordable, level.size);
    shares += take;
    left -= take * level.price;
  }
  return shares;
}

/**
 * Consecutive child orders at the same level collapse for display. The
 * Execution keeps every child — the receipt should show what was actually
 * sent — but a terminal line wants `188.17 x4` rather than the same price
 * printed four times.
 */
export function ladderOf(exec: Execution): string {
  const out: { price: number; n: number; size: number }[] = [];
  for (const f of exec.fills) {
    const last = out[out.length - 1];
    if (last && last.price === f.price) {
      last.n++;
      last.size += f.size;
    } else {
      out.push({ price: f.price, n: 1, size: f.size });
    }
  }
  return out.map((r) => (r.n > 1 ? `${r.price.toFixed(2)}x${r.n}` : r.price.toFixed(2))).join(" ");
}
