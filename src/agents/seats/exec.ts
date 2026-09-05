import type { BookState, Ticket } from "../../types.js";
import type { Config } from "../../config.js";
import { Agent, extractJson, num, str } from "../agent.js";
import { makeProvider } from "../provider.js";
import { modelFor } from "../roster.js";
import { compare } from "../../book/walk.js";
import { spreadBps } from "../../book/book.js";

/**
 * Execution.
 *
 * This seat does not decide whether to trade. It decides how, and it is given
 * exactly three levers: style, how deep to reach, and where to stop. Side,
 * name and size arrive settled and leave settled — `applyPlan` in floor.ts
 * ignores any attempt to change them.
 *
 * It is also the one seat whose value can be measured on every single order,
 * because `compare` in src/book/walk.ts prices the same order both ways. Every
 * `order.done` receipt carries `savedBps`, and if that number is not positive
 * across a session then this seat is costing the floor money and the close
 * summary says so.
 */

export interface ExecIn {
  ticket: Ticket;
  book: BookState;
  size: number;
  defaults: { style: "work" | "sweep"; maxLevels: number; participationPct: number };
}

export interface ExecOut {
  style: "work" | "sweep";
  maxLevels: number;
  participationPct: number;
  /** Worst price accepted. Undefined means the book decides. */
  limit?: number;
  note: string;
}

function briefOf(input: ExecIn): string {
  const side = input.ticket.side;
  const levels = (side === "buy" ? input.book.asks : input.book.bids).slice(0, 6);
  const ladder = levels
    .map((l, i) => `  level ${i}: ${l.price.toFixed(2)} x ${l.size}`)
    .join("\n");
  const c = compare(input.book, side, input.size, input.defaults);

  return [
    `${side} ${input.size} ${input.ticket.symbol}`,
    `spread ${spreadBps(input.book).toFixed(1)} bps`,
    input.ticket.limit ? `the desk asked for a limit of ${input.ticket.limit}` : "the desk gave no limit",
    `horizon ${input.ticket.horizonMin} market minutes`,
    "",
    "the book you are taking from:",
    ladder,
    "",
    "priced both ways right now:",
    `  work  → ${c.work.filledSize} filled, avg ${c.work.avgPrice.toFixed(4)}, ${c.work.slippageBps.toFixed(1)} bps${c.work.unfilledReason ? ` (${c.work.unfilledReason})` : ""}`,
    `  sweep → ${c.sweep.filledSize} filled, avg ${c.sweep.avgPrice.toFixed(4)}, ${c.sweep.slippageBps.toFixed(1)} bps`,
    `  working saves ${c.savedBps.toFixed(1)} bps but may leave ${c.sweep.filledSize - c.work.filledSize} shares unfilled`,
  ].join("\n");
}

function parseOut(text: string): ExecOut | null {
  const json = extractJson(text) as Record<string, unknown> | null;
  if (!json) return null;

  const style = str(json.style, 8)?.toLowerCase();
  if (style !== "work" && style !== "sweep") return null;

  const maxLevels = num(json.maxLevels ?? json.max_levels, 1, 8);
  const participationPct = num(json.participationPct ?? json.participation, 1, 100);
  const note = str(json.note, 200);
  if (maxLevels === null || participationPct === null || !note) return null;

  const limitRaw = json.limit;
  const limit = limitRaw === undefined || limitRaw === null ? undefined : num(limitRaw, 0.01, 1e6);

  return {
    style,
    maxLevels: Math.round(maxLevels),
    participationPct: Math.round(participationPct),
    ...(limit !== undefined && limit !== null ? { limit } : {}),
    note,
  };
}

/**
 * The offline execution rule.
 *
 * Work the order unless the horizon is short and the spread is tight, in which
 * case the cost of not being filled is larger than the cost of paying up.
 * The limit is set two levels out from the touch, so the order stops before
 * the thin part of the book rather than discovering it.
 */
function fallback(input: ExecIn): ExecOut {
  const side = input.ticket.side;
  const levels = side === "buy" ? input.book.asks : input.book.bids;
  const spread = spreadBps(input.book);
  const urgent = input.ticket.horizonMin <= 15 && spread <= 3;

  if (urgent) {
    return {
      style: "sweep",
      maxLevels: input.defaults.maxLevels,
      participationPct: 100,
      note: `${input.ticket.horizonMin}-minute horizon with a ${spread.toFixed(1)} bps spread; being unfilled costs more than paying up`,
    };
  }

  const stop = levels[Math.min(2, levels.length - 1)];
  const limit = input.ticket.limit ?? stop?.price;

  return {
    style: "work",
    maxLevels: input.defaults.maxLevels,
    participationPct: input.defaults.participationPct,
    ...(limit !== undefined ? { limit } : {}),
    note: `working at ${input.defaults.participationPct}% of each level, stopping at ${limit?.toFixed(2) ?? "the book"}`,
  };
}

export function execSeat(cfg: Config): Agent<ExecIn, ExecOut> {
  const model = modelFor("exec", cfg);
  return new Agent<ExecIn, ExecOut>({
    seat: "exec",
    model,
    provider: makeProvider(model, cfg.keys, cfg.bases, () => ""),
    brief: briefOf as (i: never) => string,
    parse: parseOut,
    fallback: fallback as (i: never) => ExecOut,
    maxTokens: 300,
    temperature: 0.1,
    deadlineMs: 12_000,
  });
}
