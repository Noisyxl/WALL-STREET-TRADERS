import type { TapeEvent, TapeSnapshot } from "../../types.js";
import { Agent, extractJson, num, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import type { Config } from "../../config.js";
import { modelFor } from "../roster.js";

/**
 * The tape seat.
 *
 * It does not decide anything. `readTape` in src/tape/feed.ts has already
 * produced the events by arithmetic; this seat ranks them and writes the one
 * line each desk will read, because a desk given forty raw events reads none
 * of them.
 *
 * It is the only seat on a fast model, because it runs on every tick and the
 * whole floor waits for it.
 */

export interface TapeIn {
  snapshot: TapeSnapshot;
  events: TapeEvent[];
}

export interface TapeOut {
  /** At most five, most important first. */
  calls: { symbol: string; note: string; weight: number }[];
  /** One line describing the board as a whole. */
  board: string;
}

function briefOf(input: TapeIn): string {
  const q = Object.values(input.snapshot.quotes)
    .map(
      (x) =>
        `${x.symbol} ${x.last.toFixed(2)} ${x.changePct >= 0 ? "+" : ""}${x.changePct.toFixed(2)}% ` +
        `bid ${x.bid.toFixed(2)}x${x.bidSize} ask ${x.ask.toFixed(2)}x${x.askSize} vol ${x.volume.toLocaleString("en-US")}`,
    )
    .join("\n");

  const ev = input.events
    .slice(0, 12)
    .map((e) => `${e.symbol} [${e.kind}] ${e.note} (w ${e.weight.toFixed(2)})`)
    .join("\n");

  return [
    `minute ${input.snapshot.minute}`,
    `VIX ${input.snapshot.session.vix} · 10Y ${input.snapshot.session.tenY} · DXY ${input.snapshot.session.dxy} · breadth ${input.snapshot.session.breadth}%`,
    "",
    "board:",
    q,
    "",
    "measured events this tick:",
    ev || "(none)",
  ].join("\n");
}

function parseOut(text: string): TapeOut | null {
  const json = extractJson(text) as { calls?: unknown; board?: unknown } | null;
  if (!json || typeof json !== "object") return null;

  const board = str(json.board, 200);
  const rawCalls = Array.isArray(json.calls) ? json.calls : [];
  const calls: TapeOut["calls"] = [];

  for (const c of rawCalls.slice(0, 5)) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    const symbol = str(row.symbol, 12);
    const note = str(row.note, 160);
    const weight = num(row.weight, 0, 1);
    if (!symbol || !note || weight === null) continue;
    calls.push({ symbol: symbol.toUpperCase(), note, weight });
  }

  if (!board && calls.length === 0) return null;
  return { calls, board: board ?? "board unchanged" };
}

/** No model, no network: rank by the weight the arithmetic already produced. */
function fallback(input: TapeIn): TapeOut {
  const calls = input.events
    .filter((e) => e.symbol !== "*")
    .slice(0, 5)
    .map((e) => ({ symbol: e.symbol, note: e.note, weight: e.weight }));

  const s = input.snapshot.session;
  return {
    calls,
    board: `breadth ${s.breadth.toFixed(0)}%, VIX ${s.vix.toFixed(1)}, ${calls.length} names moving`,
  };
}

export function tapeSeat(cfg: Config): Agent<TapeIn, TapeOut> {
  const model = modelFor("tape", cfg);
  return new Agent<TapeIn, TapeOut>({
    seat: "tape",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: parseOut,
    fallback: fallback as (i: never) => TapeOut,
    maxTokens: 500,
    temperature: 0.1,
    deadlineMs: 8_000,
  });
}
