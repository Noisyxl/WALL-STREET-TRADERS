import type { Seat } from "../types.js";
import type { Config } from "../config.js";

/**
 * Twelve seats.
 *
 * A bank splits this across four departments and a compliance function; the
 * point of the roster is that the split is the design, not the headcount. Each
 * seat sees a different slice of the same state, and no seat can do another
 * seat's job — the quant desk cannot size its own ticket, the risk gate cannot
 * write one, and execution never decides whether a trade is a good idea.
 *
 * Model per seat is bound by role, not by name, so swapping the whole floor
 * onto one model is five lines in `.env` and changes nothing else.
 */

export interface SeatSpec {
  seat: Seat;
  /** Which of the five configured models this chair uses. */
  chair: "tape" | "desk" | "gate" | "floor" | "overnight";
  title: string;
  /** One line, printed by `outcry roster`. */
  does: string;
  /** What this seat is structurally not allowed to do. */
  cannot: string;
  /** When it runs. */
  cadence: "tick" | "signal" | "ticket" | "close" | "overnight";
}

export const ROSTER: readonly SeatSpec[] = [
  {
    seat: "chief",
    chair: "floor",
    title: "chief of staff",
    does: "sets the session posture at the bell and re-reads it every 30 minutes",
    cannot: "write a ticket or overrule the gate",
    cadence: "signal",
  },
  {
    seat: "tape",
    chair: "tape",
    title: "the tape",
    does: "reads every tick, ranks what changed, hands the desks a short list",
    cannot: "have an opinion about direction",
    cadence: "tick",
  },
  {
    seat: "quant",
    chair: "desk",
    title: "quant desk",
    does: "mean reversion and dispersion inside the universe",
    cannot: "size its own ticket",
    cadence: "signal",
  },
  {
    seat: "macro",
    chair: "desk",
    title: "macro desk",
    does: "rates, dollar and volatility against the equity board",
    cannot: "size its own ticket",
    cadence: "signal",
  },
  {
    seat: "credit",
    chair: "desk",
    title: "credit desk",
    does: "balance-sheet and funding stress read through the equity tape",
    cannot: "size its own ticket",
    cadence: "signal",
  },
  {
    seat: "digital",
    chair: "desk",
    title: "digital desk",
    does: "flow, positioning and momentum breaks",
    cannot: "size its own ticket",
    cadence: "signal",
  },
  {
    seat: "risk",
    chair: "gate",
    title: "the gate",
    does: "reviews every ticket the hard limits let through",
    cannot: "raise a limit, ever — see src/risk/gate.ts",
    cadence: "ticket",
  },
  {
    seat: "pm",
    chair: "floor",
    title: "portfolio manager",
    does: "turns a cleared notional into a size against the book and the day",
    cannot: "clear a ticket the gate refused",
    cadence: "ticket",
  },
  {
    seat: "exec",
    chair: "floor",
    title: "execution",
    does: "picks the style and the limit, then works the order level by level",
    cannot: "change the side, the name or the size",
    cadence: "ticket",
  },
  {
    seat: "clerk",
    chair: "floor",
    title: "the clerk",
    does: "reconciles fills against positions after every execution",
    cannot: "use a model at all — it is arithmetic and it stays arithmetic",
    cadence: "ticket",
  },
  {
    seat: "comms",
    chair: "floor",
    title: "comms",
    does: "writes the close: what was done, what it cost, what is still open",
    cannot: "see anything that is not already in the receipts",
    cadence: "close",
  },
  {
    seat: "scribe",
    chair: "overnight",
    title: "the scribe",
    does: "grades yesterday's theses against what the tape actually did",
    cannot: "change a position or write a ticket",
    cadence: "overnight",
  },
] as const;

export const seatSpec = (seat: Seat): SeatSpec => {
  const found = ROSTER.find((s) => s.seat === seat);
  if (!found) throw new Error(`no seat named ${seat}`);
  return found;
};

export const modelFor = (seat: Seat, cfg: Config): string =>
  cfg.models[seatSpec(seat).chair];

/** Seats that may originate a ticket. Enforced in floor.ts, not by convention. */
export const canWriteTickets = (seat: Seat): boolean =>
  seat === "quant" || seat === "macro" || seat === "credit" || seat === "digital";
