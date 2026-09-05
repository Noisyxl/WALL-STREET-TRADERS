import type { Position, Ticket, Verdict } from "../types.js";
import type { RiskLimits } from "../config.js";
import { checkHard, exposureOf, verdictFrom, type Exposure } from "./limits.js";
import { var95 } from "./var.js";

/**
 * The gate.
 *
 * Every ticket written on this floor passes through here, and nothing reaches
 * execution without a verdict. There is no bypass, no "urgent" path and no
 * flag that turns it off — `outcry open --no-gate` does not exist, and the one
 * test in test/gate.test.ts that would catch someone adding it is called
 * `the gate cannot be bypassed`.
 *
 * The order is fixed and it matters:
 *
 *   1. hard limits, in code, deterministic          → an allowed notional
 *   2. a model review of what the limits let through → advisory only
 *   3. the intersection                              → the verdict
 *
 * Step 2 can shrink the number from step 1 or refuse outright. It can never
 * raise it, and if the reviewer times out, errors, or returns something that
 * does not parse, the gate keeps the hard result and says so in the reasons.
 * A floor whose risk control depends on a model answering is not risk control.
 */

export interface RiskReview {
  /** "clear" | "trim" | "refuse" — anything else is treated as "refuse". */
  verdict: string;
  /** Notional the reviewer would allow. Ignored when above the hard allowance. */
  allowed?: number;
  note: string;
  model: string;
}

export type Reviewer = (
  ticket: Ticket,
  context: GateContext,
) => Promise<RiskReview | null>;

export interface GateContext {
  exposure: Exposure;
  limits: RiskLimits;
  hardAllowed: number;
  hardReasons: string[];
  queueDepth: number;
  var95: number;
}

export interface GateOptions {
  limits: RiskLimits;
  equity: number;
  /** Annualised vol per name, for the VaR panel. */
  vols?: Record<string, number>;
  reviewer?: Reviewer;
}

export class Gate {
  private readonly limits: RiskLimits;
  private readonly equity: number;
  private readonly vols: Record<string, number>;
  private readonly reviewer?: Reviewer;

  /** Tickets waiting for a verdict. The floorview reads this. */
  readonly queue: Ticket[] = [];

  private halted = false;
  private haltReason = "";

  constructor(opts: GateOptions) {
    this.limits = opts.limits;
    this.equity = opts.equity;
    this.vols = opts.vols ?? {};
    if (opts.reviewer) this.reviewer = opts.reviewer;
  }

  get isHalted(): boolean {
    return this.halted;
  }

  get haltedBecause(): string {
    return this.haltReason;
  }

  /**
   * A halt is permanent for the session. Only the day stop sets it, and it is
   * set from `decide`, not from outside, so there is one place to read.
   */
  private halt(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
  }

  async decide(
    ticket: Ticket,
    positions: Position[],
    marks: Record<string, number>,
    sessionPnl: number,
  ): Promise<Verdict> {
    const ts = Date.now();

    if (this.halted) {
      return {
        ticketId: ticket.id,
        ts,
        pass: false,
        allowed: 0,
        reasons: [`refused · floor halted: ${this.haltReason}`],
        refusedBy: "halt",
      };
    }

    const exposure = exposureOf(positions, marks, this.equity, sessionPnl);
    const hard = checkHard(ticket, exposure, this.limits, this.queue.length);

    if (hard.refusedBy === "dayStop") {
      this.halt(hard.reasons[hard.reasons.length - 1] ?? "day stop");
    }

    const verdict = verdictFrom(ticket, hard, ts);
    if (!hard.pass || !this.reviewer) return verdict;

    // ── step 2: advisory review ────────────────────────────────────────────
    const risk = var95({ positions, marks, vols: this.vols });
    const context: GateContext = {
      exposure,
      limits: this.limits,
      hardAllowed: hard.allowed,
      hardReasons: hard.reasons,
      queueDepth: this.queue.length,
      var95: risk.var95,
    };

    let review: RiskReview | null = null;
    try {
      review = await this.reviewer(ticket, context);
    } catch (err) {
      verdict.reasons.push(
        `review unavailable · ${(err as Error).message}; hard limits stand`,
      );
      return verdict;
    }

    if (!review) {
      verdict.reasons.push("review skipped · no reviewer answered; hard limits stand");
      return verdict;
    }

    return applyReview(verdict, review);
  }
}

/**
 * The intersection.
 *
 * Exported on its own and tested on its own, because it is the single place
 * where a model's opinion meets a number that protects real money. Read it
 * once and you can stop worrying about what any prompt in this repository says.
 */
export function applyReview(hardVerdict: Verdict, review: RiskReview): Verdict {
  const v: Verdict = {
    ...hardVerdict,
    reasons: [...hardVerdict.reasons],
    review: { seat: "risk", model: review.model, verdict: review.verdict, note: review.note },
  };

  const call = review.verdict.trim().toLowerCase();

  if (call === "refuse") {
    v.pass = false;
    v.allowed = 0;
    v.refusedBy = "review";
    v.reasons.push(`refused · risk seat: ${review.note}`);
    return v;
  }

  if (call === "trim" || call === "clear") {
    const asked = review.allowed;
    if (typeof asked === "number" && Number.isFinite(asked) && asked < v.allowed) {
      v.reasons.push(
        `review trimmed · risk seat allows $${Math.round(asked).toLocaleString("en-US")} of $${Math.round(v.allowed).toLocaleString("en-US")}: ${review.note}`,
      );
      v.allowed = Math.max(0, +asked.toFixed(2));
      if (v.allowed < 1) {
        v.pass = false;
        v.refusedBy = "review";
        v.reasons.push("refused · review trim leaves under one unit");
      }
      return v;
    }
    // A review that asks for more than the hard limits allow is recorded and
    // ignored. This is the invariant; the reason line says so out loud.
    if (typeof asked === "number" && asked > v.allowed) {
      v.reasons.push(
        `review ignored · risk seat asked for $${Math.round(asked).toLocaleString("en-US")}, above the hard allowance; a review can only tighten`,
      );
      return v;
    }
    v.reasons.push(`review cleared · ${review.note}`);
    return v;
  }

  v.pass = false;
  v.allowed = 0;
  v.refusedBy = "review";
  v.reasons.push(`refused · unreadable review verdict "${review.verdict}", treated as a refusal`);
  return v;
}
