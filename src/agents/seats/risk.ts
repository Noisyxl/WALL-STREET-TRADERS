import type { Ticket } from "../../types.js";
import type { Config } from "../../config.js";
import { Agent, extractJson, num, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";
import type { GateContext, RiskReview, Reviewer } from "../../risk/gate.js";

/**
 * The risk seat.
 *
 * It sits on the strongest model on the floor and it has the least authority
 * of any seat, which is the correct way round. By the time it is asked, the
 * hard limits in src/risk/limits.ts have already produced a number. This seat
 * can lower that number or refuse. It cannot raise it, and `applyReview` in
 * gate.ts drops any attempt to, with a line in the receipt saying it tried.
 *
 * What it is actually for: the things a limit cannot see. Four tickets that
 * are each inside every cap but are the same trade in four names. A thesis
 * whose horizon is longer than the session has left. A desk adding to a name
 * it was wrong about an hour ago. Limits are blind to all of that.
 */

export interface RiskIn {
  ticket: Ticket;
  context: GateContext;
  /** Tickets already cleared this session, newest first, for the correlation read. */
  recent: { symbol: string; side: string; desk: string; thesis: string }[];
  minutesLeft: number;
}

function briefOf(input: RiskIn): string {
  const t = input.ticket;
  const c = input.context;
  const money = (n: number): string => "$" + Math.round(n).toLocaleString("en-US");

  const recent = input.recent.length
    ? input.recent
        .slice(0, 8)
        .map((r) => `${r.desk} ${r.side} ${r.symbol} — ${r.thesis}`)
        .join("\n")
    : "(nothing cleared yet this session)";

  return [
    `ticket ${t.id}`,
    `${t.desk} desk wants to ${t.side} ${t.symbol}, asked ${money(t.notional)}, conviction ${t.conviction}/100`,
    `thesis: ${t.thesis}`,
    `horizon: ${t.horizonMin} market minutes · ${input.minutesLeft} minutes left in the session`,
    t.limit ? `limit ${t.limit}` : "no limit given",
    "",
    "the hard limits already ran and allow " + money(c.hardAllowed) + ". their reasons:",
    c.hardReasons.map((r) => "  " + r).join("\n"),
    "",
    "the book right now:",
    `  equity ${money(c.exposure.equity)} · gross ${money(c.exposure.gross)} · net ${money(c.exposure.net)} · ${c.exposure.names} names`,
    `  session P&L ${c.exposure.sessionPnl >= 0 ? "+" : ""}${money(c.exposure.sessionPnl)}`,
    `  1-day 95% VaR ${money(c.var95)}`,
    `  ${c.queueDepth} tickets waiting behind this one`,
    "",
    "positions by name:",
    Object.entries(c.exposure.bySymbol)
      .map(([s, v]) => `  ${s} ${v >= 0 ? "long" : "short"} ${money(Math.abs(v))}`)
      .join("\n") || "  (flat)",
    "",
    "cleared earlier this session:",
    recent,
  ].join("\n");
}

function parseOut(text: string): RiskReview | null {
  const json = extractJson(text) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") return null;

  const verdict = str(json.verdict, 16)?.toLowerCase();
  if (verdict !== "clear" && verdict !== "trim" && verdict !== "refuse") return null;

  const note = str(json.note, 300);
  if (!note) return null;

  const allowedRaw = json.allowed;
  const allowed =
    allowedRaw === undefined || allowedRaw === null ? undefined : num(allowedRaw, 0, 1e9);

  return {
    verdict,
    ...(allowed !== undefined && allowed !== null ? { allowed } : {}),
    note,
    model: "",
  };
}

/**
 * The offline reviewer.
 *
 * Two rules only, both of the kind a limit genuinely cannot express:
 *
 *   - a thesis whose horizon runs past the close is trimmed to half, because
 *     the floor will be flat before it can be right;
 *   - a third ticket in the same direction inside the same session is trimmed,
 *     because three names moving together is one position, not three.
 */
function fallback(input: RiskIn): RiskReview {
  const t = input.ticket;
  const sameWay = input.recent.filter((r) => r.side === t.side).length;

  if (t.horizonMin > input.minutesLeft) {
    return {
      verdict: "trim",
      allowed: input.context.hardAllowed * 0.5,
      note: `horizon ${t.horizonMin} min runs past the close with ${input.minutesLeft} min left; half size`,
      model: "",
    };
  }

  if (sameWay >= 2) {
    return {
      verdict: "trim",
      allowed: input.context.hardAllowed * 0.6,
      note: `${sameWay + 1} tickets the same way this session; correlated, sized down`,
      model: "",
    };
  }

  return {
    verdict: "clear",
    note: `inside every limit, horizon fits the session, ${sameWay} other tickets this way`,
    model: "",
  };
}

export function riskSeat(cfg: Config): Agent<RiskIn, RiskReview> {
  const model = modelFor("risk", cfg);
  return new Agent<RiskIn, RiskReview>({
    seat: "risk",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: parseOut,
    fallback: fallback as (i: never) => RiskReview,
    maxTokens: 400,
    temperature: 0,
    deadlineMs: 25_000,
  });
}

/**
 * Bind the seat into the shape the gate expects. The gate knows nothing about
 * agents, prompts or models — it takes a function that returns a review or null.
 */
export function reviewerFrom(
  agent: Agent<RiskIn, RiskReview>,
  recent: () => RiskIn["recent"],
  minutesLeft: () => number,
): Reviewer {
  return async (ticket: Ticket, context: GateContext): Promise<RiskReview | null> => {
    const result = await agent.run({ ticket, context, recent: recent(), minutesLeft: minutesLeft() });
    return { ...result.out, model: result.completion?.model ?? `${agent.model}:offline` };
  };
}
