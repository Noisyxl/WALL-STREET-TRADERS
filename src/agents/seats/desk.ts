import type { Desk, Position, TapeSnapshot } from "../../types.js";
import { Agent, extractJson, num, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import type { Config } from "../../config.js";
import { modelFor } from "../roster.js";
import type { TapeOut } from "./tape.js";

/**
 * A desk.
 *
 * Four of these run in parallel on every signal, each with its own prompt and
 * its own reading of the same board. They differ in what they are asked to
 * look at, not in what they are allowed to do: a desk writes a ticket with a
 * name, a side, a notional it would like, a limit, a horizon and one sentence
 * of thesis — and that is the whole of its authority.
 *
 * The sentence matters more than the rest. It is what the overnight scribe
 * grades, and a desk whose theses keep dying is a desk whose tickets get
 * trimmed the next morning. A desk that writes "momentum" and nothing else
 * cannot be graded, so the schema refuses a thesis under twenty characters.
 */

export interface DeskIn {
  desk: Desk;
  snapshot: TapeSnapshot;
  tape: TapeOut;
  positions: Position[];
  equity: number;
  /** What the chief of staff said at the last posture read. */
  posture: string;
  /** Names the day stop or the name cap has already closed off. */
  blocked: string[];
}

export interface DeskTicketDraft {
  symbol: string;
  side: "buy" | "sell";
  notional: number;
  limit?: number;
  thesis: string;
  horizonMin: number;
  conviction: number;
}

export interface DeskOut {
  /** Zero, one or two drafts. A desk that always has an idea is not a desk. */
  drafts: DeskTicketDraft[];
  /** One line for the transcript, whether or not anything was written. */
  read: string;
}

const MIN_THESIS = 20;

function briefOf(input: DeskIn): string {
  const board = Object.values(input.snapshot.quotes)
    .map(
      (q) =>
        `${q.symbol} ${q.last.toFixed(2)} ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}% ` +
        `vol ${q.vol.toFixed(0)}% spread ${(((q.ask - q.bid) / q.last) * 10_000).toFixed(1)}bps`,
    )
    .join("\n");

  const held = input.positions.length
    ? input.positions
        .map((p) => `${p.symbol} ${p.size > 0 ? "long" : "short"} ${Math.abs(p.size)} @ ${p.avgPrice.toFixed(2)}`)
        .join("\n")
    : "(flat)";

  const calls = input.tape.calls.length
    ? input.tape.calls.map((c) => `${c.symbol}: ${c.note}`).join("\n")
    : "(the tape has nothing)";

  return [
    `you are the ${input.desk} desk. minute ${input.snapshot.minute}.`,
    `posture from the chief: ${input.posture}`,
    `equity $${Math.round(input.equity).toLocaleString("en-US")}`,
    "",
    `session: VIX ${input.snapshot.session.vix} · 10Y ${input.snapshot.session.tenY} · DXY ${input.snapshot.session.dxy} · breadth ${input.snapshot.session.breadth}%`,
    "",
    "board:",
    board,
    "",
    "the tape is calling:",
    calls,
    "",
    "the floor is holding:",
    held,
    "",
    input.blocked.length ? `closed off by risk: ${input.blocked.join(", ")}` : "nothing is closed off",
  ].join("\n");
}

function parseOut(text: string, universe: string[]): DeskOut | null {
  const json = extractJson(text) as { drafts?: unknown; read?: unknown } | null;
  if (!json || typeof json !== "object") return null;

  const read = str(json.read, 200) ?? "no read";
  const raw = Array.isArray(json.drafts) ? json.drafts : [];
  const drafts: DeskTicketDraft[] = [];

  for (const d of raw.slice(0, 2)) {
    if (!d || typeof d !== "object") continue;
    const row = d as Record<string, unknown>;

    const symbol = str(row.symbol, 12)?.toUpperCase();
    if (!symbol || !universe.includes(symbol)) continue;

    const sideRaw = str(row.side, 8)?.toLowerCase();
    if (sideRaw !== "buy" && sideRaw !== "sell") continue;

    const notional = num(row.notional, 1, 1e9);
    const thesis = str(row.thesis, 300);
    const horizonMin = num(row.horizonMin ?? row.horizon_min ?? row.horizon, 1, 390);
    const conviction = num(row.conviction, 0, 100);

    if (notional === null || horizonMin === null || conviction === null) continue;
    if (!thesis || thesis.length < MIN_THESIS) continue;

    const limitRaw = row.limit;
    const limit = limitRaw === undefined || limitRaw === null ? undefined : num(limitRaw, 0.01, 1e6);

    drafts.push({
      symbol,
      side: sideRaw,
      notional,
      ...(limit !== undefined && limit !== null ? { limit } : {}),
      thesis,
      horizonMin: Math.round(horizonMin),
      conviction: Math.round(conviction),
    });
  }

  return { drafts, read };
}

/**
 * The offline desk.
 *
 * Each desk gets a different, deliberately simple rule so that an offline run
 * still produces four different opinions instead of four copies of one. These
 * are not strategies and they are not claimed to be — they exist so the wiring
 * can be exercised end to end with no key.
 */
function fallbackFor(input: DeskIn): DeskOut {
  // A desk does not re-write a ticket for something it is already holding the
  // same way. Real desks add to positions deliberately, not every five minutes.
  const heldSameWay = new Set(
    input.positions.filter((p) => p.size !== 0).map((p) => `${p.symbol}:${p.size > 0 ? "buy" : "sell"}`),
  );
  const quotes = Object.values(input.snapshot.quotes).filter(
    (q) => !input.blocked.includes(q.symbol),
  );
  if (quotes.length === 0) return { drafts: [], read: "everything is closed off" };

  const byMove = [...quotes].sort((a, b) => a.changePct - b.changePct);
  const weakest = byMove[0]!;
  const strongest = byMove[byMove.length - 1]!;
  const size = Math.max(500, input.equity * 0.02);

  const draft = (
    q: (typeof quotes)[number],
    side: "buy" | "sell",
    thesis: string,
    horizon: number,
    conviction: number,
  ): DeskOut =>
    heldSameWay.has(`${q.symbol}:${side}`)
      ? { drafts: [], read: `already ${side === "buy" ? "long" : "short"} ${q.symbol}; not adding` }
      : {
          drafts: [
            { symbol: q.symbol, side, notional: +size.toFixed(2), thesis, horizonMin: horizon, conviction },
          ],
          read: thesis,
        };

  switch (input.desk) {
    case "quant":
      // Widest laggard against the board, faded back toward the mean.
      if (strongest.changePct - weakest.changePct < 0.8) {
        return { drafts: [], read: "dispersion under 0.8%, nothing to fade" };
      }
      return draft(
        weakest,
        "buy",
        `${weakest.symbol} is ${(strongest.changePct - weakest.changePct).toFixed(2)}% behind ${strongest.symbol} on the session with no spread widening; fading the dispersion`,
        45,
        58,
      );

    case "macro":
      // Volatility regime read: risk down when VIX is bid, otherwise nothing.
      if (input.snapshot.session.vix < 16) {
        return { drafts: [], read: `VIX ${input.snapshot.session.vix.toFixed(1)}, no regime signal` };
      }
      return draft(
        strongest,
        "sell",
        `VIX at ${input.snapshot.session.vix.toFixed(1)} with breadth ${input.snapshot.session.breadth.toFixed(0)}%; trimming the strongest name into a bid vol tape`,
        60,
        52,
      );

    case "credit":
      // Funding proxy: rates moving with weak breadth.
      if (input.snapshot.session.breadth > 40) {
        return { drafts: [], read: `breadth ${input.snapshot.session.breadth.toFixed(0)}%, no funding stress` };
      }
      return draft(
        weakest,
        "sell",
        `breadth ${input.snapshot.session.breadth.toFixed(0)}% with 10Y at ${input.snapshot.session.tenY.toFixed(2)}; the weakest name leads on a funding tape`,
        90,
        49,
      );

    case "digital":
      // Momentum continuation on the strongest name, if the move is real.
      if (strongest.changePct < 0.6) {
        return { drafts: [], read: "no name has cleared 0.6% on the session" };
      }
      return draft(
        strongest,
        "buy",
        `${strongest.symbol} is up ${strongest.changePct.toFixed(2)}% on the session and holding the offer; staying with the flow`,
        30,
        61,
      );
  }
}

export function deskSeat(desk: Desk, cfg: Config): Agent<DeskIn, DeskOut> {
  const model = modelFor(desk, cfg);
  const universe = [...cfg.universe];
  return new Agent<DeskIn, DeskOut>({
    seat: desk,
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: (text) => parseOut(text, universe),
    fallback: fallbackFor as (i: never) => DeskOut,
    maxTokens: 700,
    temperature: 0.35,
    deadlineMs: 20_000,
  });
}
