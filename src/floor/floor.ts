import { EventEmitter } from "node:events";
import type {
  Desk,
  Execution,
  TapeSnapshot,
  ThesisScore,
  Ticket,
  Verdict,
} from "../types.js";
import { DESKS } from "../types.js";
import type { Config } from "../config.js";
import type { Feed } from "../tape/feed.js";
import { readTape } from "../tape/feed.js";
import { walk, compare, ladderOf } from "../book/walk.js";
import { Gate } from "../risk/gate.js";
import { var95 } from "../risk/var.js";
import { Ledger } from "../ledger/positions.js";
import { ReceiptBook } from "../ledger/receipts.js";
import { reconcile, reconcileCash } from "../agents/seats/clerk.js";
import { tapeSeat, type TapeOut } from "../agents/seats/tape.js";
import { deskSeat, type DeskOut } from "../agents/seats/desk.js";
import { riskSeat, reviewerFrom, type RiskIn } from "../agents/seats/risk.js";
import { pmSeat, clampToAllowance } from "../agents/seats/pm.js";
import { execSeat } from "../agents/seats/exec.js";
import { chiefSeat } from "../agents/seats/chief.js";
import { commsSeat } from "../agents/seats/comms.js";
import { scribeFor, type ClosedThesis } from "../agents/seats/scribe.js";
import { ticketId, sessionId as makeSessionId } from "../util/id.js";
import { say, warn, chatter } from "../util/log.js";
import { brass, money, pct, bps, badge, alarm } from "../util/fmt.js";

/**
 * The floor.
 *
 * One loop, one direction, no shortcuts:
 *
 *   tape → desks (four, in parallel) → ticket → gate → PM → execution → ledger → clerk
 *
 * Everything that can be enforced in code is enforced here rather than in a
 * prompt. A prompt is a request; this file is the rule. In particular:
 *
 *   - only the four desks may originate a ticket (`canWrite`)
 *   - every ticket goes through `gate.decide`, with no branch that skips it
 *   - the PM's size is clamped to the gate's allowance
 *   - execution may not change the side, the name or the size
 *   - the clerk reconciles after every fill and a break halts the floor
 *
 * Each of those has a test whose name is the sentence above it.
 */

export interface FloorOptions {
  cfg: Config;
  feed: Feed;
  /** Emit a signal to the desks every N market minutes. */
  signalEvery?: number;
  /** Re-read the posture every N market minutes. */
  postureEvery?: number;
  /** Fee charged on every fill, in basis points of notional. */
  feeBps?: number;
}

export interface FloorState {
  sessionId: string;
  minute: number;
  posture: string;
  equity: number;
  sessionPnl: number;
  snapshot: TapeSnapshot;
  tape: TapeOut;
  tickets: Ticket[];
  verdicts: Record<string, Verdict>;
  executions: Execution[];
  marks: ReturnType<Ledger["marks"]>;
  queue: Ticket[];
  halted: string;
  var95: number;
}

export class Floor extends EventEmitter {
  readonly sessionId: string;
  readonly cfg: Config;
  readonly receipts: ReceiptBook;
  readonly ledger: Ledger;
  readonly gate: Gate;

  private readonly feed: Feed;
  private readonly signalEvery: number;
  private readonly postureEvery: number;
  private readonly feeBps: number;

  private readonly seats: {
    tape: ReturnType<typeof tapeSeat>;
    desks: Record<Desk, ReturnType<typeof deskSeat>>;
    risk: ReturnType<typeof riskSeat>;
    pm: ReturnType<typeof pmSeat>;
    exec: ReturnType<typeof execSeat>;
    chief: ReturnType<typeof chiefSeat>;
    comms: ReturnType<typeof commsSeat>;
  };

  private posture = "opening: no read yet";
  private ticketSeq = 0;
  private prevSnapshot: TapeSnapshot | null = null;
  private lastTape: TapeOut = { calls: [], board: "" };
  private readonly tickets: Ticket[] = [];
  private readonly verdicts = new Map<string, Verdict>();
  private readonly opened = new Map<string, { ticket: Ticket; price: number; minute: number }>();
  private readonly savedBpsRunning: number[] = [];
  private stopped = false;

  constructor(opts: FloorOptions) {
    super();
    this.cfg = opts.cfg;
    this.feed = opts.feed;
    this.signalEvery = opts.signalEvery ?? 5;
    this.postureEvery = opts.postureEvery ?? 30;
    this.feeBps = opts.feeBps ?? 1;

    this.sessionId = makeSessionId();
    this.receipts = new ReceiptBook(opts.cfg.dataDir, this.sessionId);
    this.ledger = new Ledger(opts.cfg.equity);

    const risk = riskSeat(opts.cfg);
    this.seats = {
      tape: tapeSeat(opts.cfg),
      desks: {
        quant: deskSeat("quant", opts.cfg),
        macro: deskSeat("macro", opts.cfg),
        credit: deskSeat("credit", opts.cfg),
        digital: deskSeat("digital", opts.cfg),
      },
      risk,
      pm: pmSeat(opts.cfg),
      exec: execSeat(opts.cfg),
      chief: chiefSeat(opts.cfg),
      comms: commsSeat(opts.cfg),
    };

    const vols: Record<string, number> = {};
    for (const [s, q] of Object.entries(this.feed.peek().quotes)) vols[s] = q.vol;

    this.gate = new Gate({
      limits: opts.cfg.risk,
      equity: opts.cfg.equity,
      vols,
      reviewer: reviewerFrom(
        risk,
        () => this.recentCleared(),
        () => this.minutesLeft(),
      ),
    });
  }

  // ── public surface ─────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
  }

  get minute(): number {
    return this.feed.minute;
  }

  minutesLeft(): number {
    return Math.max(0, this.cfg.sessionMin - this.feed.minute);
  }

  state(): FloorState {
    const snapshot = this.feed.peek();
    const prices = this.prices(snapshot);
    return {
      sessionId: this.sessionId,
      minute: snapshot.minute,
      posture: this.posture,
      equity: this.ledger.equity(prices),
      sessionPnl: this.ledger.sessionPnl(prices),
      snapshot,
      tape: this.lastTape,
      tickets: [...this.tickets].reverse().slice(0, 50),
      verdicts: Object.fromEntries(this.verdicts),
      executions: [...this.ledger.executions].reverse().slice(0, 50),
      marks: this.ledger.marks(prices),
      queue: [...this.gate.queue],
      halted: this.gate.isHalted ? this.gate.haltedBecause : "",
      var95: var95({
        positions: this.ledger.list(),
        marks: prices,
        vols: Object.fromEntries(Object.entries(snapshot.quotes).map(([s, q]) => [s, q.vol])),
      }).var95,
    };
  }

  /** Run a whole session. Resolves at the close, or when `stop()` is called. */
  async run(): Promise<FloorState> {
    const open = this.feed.peek();
    this.receipts.write("session.open", "floor", {
      sessionId: this.sessionId,
      mode: this.cfg.mode,
      feed: this.feed.name,
      universe: [...this.feed.universe],
      equity: this.cfg.equity,
      limits: this.cfg.risk,
      exec: this.cfg.exec,
      models: this.cfg.models,
      seed: this.cfg.tape.seed,
      ts: open.ts,
    });

    say("floor", `${badge("OPEN")} ${this.sessionId} · ${this.feed.name} feed · ${this.feed.universe.join(" ")} · ${money(this.cfg.equity)}`);
    await this.readPosture(open);

    while (!this.stopped && !this.feed.done) {
      const snapshot = this.feed.tick();
      if (!snapshot) break;

      const events = readTape(this.prevSnapshot, snapshot);
      this.prevSnapshot = snapshot;

      if (snapshot.minute % this.postureEvery === 0) await this.readPosture(snapshot);
      if (snapshot.minute % this.signalEvery !== 0) continue;

      await this.signal(snapshot, events);
      this.emit("tick", this.state());
    }

    return this.close();
  }

  // ── the loop ───────────────────────────────────────────────────────────────

  private prices(snapshot: TapeSnapshot): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [s, q] of Object.entries(snapshot.quotes)) out[s] = q.last;
    return out;
  }

  private async readPosture(snapshot: TapeSnapshot): Promise<void> {
    const prices = this.prices(snapshot);
    const res = await this.seats.chief.run({
      snapshot,
      equity: this.ledger.equity(prices),
      sessionPnl: this.ledger.sessionPnl(prices),
      openNames: this.ledger.openNames,
      minutesLeft: this.minutesLeft(),
      previous: this.posture,
    });
    this.posture = res.out.posture;
    say("chief", this.posture);
  }

  private async signal(snapshot: TapeSnapshot, events: ReturnType<typeof readTape>): Promise<void> {
    const prices = this.prices(snapshot);

    // 1. the tape reads.
    const tapeRes = await this.seats.tape.run({ snapshot, events });
    this.lastTape = tapeRes.out;
    this.receipts.write("tape.read", "tape", {
      minute: snapshot.minute,
      calls: tapeRes.out.calls,
      board: tapeRes.out.board,
      model: tapeRes.completion?.model ?? "offline",
      ms: tapeRes.ms,
      ...(tapeRes.degraded ? { degraded: tapeRes.degraded } : {}),
    });
    chatter("tape", tapeRes.out.board);

    // 2. four desks, in parallel. This is the whole point of the arrangement:
    //    they do not see each other's drafts and cannot coordinate.
    const blocked = this.gate.isHalted ? [...this.feed.universe] : [];
    const deskInputs = {
      snapshot,
      tape: tapeRes.out,
      positions: this.ledger.list(),
      equity: this.ledger.equity(prices),
      posture: this.posture,
      blocked,
    };

    const results = await Promise.all(
      DESKS.map(async (desk) => {
        const res = await this.seats.desks[desk].run({ ...deskInputs, desk });
        return { desk, res };
      }),
    );

    // 3. drafts become tickets, in a fixed desk order so a session replays.
    for (const { desk, res } of results) {
      const out: DeskOut = res.out;
      if (out.drafts.length === 0) {
        chatter(desk, out.read);
        continue;
      }
      for (const draft of out.drafts) {
        const ticket: Ticket = {
          id: ticketId(desk, ++this.ticketSeq, draft.symbol),
          ts: snapshot.ts,
          desk,
          symbol: draft.symbol,
          side: draft.side,
          notional: draft.notional,
          ...(draft.limit !== undefined ? { limit: draft.limit } : {}),
          thesis: draft.thesis,
          horizonMin: draft.horizonMin,
          conviction: draft.conviction,
          state: "written",
        };
        this.tickets.push(ticket);
        this.receipts.write("ticket.written", desk, {
          ticket,
          model: res.completion?.model ?? "offline",
          ms: res.ms,
          ...(res.degraded ? { degraded: res.degraded } : {}),
        });
        say(
          desk,
          `${ticket.id} ${ticket.side} ${ticket.symbol} ${money(ticket.notional)} · ${ticket.thesis}`,
        );
        await this.throughGate(ticket, snapshot);
      }
    }
  }

  /**
   * The only path from a ticket to a fill. There is no other caller of
   * `gate.decide` and no other caller of `ledger.apply` in this repository;
   * `test/floor.test.ts` asserts both by reading the source.
   */
  private async throughGate(ticket: Ticket, snapshot: TapeSnapshot): Promise<void> {
    const prices = this.prices(snapshot);

    ticket.state = "queued";
    this.gate.queue.push(ticket);

    let verdict: Verdict;
    try {
      verdict = await this.gate.decide(
        ticket,
        this.ledger.list(),
        prices,
        this.ledger.sessionPnl(prices),
      );
    } finally {
      const i = this.gate.queue.indexOf(ticket);
      if (i >= 0) this.gate.queue.splice(i, 1);
    }

    this.verdicts.set(ticket.id, verdict);
    this.receipts.write("gate.verdict", "risk", { verdict });

    if (!verdict.pass) {
      ticket.state = "refused";
      say("risk", `${alarm("REFUSED")} ${ticket.id} · ${verdict.refusedBy} · ${verdict.reasons[verdict.reasons.length - 1]}`);
      if (this.gate.isHalted) {
        this.receipts.write("risk.halt", "risk", { reason: this.gate.haltedBecause, minute: snapshot.minute });
        warn("floor", `${alarm("HALT")} ${this.gate.haltedBecause}`);
      }
      return;
    }

    ticket.state = "cleared";
    say("risk", `${badge("CLEARED")} ${ticket.id} ${money(verdict.allowed)}${verdict.review ? ` · ${verdict.review.note}` : ""}`);

    await this.size(ticket, verdict, snapshot);
  }

  private async size(ticket: Ticket, verdict: Verdict, snapshot: TapeSnapshot): Promise<void> {
    const book = this.feed.book(ticket.symbol);
    const last = snapshot.quotes[ticket.symbol]?.last ?? book.bids[0]?.price ?? 0;
    const prices = this.prices(snapshot);

    const pmIn = {
      ticket,
      verdict,
      book,
      last,
      held: this.ledger.marks(prices).map((m) => ({
        symbol: m.symbol,
        size: m.size,
        unrealisedPct: m.unrealisedPct,
      })),
      minutesLeft: this.minutesLeft(),
    };

    const pmRes = await this.seats.pm.run(pmIn);
    const sized = clampToAllowance(pmRes.out, pmIn);

    if (sized.size <= 0) {
      ticket.state = "cancelled";
      say("pm", `${ticket.id} sized to zero · ${sized.note}`);
      this.receipts.write("order.done", "pm", {
        ticketId: ticket.id,
        cancelled: true,
        note: sized.note,
      });
      return;
    }

    say("pm", `${ticket.id} ${sized.size} shares · ${sized.note}`);
    await this.work(ticket, sized.size, book, snapshot);
  }

  private async work(
    ticket: Ticket,
    size: number,
    book: ReturnType<Feed["book"]>,
    snapshot: TapeSnapshot,
  ): Promise<void> {
    const execRes = await this.seats.exec.run({
      ticket,
      book,
      size,
      defaults: {
        style: this.cfg.exec.style,
        maxLevels: this.cfg.exec.maxLevels,
        participationPct: this.cfg.exec.participationPct,
      },
    });
    const plan = execRes.out;

    ticket.state = "working";
    this.receipts.write("order.working", "exec", {
      ticketId: ticket.id,
      symbol: ticket.symbol,
      side: ticket.side,
      size,
      plan,
      model: execRes.completion?.model ?? "offline",
    });

    // Execution may choose style, depth and limit. It may not choose side,
    // name or size — those are passed through from the ticket and the PM.
    const execution = walk(book, ticket.side, size, ticket.id, {
      style: plan.style,
      maxLevels: plan.maxLevels,
      participationPct: plan.participationPct,
      minChild: this.cfg.exec.minChild,
      replenishPct: this.cfg.exec.replenishPct,
      ...(plan.limit !== undefined ? { limit: plan.limit } : {}),
    });

    const both = compare(book, ticket.side, size, {
      maxLevels: this.cfg.exec.maxLevels,
      participationPct: this.cfg.exec.participationPct,
      minChild: this.cfg.exec.minChild,
      replenishPct: this.cfg.exec.replenishPct,
    });
    this.savedBpsRunning.push(both.savedBps);

    for (const fill of execution.fills) {
      this.receipts.write("order.fill", "exec", {
        ticketId: ticket.id,
        symbol: ticket.symbol,
        side: ticket.side,
        price: fill.price,
        size: fill.size,
        level: fill.level,
      });
    }

    if (execution.filledSize <= 0) {
      ticket.state = "cancelled";
      say("exec", `${ticket.id} unfilled · ${execution.unfilledReason ?? "no fills"}`);
      this.receipts.write("order.done", "exec", { execution, note: plan.note });
      return;
    }

    const realised = this.ledger.apply(execution, { feeBps: this.feeBps });
    ticket.state = execution.filledSize < execution.requestedSize ? "partial" : "filled";

    this.receipts.write("order.done", "exec", {
      execution,
      note: plan.note,
      savedBps: both.savedBps,
      realised,
    });

    const ladder = ladderOf(execution);
    say(
      "exec",
      `${ticket.id} ${execution.filledSize}/${execution.requestedSize} @ ${execution.avgPrice.toFixed(4)} · ${ladder} · ${bps(execution.slippageBps)} · working saved ${both.savedBps.toFixed(1)} bps`,
    );

    if (!this.opened.has(ticket.id)) {
      this.opened.set(ticket.id, { ticket, price: execution.avgPrice, minute: snapshot.minute });
    }

    const prices = this.prices(snapshot);
    this.receipts.write("position.change", "clerk", {
      ticketId: ticket.id,
      positions: this.ledger.list(),
      realised,
      sessionPnl: this.ledger.sessionPnl(prices),
      equity: this.ledger.equity(prices),
    });

    // The clerk runs on every fill, not at the close, because a break found at
    // 16:00 is a break that has been trading all afternoon.
    const rec = reconcile(this.receipts.all(), this.ledger.list());
    const cashBreak = reconcileCash(
      this.cfg.equity,
      this.ledger.executions,
      this.ledger.feesPaid,
      this.ledger.cashBalance,
    );
    if (!rec.ok || cashBreak) {
      const breaks = [...rec.breaks, ...(cashBreak ? [cashBreak] : [])];
      warn("clerk", `${alarm("BREAK")} ${breaks.map((b) => b.note).join("; ")}`);
      this.receipts.write("risk.halt", "clerk", { reason: "reconciliation break", breaks });
      this.stopped = true;
    }
  }

  private recentCleared(): RiskIn["recent"] {
    return [...this.tickets]
      .reverse()
      .filter((t) => t.state !== "written" && t.state !== "refused")
      .slice(0, 8)
      .map((t) => ({ symbol: t.symbol, side: t.side, desk: t.desk, thesis: t.thesis }));
  }

  // ── the close ──────────────────────────────────────────────────────────────

  private async close(): Promise<FloorState> {
    const snapshot = this.feed.peek();
    const prices = this.prices(snapshot);

    const refusedBy: Record<string, number> = {};
    let cleared = 0;
    let refused = 0;
    for (const v of this.verdicts.values()) {
      if (v.pass) cleared++;
      else {
        refused++;
        const key = v.refusedBy ?? "unknown";
        refusedBy[key] = (refusedBy[key] ?? 0) + 1;
      }
    }

    const fills = this.ledger.executions.reduce((s, e) => s + e.fills.length, 0);
    const avgSlippage =
      this.ledger.executions.length > 0
        ? this.ledger.executions.reduce((s, e) => s + e.slippageBps, 0) / this.ledger.executions.length
        : 0;
    const savedBps =
      this.savedBpsRunning.length > 0
        ? this.savedBpsRunning.reduce((s, v) => s + v, 0) / this.savedBpsRunning.length
        : 0;

    const commsRes = await this.seats.comms.run({
      sessionId: this.sessionId,
      minutes: snapshot.minute,
      equityStart: this.cfg.equity,
      equityEnd: this.ledger.equity(prices),
      realised: this.ledger.realised,
      unrealised: this.ledger.unrealised(prices),
      fees: this.ledger.feesPaid,
      ticketsWritten: this.tickets.length,
      ticketsCleared: cleared,
      ticketsRefused: refused,
      refusedBy,
      fills,
      avgSlippageBps: +avgSlippage.toFixed(2),
      savedBps: +savedBps.toFixed(2),
      openNames: this.ledger.marks(prices).map((m) => ({
        symbol: m.symbol,
        size: m.size,
        unrealisedPct: m.unrealisedPct,
      })),
      haltedBecause: this.gate.isHalted ? this.gate.haltedBecause : "",
      receiptHead: this.receipts.head,
    });

    this.receipts.write("session.close", "comms", {
      sessionId: this.sessionId,
      minutes: snapshot.minute,
      equityStart: this.cfg.equity,
      equityEnd: this.ledger.equity(prices),
      realised: this.ledger.realised,
      unrealised: this.ledger.unrealised(prices),
      fees: this.ledger.feesPaid,
      tickets: { written: this.tickets.length, cleared, refused, refusedBy },
      fills,
      avgSlippageBps: +avgSlippage.toFixed(2),
      savedBps: +savedBps.toFixed(2),
      summary: commsRes.out.summary,
      seats: this.seatStats(),
    });

    const pnl = this.ledger.sessionPnl(prices);
    say("floor", `${badge("CLOSE")} ${money(this.cfg.equity)} → ${money(this.ledger.equity(prices))} · ${pct((pnl / this.cfg.equity) * 100)}`);
    for (const line of commsRes.out.summary.split("\n")) say("comms", line);
    say("floor", `receipts ${this.receipts.count} lines · head ${brass(this.receipts.head.slice(0, 16))} · ${this.receipts.file}`);

    return this.state();
  }

  /** Theses closed this session, for `outcry score`. */
  closedTheses(): ClosedThesis[] {
    const snapshot = this.feed.peek();
    const out: ClosedThesis[] = [];
    for (const { ticket, price, minute } of this.opened.values()) {
      const horizonEnd = minute + ticket.horizonMin;
      const truncated = horizonEnd > snapshot.minute;
      const horizonPrice = snapshot.quotes[ticket.symbol]?.last ?? price;
      out.push({
        ticketId: ticket.id,
        symbol: ticket.symbol,
        desk: ticket.desk,
        side: ticket.side,
        thesis: ticket.thesis,
        entryPrice: price,
        horizonMin: ticket.horizonMin,
        horizonPrice,
        truncated,
      });
    }
    return out;
  }

  /** The overnight pass. Run after the close; writes one more receipt. */
  async score(): Promise<{ carry: string; scores: ThesisScore[] }> {
    const closed = this.closedTheses();
    const scribe = scribeFor(this.cfg, closed);
    const res = await scribe.run({ sessionId: this.sessionId, closed });
    this.receipts.write("overnight.score", "scribe", {
      scores: res.out.scores,
      carry: res.out.carry,
      model: res.completion?.model ?? "offline",
    });
    return { carry: res.out.carry, scores: res.out.scores };
  }

  seatStats(): Record<string, unknown> {
    return {
      tape: { model: this.seats.tape.model, ...this.seats.tape.stats },
      quant: { model: this.seats.desks.quant.model, ...this.seats.desks.quant.stats },
      macro: { model: this.seats.desks.macro.model, ...this.seats.desks.macro.stats },
      credit: { model: this.seats.desks.credit.model, ...this.seats.desks.credit.stats },
      digital: { model: this.seats.desks.digital.model, ...this.seats.desks.digital.stats },
      risk: { model: this.seats.risk.model, ...this.seats.risk.stats },
      pm: { model: this.seats.pm.model, ...this.seats.pm.stats },
      exec: { model: this.seats.exec.model, ...this.seats.exec.stats },
      chief: { model: this.seats.chief.model, ...this.seats.chief.stats },
      comms: { model: this.seats.comms.model, ...this.seats.comms.stats },
    };
  }
}
