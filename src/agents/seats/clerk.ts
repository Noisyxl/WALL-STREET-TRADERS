import type { Execution, Position, Receipt } from "../../types.js";

/**
 * The clerk.
 *
 * The only seat with no model, no prompt and no temperature. It reconciles
 * what the ledger believes against what the receipts say happened, and it is
 * arithmetic on purpose: the seat whose job is to catch the floor lying to
 * itself cannot be the kind of thing that can be talked into an answer.
 *
 * It runs after every execution and again at the close. A break here is not a
 * warning, it is a halt — a floor that cannot reconcile its own fills has
 * nothing left worth protecting.
 */

export interface Break {
  kind: "size" | "cash" | "orphan" | "unknown-fill";
  symbol: string;
  expected: number;
  found: number;
  note: string;
}

export interface Reconciliation {
  ok: boolean;
  checked: number;
  breaks: Break[];
}

const EPS = 0.005;

/**
 * Rebuild the position book from the fill receipts alone and compare it, name
 * by name, with the ledger's own state. Two independent paths to the same
 * number: if they disagree, one of them is wrong and neither is trusted.
 */
export function reconcile(receipts: readonly Receipt[], positions: Position[]): Reconciliation {
  const fromReceipts = new Map<string, number>();
  let checked = 0;

  for (const r of receipts) {
    if (r.kind !== "order.done") continue;
    const body = r.body as unknown as { execution?: Execution };
    const exec = body.execution;
    if (!exec || typeof exec.filledSize !== "number") continue;
    checked++;
    const signed = exec.side === "buy" ? exec.filledSize : -exec.filledSize;
    fromReceipts.set(exec.symbol, (fromReceipts.get(exec.symbol) ?? 0) + signed);
  }

  const breaks: Break[] = [];
  const ledger = new Map(positions.map((p) => [p.symbol, p.size]));

  for (const [symbol, expected] of fromReceipts) {
    const found = ledger.get(symbol) ?? 0;
    if (Math.abs(expected - found) > EPS) {
      breaks.push({
        kind: "size",
        symbol,
        expected,
        found,
        note: `receipts add to ${expected} shares, the ledger holds ${found}`,
      });
    }
  }

  for (const [symbol, found] of ledger) {
    if (!fromReceipts.has(symbol) && Math.abs(found) > EPS) {
      breaks.push({
        kind: "orphan",
        symbol,
        expected: 0,
        found,
        note: `the ledger holds ${found} shares with no fill receipt behind them`,
      });
    }
  }

  return { ok: breaks.length === 0, checked, breaks };
}

/**
 * Cash check. Starting equity, minus everything spent, plus everything
 * received, minus fees, has to equal the ledger's cash to the cent.
 */
export function reconcileCash(
  startingEquity: number,
  executions: readonly Execution[],
  feesPaid: number,
  ledgerCash: number,
): Break | null {
  let cash = startingEquity;
  for (const e of executions) {
    const signed = e.side === "buy" ? e.filledSize : -e.filledSize;
    cash -= signed * e.avgPrice;
  }
  cash -= feesPaid;
  const expected = +cash.toFixed(2);
  if (Math.abs(expected - ledgerCash) <= 0.01) return null;
  return {
    kind: "cash",
    symbol: "*",
    expected,
    found: ledgerCash,
    note: `cash rebuilt from ${executions.length} executions is ${expected}, the ledger says ${ledgerCash}`,
  };
}
