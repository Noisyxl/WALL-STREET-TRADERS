import type { BookState, Ticket, Verdict } from "../../types.js";
import type { Config } from "../../config.js";
import { Agent, extractJson, num, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";
import { sizeForNotional } from "../../book/walk.js";
import { spreadBps, depth } from "../../book/book.js";

/**
 * The portfolio manager.
 *
 * The gate says how much money may be spent. The PM says how many shares that
 * actually is, and whether it should be fewer. Those are different questions:
 * a cleared $2 000 in a name showing 300 shares at the touch is not a $2 000
 * trade, it is a $2 000 request that will print in four levels and be the
 * entire tape for a minute.
 *
 * The PM may only reduce. `size` is clamped to what the gate allowed before it
 * is returned, in code, in this file — the same invariant as the gate itself.
 */

export interface PmIn {
  ticket: Ticket;
  verdict: Verdict;
  book: BookState;
  last: number;
  /** Names already held, so the PM can see concentration the gate priced but did not judge. */
  held: { symbol: string; size: number; unrealisedPct: number }[];
  minutesLeft: number;
}

export interface PmOut {
  /** Shares. Never more than the gate's allowance buys. */
  size: number;
  /** One line saying why this size and not the full allowance. */
  note: string;
}

function maxSize(input: PmIn): number {
  return Math.max(0, sizeForNotional(input.book, input.ticket.side, input.verdict.allowed));
}

function briefOf(input: PmIn): string {
  const ceiling = maxSize(input);
  const touch = input.ticket.side === "buy" ? input.book.asks[0] : input.book.bids[0];
  return [
    `ticket ${input.ticket.id}: ${input.ticket.side} ${input.ticket.symbol}`,
    `the gate cleared $${Math.round(input.verdict.allowed).toLocaleString("en-US")}, which buys ${ceiling} shares at ${input.last.toFixed(2)}`,
    `thesis: ${input.ticket.thesis}`,
    `horizon ${input.ticket.horizonMin} min · ${input.minutesLeft} min left`,
    "",
    `book: ${touch?.size ?? 0} shares at ${touch?.price.toFixed(2) ?? "—"}, spread ${spreadBps(input.book).toFixed(1)} bps, ${depth(input.book, input.ticket.side, 5)} shares in five levels`,
    `this order is ${((ceiling / Math.max(1, depth(input.book, input.ticket.side, 5))) * 100).toFixed(0)}% of the displayed depth`,
    "",
    "held:",
    input.held.length
      ? input.held.map((h) => `  ${h.symbol} ${h.size > 0 ? "+" : ""}${h.size} ${h.unrealisedPct >= 0 ? "+" : ""}${h.unrealisedPct.toFixed(1)}%`).join("\n")
      : "  (flat)",
    "",
    `answer with a size between 0 and ${ceiling}.`,
  ].join("\n");
}

function parseOut(text: string, ceiling: number): PmOut | null {
  const json = extractJson(text) as Record<string, unknown> | null;
  if (!json) return null;
  const size = num(json.size, 0, ceiling);
  const note = str(json.note, 200);
  if (size === null || !note) return null;
  return { size: Math.floor(size), note };
}

/**
 * The offline PM: never take more than a fifth of the depth showing in five
 * levels. It is a blunt rule and it is stated as one.
 */
function fallback(input: PmIn): PmOut {
  const ceiling = maxSize(input);
  if (ceiling <= 0) {
    return {
      size: 0,
      note: `the gate's $${Math.round(input.verdict.allowed).toLocaleString("en-US")} does not buy one share at ${input.last.toFixed(2)}`,
    };
  }
  const available = depth(input.book, input.ticket.side, 5);
  const cap = Math.floor(available * 0.2);
  if (cap < ceiling) {
    return {
      size: Math.max(0, cap),
      note: `${cap} of ${ceiling} shares: a fifth of the ${available} showing in five levels`,
    };
  }
  return { size: ceiling, note: `${ceiling} shares, the full allowance; depth carries it` };
}

export function pmSeat(cfg: Config): Agent<PmIn, PmOut> {
  const model = modelFor("pm", cfg);
  return new Agent<PmIn, PmOut>({
    seat: "pm",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: (text) => parseOut(text, Number.MAX_SAFE_INTEGER),
    fallback: fallback as (i: never) => PmOut,
    maxTokens: 300,
    temperature: 0.1,
    deadlineMs: 15_000,
  });
}

/**
 * The clamp.
 *
 * Called by the floor on whatever the PM returns, model or not. A PM that asks
 * for more than the gate allowed gets the gate's number and a line in the
 * receipt. Same invariant, same shape, one line to read.
 */
export function clampToAllowance(out: PmOut, input: PmIn): PmOut {
  const ceiling = maxSize(input);
  if (out.size <= ceiling) return out;
  return {
    size: ceiling,
    note: `${out.note} — clamped to ${ceiling}, the gate's allowance; the PM asked for ${out.size}`,
  };
}
