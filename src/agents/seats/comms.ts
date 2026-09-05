import type { Config } from "../../config.js";
import { Agent, extractJson, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";

/**
 * Comms.
 *
 * Writes the close. The constraint that makes this seat trustworthy is that
 * it is handed nothing except numbers already written to receipts — it cannot
 * see the tape, the models, or any seat's reasoning. If a sentence in the
 * close summary cannot be traced to a receipt, comms invented it, and the
 * `--verify` flag on `outcry close` re-derives every figure from the file and
 * refuses to print a summary whose numbers do not match.
 */

export interface CommsIn {
  sessionId: string;
  minutes: number;
  equityStart: number;
  equityEnd: number;
  realised: number;
  unrealised: number;
  fees: number;
  ticketsWritten: number;
  ticketsCleared: number;
  ticketsRefused: number;
  refusedBy: Record<string, number>;
  fills: number;
  avgSlippageBps: number;
  savedBps: number;
  openNames: { symbol: string; size: number; unrealisedPct: number }[];
  haltedBecause: string;
  receiptHead: string;
}

export interface CommsOut {
  /** Three to six lines, plain text, no markdown. */
  summary: string;
}

function briefOf(i: CommsIn): string {
  const money = (n: number): string => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
  return [
    `session ${i.sessionId}, ${i.minutes} market minutes`,
    `equity ${money(i.equityStart)} → ${money(i.equityEnd)}`,
    `realised ${money(i.realised)} · unrealised ${money(i.unrealised)} · fees ${money(i.fees)}`,
    `tickets: ${i.ticketsWritten} written, ${i.ticketsCleared} cleared, ${i.ticketsRefused} refused`,
    `refusals by rule: ${Object.entries(i.refusedBy).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `${i.fills} fills, average slippage ${i.avgSlippageBps.toFixed(1)} bps, working saved ${i.savedBps.toFixed(1)} bps against sweeping`,
    i.haltedBecause ? `the floor halted: ${i.haltedBecause}` : "the floor ran to the close",
    "",
    "still open:",
    i.openNames.length
      ? i.openNames.map((n) => `  ${n.symbol} ${n.size > 0 ? "+" : ""}${n.size} ${n.unrealisedPct >= 0 ? "+" : ""}${n.unrealisedPct.toFixed(1)}%`).join("\n")
      : "  (flat)",
    "",
    `receipt chain head ${i.receiptHead.slice(0, 16)}`,
  ].join("\n");
}

function parseOut(text: string): CommsOut | null {
  const json = extractJson(text) as Record<string, unknown> | null;
  const summary = json ? str(json.summary, 1200) : str(text, 1200);
  return summary ? { summary } : null;
}

function fallback(i: CommsIn): CommsOut {
  const money = (n: number): string => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
  const pnl = i.equityEnd - i.equityStart;
  const lines = [
    `${i.minutes} minutes. Equity ${money(i.equityStart)} to ${money(i.equityEnd)}, ${pnl >= 0 ? "+" : ""}${money(pnl)}.`,
    `${i.ticketsWritten} tickets written, ${i.ticketsCleared} cleared, ${i.ticketsRefused} refused${
      Object.keys(i.refusedBy).length ? ` (${Object.entries(i.refusedBy).map(([k, v]) => `${v} on ${k}`).join(", ")})` : ""
    }.`,
    `${i.fills} fills at ${i.avgSlippageBps.toFixed(1)} bps average slippage; working the book saved ${i.savedBps.toFixed(1)} bps against sweeping it.`,
    i.openNames.length
      ? `Still open: ${i.openNames.map((n) => `${n.symbol} ${n.size > 0 ? "+" : ""}${n.size}`).join(", ")}.`
      : "Flat into the close.",
  ];
  if (i.haltedBecause) lines.push(`The floor halted before the bell: ${i.haltedBecause}.`);
  lines.push(`Receipt chain head ${i.receiptHead.slice(0, 16)}.`);
  return { summary: lines.join("\n") };
}

export function commsSeat(cfg: Config): Agent<CommsIn, CommsOut> {
  const model = modelFor("comms", cfg);
  return new Agent<CommsIn, CommsOut>({
    seat: "comms",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: parseOut,
    fallback: fallback as (i: never) => CommsOut,
    maxTokens: 500,
    temperature: 0.2,
    deadlineMs: 20_000,
  });
}
