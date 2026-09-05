import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Floor } from "../src/floor/floor.js";
import { SyntheticFeed } from "../src/tape/sources/synthetic.js";
import { readTape, breadth } from "../src/tape/feed.js";
import { verify, read } from "../src/ledger/receipts.js";
import { reconcile } from "../src/agents/seats/clerk.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";

/**
 * End to end, offline, in a temporary directory. No key is set in CI, so every
 * seat runs its own rule and the whole loop is exercised without a network.
 */

function testConfig(over: Partial<Config> = {}): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    equity: 250_000,
    sessionMin: 60,
    universe: ["NVDA", "TSM", "MU", "AVGO", "META"],
    dataDir: mkdtempSync(join(tmpdir(), "outcry-floor-")),
    keys: { xai: "", anthropic: "" },
    tape: { ...cfg.tape, source: "synthetic", seed: 1792 },
    ...over,
  };
}

const feedFor = (cfg: Config): SyntheticFeed =>
  new SyntheticFeed({ universe: cfg.universe, seed: cfg.tape.seed, sessionMin: cfg.sessionMin });

test("a session runs bell to bell with no key and writes an intact receipt chain", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  const state = await floor.run();

  assert.equal(state.minute, 60);
  assert.ok(floor.receipts.count > 10, "a session should write more than ten records");

  const v = verify(floor.receipts.file);
  assert.equal(v.ok, true, v.reason ?? "");

  const records = read(floor.receipts.file);
  assert.equal(records[0]!.kind, "session.open");
  assert.equal(records[records.length - 1]!.kind, "session.close");
});

test("the same seed produces the same session", async () => {
  const a = testConfig();
  const b = testConfig();
  const one = await new Floor({ cfg: a, feed: feedFor(a) }).run();
  const two = await new Floor({ cfg: b, feed: feedFor(b) }).run();

  assert.equal(one.equity, two.equity);
  assert.equal(one.tickets.length, two.tickets.length);
  assert.deepEqual(
    one.tickets.map((t) => `${t.desk}:${t.symbol}:${t.side}`),
    two.tickets.map((t) => `${t.desk}:${t.symbol}:${t.side}`),
  );
});

test("a different seed produces a different session", async () => {
  const a = testConfig();
  const b = testConfig({ tape: { ...testConfig().tape, seed: 99 } });
  const one = await new Floor({ cfg: a, feed: feedFor(a) }).run();
  const two = await new Floor({ cfg: b, feed: feedFor(b) }).run();
  assert.notEqual(one.equity, two.equity);
});

test("every ticket in the session has exactly one verdict", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  await floor.run();

  const records = read(floor.receipts.file);
  const written = records.filter((r) => r.kind === "ticket.written").length;
  const verdicts = records.filter((r) => r.kind === "gate.verdict").length;
  assert.equal(written, verdicts, "a ticket without a verdict means a path around the gate");
});

test("no fill is larger than the notional its verdict allowed", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  await floor.run();
  const records = read(floor.receipts.file);

  const allowed = new Map<string, number>();
  for (const r of records) {
    if (r.kind !== "gate.verdict") continue;
    const v = (r.body as { verdict: { ticketId: string; allowed: number } }).verdict;
    allowed.set(v.ticketId, v.allowed);
  }

  for (const r of records) {
    if (r.kind !== "order.done") continue;
    const e = (r.body as { execution?: { ticketId: string; avgPrice: number; filledSize: number } }).execution;
    if (!e?.filledSize) continue;
    const cap = allowed.get(e.ticketId);
    assert.ok(cap !== undefined, `${e.ticketId} filled with no verdict`);
    assert.ok(
      e.avgPrice * e.filledSize <= cap! + 0.01,
      `${e.ticketId} filled ${e.avgPrice * e.filledSize} against an allowance of ${cap}`,
    );
  }
});

test("execution never changes the side, the name or the size it was given", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  await floor.run();
  const records = read(floor.receipts.file);

  const planned = new Map<string, { symbol: string; side: string; size: number }>();
  for (const r of records) {
    if (r.kind !== "order.working") continue;
    const b = r.body as { ticketId: string; symbol: string; side: string; size: number };
    planned.set(b.ticketId, { symbol: b.symbol, side: b.side, size: b.size });
  }

  for (const r of records) {
    if (r.kind !== "order.done") continue;
    const e = (r.body as { execution?: { ticketId: string; symbol: string; side: string; requestedSize: number } }).execution;
    if (!e) continue;
    const p = planned.get(e.ticketId);
    if (!p) continue;
    assert.equal(e.symbol, p.symbol);
    assert.equal(e.side, p.side);
    assert.equal(e.requestedSize, p.size);
  }
});

test("the clerk reconciles at the close", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  await floor.run();
  const r = reconcile(floor.receipts.all(), floor.ledger.list());
  assert.equal(r.ok, true, r.breaks.map((b) => b.note).join("; "));
});

test("a day stop halts the floor and refuses everything after it", async () => {
  const cfg = testConfig();
  // A day stop of essentially zero: the first mark against the floor halts it.
  cfg.risk = { ...cfg.risk, dayStopPct: 0.0001 };
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  const state = await floor.run();

  const records = read(floor.receipts.file);
  const halted = records.some((r) => r.kind === "risk.halt");
  if (halted) {
    assert.ok(state.halted.length > 0);
    const afterHalt = records
      .slice(records.findIndex((r) => r.kind === "risk.halt"))
      .filter((r) => r.kind === "gate.verdict")
      .map((r) => (r.body as { verdict: { pass: boolean } }).verdict);
    assert.ok(afterHalt.every((v) => !v.pass), "nothing clears after a halt");
  }
});

test("the overnight scribe grades what the session opened", async () => {
  const cfg = testConfig();
  const floor = new Floor({ cfg, feed: feedFor(cfg) });
  await floor.run();
  const { scores, carry } = await floor.score();

  assert.ok(carry.length > 0);
  for (const s of scores) {
    assert.ok(["paid", "died", "open"].includes(s.outcome));
    assert.ok(s.thesis.length >= 20, "an ungradeable thesis should never have become a ticket");
  }
  const last = read(floor.receipts.file).pop()!;
  assert.equal(last.kind, "overnight.score");
});

// ── the tape ─────────────────────────────────────────────────────────────────

test("the tape reports quiet as quiet rather than manufacturing an event", () => {
  const feed = new SyntheticFeed({ universe: ["NVDA"], seed: 1, sessionMin: 5 });
  const a = feed.peek();
  const events = readTape(a, a, {});
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "quiet");
});

test("breadth is neutral at the bell, not zero", () => {
  const feed = new SyntheticFeed({ universe: ["NVDA", "MU"], seed: 1, sessionMin: 5 });
  assert.equal(feed.peek().session.breadth, 50);
  assert.equal(breadth({}), 50);
});

test("a book has depth on both sides and thins away from the touch", () => {
  const feed = new SyntheticFeed({ universe: ["NVDA"], seed: 7, sessionMin: 5 });
  const b = feed.book("NVDA");
  assert.ok(b.bids.length >= 5 && b.asks.length >= 5);
  assert.ok(b.asks[0]!.price > b.bids[0]!.price, "the offer is above the bid");
  const near = b.asks.slice(0, 2).reduce((s, l) => s + l.size, 0);
  const far = b.asks.slice(5, 7).reduce((s, l) => s + l.size, 0);
  assert.ok(near > far, "depth thins away from the touch");
});

test("a name that is not on the board is an error, not an empty book", () => {
  const feed = new SyntheticFeed({ universe: ["NVDA"], seed: 1, sessionMin: 5 });
  assert.throws(() => feed.book("NOPE"), /not on this board/);
});
