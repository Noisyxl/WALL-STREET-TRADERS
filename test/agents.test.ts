import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, num, str, loadPrompt } from "../src/agents/agent.js";
import { providerFor, StubProvider } from "../src/agents/provider.js";
import { ROSTER, canWriteTickets, seatSpec } from "../src/agents/roster.js";
import { movePct, outcomeOf } from "../src/agents/seats/scribe.js";
import type { Seat } from "../src/types.js";

test("JSON is found inside prose, fences and trailing chatter", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```\nHope that helps.'), { a: 1 });
  assert.deepEqual(extractJson('I think:\n{"a":[1,2]}\nthat is all'), { a: [1, 2] });
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
});

test("a brace inside a string does not end the object", () => {
  assert.deepEqual(extractJson('{"note":"a } inside"}'), { note: "a } inside" });
  assert.deepEqual(extractJson('{"note":"an escaped \\" quote"}'), { note: 'an escaped " quote' });
});

test("unparseable text returns null rather than a guess", () => {
  assert.equal(extractJson("no json here at all"), null);
  assert.equal(extractJson('{"a": '), null);
  assert.equal(extractJson(""), null);
});

test("numbers from a model are clamped into range or refused", () => {
  assert.equal(num(5, 0, 10), 5);
  assert.equal(num(50, 0, 10), 10);
  assert.equal(num("7", 0, 10), 7);
  assert.equal(num("about seven", 0, 10), null);
  assert.equal(num(null, 0, 10), null);
  assert.equal(num(Infinity, 0, 10), null);
});

test("empty strings are refused, long ones are cut", () => {
  assert.equal(str("  ok  "), "ok");
  assert.equal(str("   "), null);
  assert.equal(str(42 as unknown), null);
  assert.equal(str("x".repeat(500), 10)?.length, 10);
});

test("a model name routes itself to a wire format", () => {
  assert.equal(providerFor("claude-opus-4-5"), "anthropic");
  assert.equal(providerFor("grok-4.1-fast"), "xai");
  assert.equal(providerFor("some-local-model"), "xai");
});

test("the stub provider answers without a key and says so", async () => {
  const p = new StubProvider(() => "offline answer");
  const r = await p.complete("any-model", { system: "s", user: "u" });
  assert.equal(r.provider, "stub");
  assert.match(r.model, /:stub$/);
});

test("there are twelve seats and only the four desks may write a ticket", () => {
  assert.equal(ROSTER.length, 12);
  const writers = ROSTER.filter((s) => canWriteTickets(s.seat)).map((s) => s.seat);
  assert.deepEqual(writers.sort(), ["credit", "digital", "macro", "quant"]);
});

test("every seat states what it cannot do", () => {
  for (const s of ROSTER) {
    assert.ok(s.cannot.length > 5, `${s.seat} has no stated limit`);
    assert.ok(s.does.length > 5, `${s.seat} has no stated job`);
  }
});

test("every seat but the clerk has a prompt on disk", () => {
  for (const s of ROSTER) {
    if (s.seat === "clerk") continue;
    const text = loadPrompt(s.seat as Seat);
    assert.ok(text.length > 200, `${s.seat}.md is too short to be a real prompt`);
  }
});

test("the clerk has no prompt, because it has no model", () => {
  assert.equal(seatSpec("clerk").chair, "floor");
  assert.throws(() => loadPrompt("clerk"), /prompt for the clerk seat not found/);
});

test("every desk prompt demands a falsifiable thesis", () => {
  for (const desk of ["quant", "macro", "credit", "digital"] as const) {
    const text = loadPrompt(desk);
    assert.match(text, /thesis/i, `${desk}.md does not mention a thesis`);
    assert.match(text, /is not/i, `${desk}.md does not give a counter-example`);
  }
});

test("the risk prompt states the invariant the code enforces", () => {
  const text = loadPrompt("risk");
  assert.match(text, /cannot raise it/i);
});

// ── the scribe's arithmetic ──────────────────────────────────────────────────

const closed = (over: Partial<Parameters<typeof movePct>[0]> = {}) => ({
  ticketId: "Q-0001-A",
  symbol: "A",
  desk: "quant" as const,
  side: "buy" as const,
  thesis: "a thesis long enough to be graded",
  entryPrice: 100,
  horizonMin: 30,
  horizonPrice: 101,
  truncated: false,
  ...over,
});

test("a move is signed for the direction the desk took", () => {
  assert.equal(movePct(closed()), 1);
  assert.equal(movePct(closed({ side: "sell" })), -1);
  assert.equal(movePct(closed({ side: "sell", horizonPrice: 99 })), 1);
});

test("a thesis pays only when the move beats the round trip", () => {
  assert.equal(outcomeOf(closed({ horizonPrice: 101 })), "paid");
  assert.equal(outcomeOf(closed({ horizonPrice: 100.05 })), "died");
  assert.equal(outcomeOf(closed({ horizonPrice: 99 })), "died");
});

test("a thesis whose horizon outlived the session is open, not graded", () => {
  assert.equal(outcomeOf(closed({ truncated: true, horizonPrice: 110 })), "open");
});
