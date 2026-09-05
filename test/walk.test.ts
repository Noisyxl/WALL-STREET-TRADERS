import { test } from "node:test";
import assert from "node:assert/strict";
import { walk, compare, sizeForNotional, ladderOf } from "../src/book/walk.js";
import { spreadBps, imbalance, clearingPrice, mid } from "../src/book/book.js";
import type { BookState } from "../src/types.js";

/** A hand-written book, so every expected number below can be checked by hand. */
const book: BookState = {
  symbol: "TEST",
  ts: 0,
  bids: [
    { price: 99.99, size: 100 },
    { price: 99.98, size: 200 },
    { price: 99.97, size: 300 },
  ],
  asks: [
    { price: 100.01, size: 100 },
    { price: 100.02, size: 200 },
    { price: 100.03, size: 300 },
  ],
};

const NO_REFRESH = { replenishPct: 0, participationPct: 100, minChild: 1, maxLevels: 5 };

test("a sweep pays the whole ladder and reports the average, not the touch", () => {
  const e = walk(book, "buy", 400, "t", { style: "sweep" });
  assert.equal(e.filledSize, 400);
  // 100 @ 100.01 + 200 @ 100.02 + 100 @ 100.03 = 40 008 / 400
  assert.equal(+e.avgPrice.toFixed(4), 100.02);
  assert.equal(e.fills.length, 3);
  assert.equal(e.fills[2]!.level, 2);
});

test("working with no refresh climbs the same ladder as a sweep, one rung at a time", () => {
  const e = walk(book, "buy", 400, "t", { style: "work", ...NO_REFRESH });
  const s = walk(book, "buy", 400, "t", { style: "sweep" });
  assert.equal(e.filledSize, s.filledSize);
  assert.equal(e.avgPrice, s.avgPrice);
});

test("working with a refreshing book fills more of the order at the touch", () => {
  const work = walk(book, "buy", 400, "t", {
    style: "work",
    participationPct: 20,
    replenishPct: 60,
    maxLevels: 5,
    minChild: 1,
  });
  const sweep = walk(book, "buy", 400, "t", { style: "sweep" });
  assert.equal(work.filledSize, 400);
  assert.ok(
    work.avgPrice < sweep.avgPrice,
    `working should beat sweeping when the book refreshes: ${work.avgPrice} vs ${sweep.avgPrice}`,
  );
  // Most of the order should have printed at the first two levels.
  const atTouch = work.fills.filter((f) => f.level === 0).reduce((s, f) => s + f.size, 0);
  assert.ok(atTouch > 100, `the touch showed 100 and refreshed; got ${atTouch}`);
});

test("the refresh assumption is a parameter: at zero the advantage disappears", () => {
  const withRefresh = compare(book, "buy", 400, { participationPct: 20, replenishPct: 60 });
  const without = compare(book, "buy", 400, { participationPct: 20, replenishPct: 0 });
  assert.ok(withRefresh.savedBps > 0);
  assert.ok(
    without.savedBps <= withRefresh.savedBps,
    "a book that never comes back cannot make working better",
  );
});

test("a limit stops the order rather than paying through it", () => {
  const e = walk(book, "buy", 400, "t", { style: "sweep", limit: 100.02 });
  assert.equal(e.filledSize, 300);
  assert.match(e.unfilledReason ?? "", /limit 100\.02 reached at level 2/);
  for (const f of e.fills) assert.ok(f.price <= 100.02);
});

test("a sell walks the bids downward and its slippage is signed the same way", () => {
  const e = walk(book, "sell", 400, "t", { style: "sweep" });
  assert.equal(e.filledSize, 400);
  // 100 @ 99.99 + 200 @ 99.98 + 100 @ 99.97 = 39 992 / 400
  assert.equal(+e.avgPrice.toFixed(4), 99.98);
  assert.ok(e.slippageBps > 0, "selling into the book costs, and cost is positive");
});

test("an order larger than the book reports what it could not fill", () => {
  const e = walk(book, "buy", 10_000, "t", { style: "sweep" });
  assert.equal(e.filledSize, 600);
  assert.match(e.unfilledReason ?? "", /book exhausted/);
});

test("child orders never exceed participation of the displayed size", () => {
  const e = walk(book, "buy", 600, "t", {
    style: "work",
    participationPct: 10,
    replenishPct: 0,
    maxLevels: 5,
    minChild: 1,
  });
  for (const f of e.fills) {
    const displayed = book.asks[f.level]!.size;
    assert.ok(
      f.size <= Math.max(1, Math.floor((displayed * 10) / 100)),
      `child of ${f.size} at level ${f.level} showing ${displayed}`,
    );
  }
});

test("a high refresh rate cannot loop forever", () => {
  const e = walk(book, "buy", 1_000_000, "t", {
    style: "work",
    participationPct: 10,
    replenishPct: 99,
    maxLevels: 5,
    minChild: 1,
  });
  assert.ok(e.fills.length <= 400);
  assert.match(e.unfilledReason ?? "", /child orders/);
});

test("sizeForNotional never buys more than the money on the table", () => {
  const n = sizeForNotional(book, "buy", 10_000);
  const e = walk(book, "buy", n, "t", { style: "sweep" });
  assert.ok(e.avgPrice * e.filledSize <= 10_000 + 0.01);
});

test("the ladder collapses repeated prints at one level", () => {
  const e = walk(book, "buy", 200, "t", {
    style: "work",
    participationPct: 10,
    replenishPct: 60,
    maxLevels: 5,
    minChild: 1,
  });
  const rendered = ladderOf(e);
  assert.match(rendered, /100\.01x\d+/);
});

test("book arithmetic: mid, spread and imbalance", () => {
  assert.equal(mid(book), 100);
  assert.equal(spreadBps(book), 2);
  assert.equal(imbalance(book), 0);
  assert.equal(clearingPrice(book, "buy", 250), 100.02);
});
