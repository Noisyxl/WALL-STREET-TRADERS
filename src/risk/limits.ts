import type { Position, Ticket, Verdict } from "../types.js";
import type { RiskLimits } from "../config.js";

/**
 * The hard limits.
 *
 * These run in code, before any model is asked for an opinion, and they are the
 * only thing standing between a confident desk and the whole book. Every rule
 * here answers with a number, not a judgement, and every rule that fires ends
 * up in the verdict's `reasons`, in the order it was checked.
 *
 * The one invariant this file exists to protect:
 *
 *     a model can make the gate stricter. It can never make it looser.
 *
 * `applyReview` in gate.ts enforces that by taking the minimum of the allowed
 * notional and refusing whenever either side refuses. If you change nothing
 * else in this repository, do not change that.
 */

export interface Exposure {
  equity: number;
  /** Marked value of every open position, absolute, summed. */
  gross: number;
  /** Marked value, signed, summed. */
  net: number;
  /** Open names. */
  names: number;
  /** Session profit and loss so far, in quote currency. */
  sessionPnl: number;
  /** Signed marked value per symbol. */
  bySymbol: Record<string, number>;
}

export function exposureOf(
  positions: Position[],
  marks: Record<string, number>,
  equity: number,
  sessionPnl: number,
): Exposure {
  const bySymbol: Record<string, number> = {};
  let gross = 0;
  let net = 0;
  for (const p of positions) {
    if (p.size === 0) continue;
    const price = marks[p.symbol] ?? p.avgPrice;
    const value = p.size * price;
    bySymbol[p.symbol] = (bySymbol[p.symbol] ?? 0) + value;
    gross += Math.abs(value);
    net += value;
  }
  return {
    equity,
    gross,
    net,
    names: Object.values(bySymbol).filter((v) => Math.abs(v) > 0.005).length,
    sessionPnl,
    bySymbol,
  };
}

export interface HardResult {
  pass: boolean;
  /** Notional the hard limits allow. Never above what the ticket asked for. */
  allowed: number;
  reasons: string[];
  refusedBy?: string;
}

/**
 * Check one ticket against every hard limit.
 *
 * A limit either refuses outright (`refusedBy`) or trims the notional. Trimming
 * is preferred: a ticket that asks for 6 % of equity when the per-ticket cap is
 * 4 % comes back cleared for 4 %, with the trim named in `reasons`. A desk
 * whose tickets are always trimmed is a desk asking for too much, and the
 * end-of-session summary says so.
 */
export function checkHard(
  ticket: Ticket,
  exp: Exposure,
  limits: RiskLimits,
  queueDepth: number,
): HardResult {
  const reasons: string[] = [];
  const eq = exp.equity;
  const refuse = (rule: string, why: string): HardResult => {
    reasons.push(`refused · ${why}`);
    return { pass: false, allowed: 0, reasons, refusedBy: rule };
  };

  if (eq <= 0) return refuse("equity", "no equity left to trade");

  // 1. the day stop. Checked first: once it fires nothing else matters.
  const dayLossPct = (-exp.sessionPnl / eq) * 100;
  if (dayLossPct >= limits.dayStopPct) {
    return refuse(
      "dayStop",
      `session down ${dayLossPct.toFixed(2)}%, at or past the ${limits.dayStopPct}% day stop`,
    );
  }
  reasons.push(`day stop ok · session ${exp.sessionPnl >= 0 ? "+" : ""}${((exp.sessionPnl / eq) * 100).toFixed(2)}% of ${limits.dayStopPct}%`);

  // 2. the queue. A gate with a backlog is a gate that is not being read.
  if (queueDepth > limits.queueDepth) {
    return refuse("queue", `${queueDepth} tickets already waiting, cap ${limits.queueDepth}`);
  }

  // 3. per-ticket cap. Trims rather than refuses.
  const ticketCap = (eq * limits.maxTicketPct) / 100;
  let allowed = Math.min(ticket.notional, ticketCap);
  if (allowed < ticket.notional) {
    reasons.push(
      `ticket trimmed · asked ${fmt(ticket.notional)}, cap ${limits.maxTicketPct}% of equity is ${fmt(ticketCap)}`,
    );
  } else {
    reasons.push(`ticket size ok · ${fmt(ticket.notional)} under the ${limits.maxTicketPct}% cap`);
  }

  // 4. per-name cap. Only the part that increases exposure counts against it.
  const current = exp.bySymbol[ticket.symbol] ?? 0;
  const nameCap = (eq * limits.maxPositionPct) / 100;
  const signed = ticket.side === "buy" ? 1 : -1;
  const wouldBe = current + signed * allowed;
  const reducing = Math.abs(wouldBe) < Math.abs(current);

  if (!reducing && Math.abs(wouldBe) > nameCap) {
    const room = Math.max(0, nameCap - Math.abs(current));
    if (room <= 0) {
      return refuse(
        "position",
        `${ticket.symbol} already at ${fmt(Math.abs(current))}, name cap ${limits.maxPositionPct}% is ${fmt(nameCap)}`,
      );
    }
    allowed = Math.min(allowed, room);
    reasons.push(
      `name trimmed · ${ticket.symbol} has ${fmt(Math.abs(current))} of a ${fmt(nameCap)} cap, ${fmt(room)} of room`,
    );
  } else {
    reasons.push(
      reducing
        ? `reduces ${ticket.symbol} from ${fmt(Math.abs(current))}, name cap not applied`
        : `name ok · ${ticket.symbol} would be ${fmt(Math.abs(wouldBe))} of ${fmt(nameCap)}`,
    );
  }

  // 5. name count. A new name when the book is full is refused, not trimmed.
  const isNewName = Math.abs(current) < 0.005;
  if (isNewName && exp.names >= limits.maxNames) {
    return refuse(
      "names",
      `${exp.names} names open, cap ${limits.maxNames}; ${ticket.symbol} would be new`,
    );
  }

  // 6. gross and net. Both trim.
  if (!reducing) {
    const grossCap = (eq * limits.maxGrossPct) / 100;
    const grossRoom = Math.max(0, grossCap - exp.gross);
    if (allowed > grossRoom) {
      if (grossRoom <= 0) {
        return refuse("gross", `gross ${fmt(exp.gross)} at the ${limits.maxGrossPct}% cap`);
      }
      allowed = grossRoom;
      reasons.push(`gross trimmed · ${fmt(exp.gross)} of ${fmt(grossCap)}, ${fmt(grossRoom)} of room`);
    } else {
      reasons.push(`gross ok · ${fmt(exp.gross + allowed)} of ${fmt(grossCap)}`);
    }

    const netCap = (eq * limits.maxNetPct) / 100;
    const netAfter = exp.net + signed * allowed;
    if (Math.abs(netAfter) > netCap) {
      const netRoom = Math.max(0, netCap - Math.abs(exp.net));
      if (netRoom <= 0) {
        return refuse(
          "net",
          `net ${fmt(exp.net)} at the ${limits.maxNetPct}% cap, ticket adds the same way`,
        );
      }
      allowed = Math.min(allowed, netRoom);
      reasons.push(`net trimmed · ${fmt(exp.net)} of ${fmt(netCap)}, ${fmt(netRoom)} of room`);
    } else {
      reasons.push(`net ok · ${fmt(netAfter)} of ${fmt(netCap)}`);
    }
  }

  if (allowed < 1) {
    return refuse("dust", `every cap applied leaves ${fmt(allowed)}, under one unit`);
  }

  return { pass: true, allowed: +allowed.toFixed(2), reasons };
}

const fmt = (n: number): string =>
  "$" + Math.round(n).toLocaleString("en-US");

/** Build the verdict shape from a hard result. gate.ts adds any model review. */
export function verdictFrom(ticket: Ticket, hard: HardResult, ts: number): Verdict {
  return {
    ticketId: ticket.id,
    ts,
    pass: hard.pass,
    allowed: hard.allowed,
    reasons: hard.reasons,
    ...(hard.refusedBy ? { refusedBy: hard.refusedBy } : {}),
  };
}
