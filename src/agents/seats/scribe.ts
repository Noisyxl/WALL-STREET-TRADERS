import type { Desk, ThesisScore } from "../../types.js";
import type { Config } from "../../config.js";
import { Agent, extractJson, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";

/**
 * The scribe.
 *
 * Runs after the close, on the cheapest model on the floor, and does the one
 * job nobody wants: it reads yesterday's theses and says which of them were
 * right. Not which trades made money — which *theses* were right, which is a
 * different question and the more useful one. A thesis can be correct and lose
 * money on sizing, and a thesis can be nonsense and win.
 *
 * Its output is the only thing that carries from one session to the next.
 * Everything else — positions, posture, tape — starts again at the bell.
 */

export interface ClosedThesis {
  ticketId: string;
  symbol: string;
  desk: Desk;
  side: "buy" | "sell";
  thesis: string;
  entryPrice: number;
  horizonMin: number;
  /** Price at the end of the horizon, or at the close if the horizon ran past it. */
  horizonPrice: number;
  /** True when the session ended before the horizon did. */
  truncated: boolean;
}

export interface ScribeIn {
  sessionId: string;
  closed: ClosedThesis[];
}

export interface ScribeOut {
  scores: ThesisScore[];
  /** One line the next session's chief will read at the bell. */
  carry: string;
}

/** The arithmetic half. Signed for the direction the desk took. */
export function movePct(t: ClosedThesis): number {
  const raw = ((t.horizonPrice - t.entryPrice) / t.entryPrice) * 100;
  return +(t.side === "buy" ? raw : -raw).toFixed(3);
}

/** A thesis pays when the move went its way by more than the round trip costs. */
export function outcomeOf(t: ClosedThesis, threshold = 0.15): ThesisScore["outcome"] {
  if (t.truncated) return "open";
  const m = movePct(t);
  return m >= threshold ? "paid" : "died";
}

function briefOf(input: ScribeIn): string {
  const rows = input.closed
    .map((t) => {
      const m = movePct(t);
      return [
        `${t.ticketId} · ${t.desk} · ${t.side} ${t.symbol}`,
        `  thesis: ${t.thesis}`,
        `  entry ${t.entryPrice.toFixed(2)} → ${t.horizonPrice.toFixed(2)} over ${t.horizonMin} min = ${m >= 0 ? "+" : ""}${m.toFixed(2)}% in the desk's direction${t.truncated ? " (session ended first)" : ""}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `session ${input.sessionId}, ${input.closed.length} theses to grade`,
    "",
    rows || "(nothing was written)",
    "",
    "for each one say paid, died or open, and one clause on why the reasoning did or did not hold.",
    "grade the reasoning, not the P&L. a right thesis sized badly still paid.",
  ].join("\n");
}

function parseOut(text: string, closed: ClosedThesis[]): ScribeOut | null {
  const json = extractJson(text) as { scores?: unknown; carry?: unknown } | null;
  if (!json) return null;

  const byId = new Map(closed.map((c) => [c.ticketId, c]));
  const raw = Array.isArray(json.scores) ? json.scores : [];
  const scores: ThesisScore[] = [];

  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const row = s as Record<string, unknown>;
    const id = str(row.ticketId ?? row.ticket_id, 40);
    const source = id ? byId.get(id) : undefined;
    if (!source) continue;

    const outcomeRaw = str(row.outcome, 8)?.toLowerCase();
    // The arithmetic decides paid/died. The model only writes the note; a model
    // that disagrees with the tape about which way a price moved is overruled.
    const outcome = outcomeOf(source);
    if (outcomeRaw && outcomeRaw !== outcome) {
      // recorded, not obeyed
    }

    scores.push({
      ticketId: source.ticketId,
      symbol: source.symbol,
      desk: source.desk,
      thesis: source.thesis,
      outcome,
      movePct: movePct(source),
      note: str(row.note, 240) ?? "",
    });
  }

  const carry = str(json.carry, 240);
  if (scores.length === 0 && !carry) return null;
  return { scores, carry: carry ?? "" };
}

/** Offline: the arithmetic alone, with a note built from it. */
function fallback(input: ScribeIn): ScribeOut {
  const scores: ThesisScore[] = input.closed.map((t) => {
    const outcome = outcomeOf(t);
    const m = movePct(t);
    return {
      ticketId: t.ticketId,
      symbol: t.symbol,
      desk: t.desk,
      thesis: t.thesis,
      outcome,
      movePct: m,
      note:
        outcome === "open"
          ? `the session ended ${t.horizonMin} minutes before the horizon did`
          : `${m >= 0 ? "+" : ""}${m.toFixed(2)}% in the desk's direction over ${t.horizonMin} minutes`,
    };
  });

  const paid = scores.filter((s) => s.outcome === "paid").length;
  const died = scores.filter((s) => s.outcome === "died").length;
  const byDesk = new Map<string, { paid: number; total: number }>();
  for (const s of scores) {
    if (s.outcome === "open") continue;
    const e = byDesk.get(s.desk) ?? { paid: 0, total: 0 };
    e.total++;
    if (s.outcome === "paid") e.paid++;
    byDesk.set(s.desk, e);
  }
  const best = [...byDesk.entries()].sort((a, b) => b[1].paid / b[1].total - a[1].paid / a[1].total)[0];

  return {
    scores,
    carry: `${paid} paid, ${died} died${best ? `; ${best[0]} led at ${best[1].paid}/${best[1].total}` : ""}`,
  };
}

export function scribeSeat(cfg: Config): Agent<ScribeIn, ScribeOut> {
  const model = modelFor("scribe", cfg);
  return new Agent<ScribeIn, ScribeOut>({
    seat: "scribe",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: (text) => parseOut(text, []),
    fallback: fallback as (i: never) => ScribeOut,
    maxTokens: 900,
    temperature: 0.1,
    deadlineMs: 30_000,
  });
}

/** The scribe needs the closed list to validate ids, so the floor binds it here. */
export function scribeFor(cfg: Config, closed: ClosedThesis[]): Agent<ScribeIn, ScribeOut> {
  const model = modelFor("scribe", cfg);
  return new Agent<ScribeIn, ScribeOut>({
    seat: "scribe",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: (text) => parseOut(text, closed),
    fallback: fallback as (i: never) => ScribeOut,
    maxTokens: 900,
    temperature: 0.1,
    deadlineMs: 30_000,
  });
}
