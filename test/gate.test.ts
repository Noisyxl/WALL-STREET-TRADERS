import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Gate, applyReview } from "../src/risk/gate.js";
import { checkHard, exposureOf } from "../src/risk/limits.js";
import { var95 } from "../src/risk/var.js";
import type { Position, Ticket, Verdict } from "../src/types.js";
import type { RiskLimits } from "../src/config.js";

const LIMITS: RiskLimits = {
  maxTicketPct: 4,
  maxPositionPct: 12,
  maxGrossPct: 90,
  maxNetPct: 60,
  maxNames: 8,
  dayStopPct: 3,
  queueDepth: 6,
};

const EQUITY = 100_000;

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "Q-0001-TEST",
  ts: 0,
  desk: "quant",
  symbol: "TEST",
  side: "buy",
  notional: 3_000,
  thesis: "a falsifiable sentence with a number in it, 1.4% behind the board",
  horizonMin: 30,
  conviction: 55,
  state: "written",
  ...over,
});

const flat = () => exposureOf([], {}, EQUITY, 0);

test("a ticket inside every limit clears for what it asked", () => {
  const r = checkHard(ticket(), flat(), LIMITS, 0);
  assert.equal(r.pass, true);
  assert.equal(r.allowed, 3_000);
});

test("a ticket over the per-ticket cap is trimmed, not refused", () => {
  const r = checkHard(ticket({ notional: 9_000 }), flat(), LIMITS, 0);
  assert.equal(r.pass, true);
  assert.equal(r.allowed, 4_000);
  assert.ok(r.reasons.some((x) => x.includes("ticket trimmed")));
});

test("the day stop refuses everything once the session loss reaches it", () => {
  const exp = exposureOf([], {}, EQUITY, -3_000);
  const r = checkHard(ticket(), exp, LIMITS, 0);
  assert.equal(r.pass, false);
  assert.equal(r.refusedBy, "dayStop");
});

test("the name cap trims to the room left and refuses when there is none", () => {
  const positions: Position[] = [
    { symbol: "TEST", size: 100, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
  ];
  const exp = exposureOf(positions, { TEST: 100 }, EQUITY, 0);
  const trimmed = checkHard(ticket({ notional: 4_000 }), exp, LIMITS, 0);
  assert.equal(trimmed.pass, true);
  assert.equal(trimmed.allowed, 2_000, "12% of 100k is 12k, 10k is on, 2k of room");

  const full: Position[] = [
    { symbol: "TEST", size: 120, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
  ];
  const none = checkHard(ticket(), exposureOf(full, { TEST: 100 }, EQUITY, 0), LIMITS, 0);
  assert.equal(none.pass, false);
  assert.equal(none.refusedBy, "position");
});

test("a ticket that reduces a position is not measured against the name cap", () => {
  const positions: Position[] = [
    { symbol: "TEST", size: 130, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
  ];
  const exp = exposureOf(positions, { TEST: 100 }, EQUITY, 0);
  const r = checkHard(ticket({ side: "sell", notional: 3_000 }), exp, LIMITS, 0);
  assert.equal(r.pass, true, r.reasons.join(" | "));
  assert.ok(r.reasons.some((x) => x.includes("reduces")));
});

test("a new name is refused when the name count is full", () => {
  const exp = flat();
  exp.names = 8;
  const r = checkHard(ticket({ symbol: "NEW" }), exp, LIMITS, 0);
  assert.equal(r.pass, false);
  assert.equal(r.refusedBy, "names");
});

test("a backed-up gate refuses rather than queueing further", () => {
  const r = checkHard(ticket(), flat(), LIMITS, 7);
  assert.equal(r.pass, false);
  assert.equal(r.refusedBy, "queue");
});

// ── the invariant ────────────────────────────────────────────────────────────

const cleared: Verdict = {
  ticketId: "Q-0001-TEST",
  ts: 0,
  pass: true,
  allowed: 4_000,
  reasons: ["ticket size ok"],
};

test("a review can lower the allowance", () => {
  const v = applyReview(cleared, { verdict: "trim", allowed: 1_500, note: "correlated", model: "m" });
  assert.equal(v.pass, true);
  assert.equal(v.allowed, 1_500);
});

test("a review CANNOT raise the allowance", () => {
  const v = applyReview(cleared, { verdict: "clear", allowed: 999_999, note: "looks great", model: "m" });
  assert.equal(v.allowed, 4_000, "the hard limit stands");
  assert.ok(v.reasons.some((r) => r.includes("review ignored")));
});

test("a review can refuse outright", () => {
  const v = applyReview(cleared, { verdict: "refuse", note: "horizon past the close", model: "m" });
  assert.equal(v.pass, false);
  assert.equal(v.allowed, 0);
  assert.equal(v.refusedBy, "review");
});

test("an unreadable review is treated as a refusal, not as a pass", () => {
  const v = applyReview(cleared, { verdict: "maybe later", note: "hmm", model: "m" });
  assert.equal(v.pass, false);
  assert.equal(v.refusedBy, "review");
});

test("a reviewer that throws leaves the hard limits standing", async () => {
  const gate = new Gate({
    limits: LIMITS,
    equity: EQUITY,
    reviewer: async () => {
      throw new Error("429 rate limited");
    },
  });
  const v = await gate.decide(ticket(), [], {}, 0);
  assert.equal(v.pass, true);
  assert.equal(v.allowed, 3_000);
  assert.ok(v.reasons.some((r) => r.includes("review unavailable")));
});

test("a reviewer that returns nothing leaves the hard limits standing", async () => {
  const gate = new Gate({ limits: LIMITS, equity: EQUITY, reviewer: async () => null });
  const v = await gate.decide(ticket(), [], {}, 0);
  assert.equal(v.pass, true);
  assert.ok(v.reasons.some((r) => r.includes("review skipped")));
});

test("a halted gate refuses every further ticket for the session", async () => {
  const gate = new Gate({ limits: LIMITS, equity: EQUITY });
  const first = await gate.decide(ticket(), [], {}, -5_000);
  assert.equal(first.refusedBy, "dayStop");
  assert.equal(gate.isHalted, true);
  const second = await gate.decide(ticket(), [], {}, 0);
  assert.equal(second.pass, false);
  assert.equal(second.refusedBy, "halt");
});

test("the gate cannot be bypassed: nothing outside floor.ts reaches the ledger", () => {
  // Read the source rather than trusting a convention. If someone adds a second
  // path from a ticket to a fill, this fails and names the file.
  const floor = readFileSync(new URL("../src/floor/floor.ts", import.meta.url), "utf8");
  const applyCalls = floor.match(/ledger\.apply\(/g) ?? [];
  assert.equal(applyCalls.length, 1, "there must be exactly one call to ledger.apply, in work()");
  const decideCalls = floor.match(/gate\.decide\(/g) ?? [];
  assert.equal(decideCalls.length, 1, "there must be exactly one call to gate.decide, in throughGate()");
  assert.ok(!/--no-gate|skipGate|bypassGate/.test(floor), "there is no gate bypass flag");
});

// ── VaR ──────────────────────────────────────────────────────────────────────

test("VaR nets a hedge down and the parts add to the whole", () => {
  const long: Position[] = [
    { symbol: "A", size: 100, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
    { symbol: "B", size: 100, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
  ];
  const hedged: Position[] = [
    { symbol: "A", size: 100, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
    { symbol: "B", size: -100, avgPrice: 100, realised: 0, openedBy: "x", openedAt: 0 },
  ];
  const marks = { A: 100, B: 100 };
  const vols = { A: 40, B: 40 };

  const a = var95({ positions: long, marks, vols });
  const b = var95({ positions: hedged, marks, vols });
  assert.ok(b.var95 < a.var95, "a hedged book risks less than an outright one");
  assert.ok(a.diversification >= 0);

  const sum = a.contributions.reduce((s, c) => s + c.var95, 0);
  assert.ok(Math.abs(sum - a.var95) < 0.5, "contributions add to the total");
});
