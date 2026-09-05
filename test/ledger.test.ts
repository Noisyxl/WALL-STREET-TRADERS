import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger/positions.js";
import { reconcile, reconcileCash } from "../src/agents/seats/clerk.js";
import type { Execution, Receipt } from "../src/types.js";

const exec = (
  symbol: string,
  side: "buy" | "sell",
  size: number,
  price: number,
  id = "t",
): Execution => ({
  ticketId: id,
  symbol,
  side,
  fills: [{ ts: 0, price, size, level: 0 }],
  avgPrice: price,
  filledSize: size,
  requestedSize: size,
  slippageBps: 0,
});

test("adding to a position moves the average and realises nothing", () => {
  const l = new Ledger(100_000);
  assert.equal(l.apply(exec("A", "buy", 100, 10)), 0);
  assert.equal(l.apply(exec("A", "buy", 100, 12)), 0);
  const p = l.get("A")!;
  assert.equal(p.size, 200);
  assert.equal(p.avgPrice, 11);
  assert.equal(l.realised, 0);
});

test("reducing a position realises against the average", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 200, 10));
  const realised = l.apply(exec("A", "sell", 100, 12));
  assert.equal(realised, 200);
  assert.equal(l.realised, 200);
  assert.equal(l.get("A")!.size, 100);
  assert.equal(l.get("A")!.avgPrice, 10, "the average of what is left does not move");
});

test("a fill that crosses zero closes the old position and opens a new one", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 100, 10));
  // Sell 150 at 12: 100 closes for +200, 50 opens short at 12.
  const realised = l.apply(exec("A", "sell", 150, 12));
  assert.equal(realised, 200, "only the closing part realises");
  const p = l.get("A")!;
  assert.equal(p.size, -50);
  assert.equal(p.avgPrice, 12, "the new short starts at the fill price, not the old average");
});

test("closing a position flat leaves nothing behind", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 100, 10));
  l.apply(exec("A", "sell", 100, 9));
  assert.equal(l.get("A"), undefined);
  assert.equal(l.realised, -100);
  assert.equal(l.openNames, 0);
});

test("a short that goes the right way realises a gain", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "sell", 100, 10));
  const realised = l.apply(exec("A", "buy", 100, 8));
  assert.equal(realised, 200);
});

test("equity is cash plus realised plus unrealised, and fees come out of cash", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 100, 10), { feeBps: 10 }); // 1000 notional, 1.00 fee
  assert.equal(l.feesPaid, 1);
  assert.equal(l.cashBalance, 100_000 - 1_000 - 1);
  assert.equal(l.unrealised({ A: 11 }), 100);
  assert.equal(l.sessionPnl({ A: 11 }), 99);
  assert.equal(l.equity({ A: 11 }), 100_099);
});

test("gross and net see a hedge differently", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 100, 10));
  l.apply(exec("B", "sell", 100, 10));
  const e = l.exposure({ A: 10, B: 10 });
  assert.equal(e.gross, 2_000);
  assert.equal(e.net, 0);
});

// ── the clerk ────────────────────────────────────────────────────────────────

const receiptOf = (e: Execution, seq: number): Receipt => ({
  seq,
  ts: 0,
  kind: "order.done",
  seat: "exec",
  body: { execution: e },
  hash: "",
  prev: "",
});

test("the clerk agrees with the ledger when nothing is wrong", () => {
  const l = new Ledger(100_000);
  const a = exec("A", "buy", 100, 10);
  const b = exec("A", "sell", 40, 11);
  l.apply(a);
  l.apply(b);
  const r = reconcile([receiptOf(a, 0), receiptOf(b, 1)], l.list());
  assert.equal(r.ok, true);
  assert.equal(r.checked, 2);
});

test("the clerk catches a position with no fill behind it", () => {
  const l = new Ledger(100_000);
  const a = exec("A", "buy", 100, 10);
  l.apply(a);
  l.apply(exec("GHOST", "buy", 50, 5));
  const r = reconcile([receiptOf(a, 0)], l.list());
  assert.equal(r.ok, false);
  assert.equal(r.breaks[0]!.kind, "orphan");
  assert.equal(r.breaks[0]!.symbol, "GHOST");
});

test("the clerk catches a size that does not match its receipts", () => {
  const l = new Ledger(100_000);
  const a = exec("A", "buy", 100, 10);
  l.apply(a);
  const doubled = receiptOf(exec("A", "buy", 200, 10), 0);
  const r = reconcile([doubled], l.list());
  assert.equal(r.ok, false);
  assert.equal(r.breaks[0]!.kind, "size");
});

test("cash rebuilt from executions matches the ledger to the cent", () => {
  const l = new Ledger(100_000);
  l.apply(exec("A", "buy", 100, 10.37), { feeBps: 7 });
  l.apply(exec("A", "sell", 60, 11.02), { feeBps: 7 });
  const b = reconcileCash(100_000, l.executions, l.feesPaid, l.cashBalance);
  assert.equal(b, null);
});
