import type { TapeSnapshot } from "../../types.js";
import type { Config } from "../../config.js";
import { Agent, extractJson, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";

/**
 * Chief of staff.
 *
 * Runs at the bell and every thirty market minutes after it, and produces one
 * sentence: the posture. Every desk gets that sentence in its brief.
 *
 * It has no other power. It cannot write a ticket, it cannot touch a limit and
 * it cannot overrule the gate. This is the seat most likely to be given more
 * authority by someone extending the floor, and it is the seat that should not
 * get it: a single agent that both sets the tone and can act on it is the one
 * arrangement this whole design exists to avoid.
 */

export interface ChiefIn {
  snapshot: TapeSnapshot;
  equity: number;
  sessionPnl: number;
  openNames: number;
  minutesLeft: number;
  /** The posture from the previous read, so it can say "unchanged". */
  previous: string;
}

export interface ChiefOut {
  posture: string;
}

function briefOf(input: ChiefIn): string {
  const board = Object.values(input.snapshot.quotes)
    .map((q) => `${q.symbol} ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`)
    .join(" · ");

  return [
    `minute ${input.snapshot.minute}, ${input.minutesLeft} left`,
    `equity $${Math.round(input.equity).toLocaleString("en-US")}, session ${input.sessionPnl >= 0 ? "+" : ""}$${Math.round(input.sessionPnl).toLocaleString("en-US")}, ${input.openNames} names open`,
    `VIX ${input.snapshot.session.vix} · 10Y ${input.snapshot.session.tenY} · DXY ${input.snapshot.session.dxy} · breadth ${input.snapshot.session.breadth}%`,
    board,
    "",
    `previous posture: ${input.previous}`,
  ].join("\n");
}

function parseOut(text: string): ChiefOut | null {
  const json = extractJson(text) as Record<string, unknown> | null;
  const posture = json ? str(json.posture, 180) : str(text, 180);
  return posture ? { posture } : null;
}

function fallback(input: ChiefIn): ChiefOut {
  const s = input.snapshot.session;
  const risk = s.vix >= 18 ? "defensive" : s.vix <= 13 && s.breadth >= 60 ? "constructive" : "neutral";
  const late = input.minutesLeft <= 45 ? ", late in the session — new horizons should fit inside it" : "";
  return {
    posture: `${risk}: VIX ${s.vix.toFixed(1)}, breadth ${s.breadth.toFixed(0)}%, ${input.openNames} names open${late}`,
  };
}

export function chiefSeat(cfg: Config): Agent<ChiefIn, ChiefOut> {
  const model = modelFor("chief", cfg);
  return new Agent<ChiefIn, ChiefOut>({
    seat: "chief",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: parseOut,
    fallback: fallback as (i: never) => ChiefOut,
    maxTokens: 200,
    temperature: 0.3,
    deadlineMs: 15_000,
  });
}
