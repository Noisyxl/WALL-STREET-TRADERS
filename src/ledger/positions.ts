import type { Execution, Mark, Position } from "../types.js";

/**
 * The book of record.
 *
 * Two rules decide everything in this file, and both exist because getting
 * them wrong is how a paper session quietly reports a profit it did not make:
 *
 *   1. A fill that reduces a position realises P&L against the average price.
 *      A fill that increases one only moves the average. Nothing else realises.
 *
 *   2. A fill that crosses through zero is two events, not one: the old
 *      position is closed at the fill price and realised, and whatever is left
 *      opens a new position on the other side at that same price. Treating it
 *      as one event is the classic way to book a phantom gain on a reversal.
 *
 * Cash is tracked alongside so equity is never inferred from positions:
 * equity = starting cash + realised + unrealised, and the three are printed
 * separately at the close.
 */

export class Ledger {
  private readonly positions = new Map<string, Position>();
  private readonly startingEquity: number;
  private cash: number;
  private realisedTotal = 0;
  private fees = 0;

  /** Every execution, kept for the close summary and the overnight scorer. */
  readonly executions: Execution[] = [];

  constructor(startingEquity: number) {
    this.startingEquity = startingEquity;
    this.cash = startingEquity;
  }

  get openNames(): number {
    return [...this.positions.values()].filter((p) => p.size !== 0).length;
  }

  get realised(): number {
    return +this.realisedTotal.toFixed(2);
  }

  get feesPaid(): number {
    return +this.fees.toFixed(2);
  }

  get cashBalance(): number {
    return +this.cash.toFixed(2);
  }

  list(): Position[] {
    return [...this.positions.values()].filter((p) => p.size !== 0);
  }

  get(symbol: string): Position | undefined {
    const p = this.positions.get(symbol);
    return p && p.size !== 0 ? p : undefined;
  }

  /**
   * Apply an execution. Returns the realised P&L this execution produced,
   * which is zero for anything that only increases a position.
   */
  apply(exec: Execution, opts: { feeBps?: number } = {}): number {
    if (exec.filledSize <= 0) return 0;

    const feeBps = opts.feeBps ?? 0;
    const signed = exec.side === "buy" ? exec.filledSize : -exec.filledSize;
    const price = exec.avgPrice;
    const notional = Math.abs(signed) * price;
    const fee = (notional * feeBps) / 10_000;

    this.fees += fee;
    this.cash -= signed * price + fee;

    const existing = this.positions.get(exec.symbol);
    let realised = 0;

    if (!existing || existing.size === 0) {
      this.positions.set(exec.symbol, {
        symbol: exec.symbol,
        size: signed,
        avgPrice: price,
        realised: existing?.realised ?? 0,
        openedBy: exec.ticketId,
        openedAt: exec.fills[0]?.ts ?? Date.now(),
      });
    } else if (Math.sign(existing.size) === Math.sign(signed)) {
      // Adding. Only the average moves.
      const totalSize = existing.size + signed;
      existing.avgPrice =
        (existing.avgPrice * existing.size + price * signed) / totalSize;
      existing.size = totalSize;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(existing.size));
      // Rule 1: realise against the average, in the direction the old position held.
      realised = (price - existing.avgPrice) * closing * Math.sign(existing.size);
      existing.realised += realised;
      this.realisedTotal += realised;

      const remaining = Math.abs(signed) - closing;
      if (remaining > 0) {
        // Rule 2: crossing zero opens a fresh position at the fill price.
        existing.size = Math.sign(signed) * remaining;
        existing.avgPrice = price;
        existing.openedBy = exec.ticketId;
        existing.openedAt = exec.fills[0]?.ts ?? Date.now();
      } else {
        existing.size += signed;
        if (existing.size === 0) existing.avgPrice = 0;
      }
    }

    this.executions.push(exec);
    return +realised.toFixed(2);
  }

  /** Mark the book against the current tape. */
  marks(prices: Record<string, number>): Mark[] {
    return this.list().map((p) => {
      const last = prices[p.symbol] ?? p.avgPrice;
      const unrealised = (last - p.avgPrice) * p.size;
      const cost = Math.abs(p.avgPrice * p.size);
      return {
        symbol: p.symbol,
        size: p.size,
        avgPrice: +p.avgPrice.toFixed(4),
        last,
        unrealised: +unrealised.toFixed(2),
        unrealisedPct: cost > 0 ? +((unrealised / cost) * 100).toFixed(2) : 0,
      };
    });
  }

  unrealised(prices: Record<string, number>): number {
    return +this.marks(prices).reduce((s, m) => s + m.unrealised, 0).toFixed(2);
  }

  /** Session P&L: realised plus unrealised, fees already taken out of cash. */
  sessionPnl(prices: Record<string, number>): number {
    return +(this.realisedTotal + this.unrealised(prices) - this.fees).toFixed(2);
  }

  equity(prices: Record<string, number>): number {
    return +(this.startingEquity + this.sessionPnl(prices)).toFixed(2);
  }

  /** Gross and net exposure, marked. */
  exposure(prices: Record<string, number>): { gross: number; net: number } {
    let gross = 0;
    let net = 0;
    for (const p of this.list()) {
      const value = p.size * (prices[p.symbol] ?? p.avgPrice);
      gross += Math.abs(value);
      net += value;
    }
    return { gross: +gross.toFixed(2), net: +net.toFixed(2) };
  }
}
