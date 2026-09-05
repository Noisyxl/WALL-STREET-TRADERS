/**
 * The vocabulary of the floor.
 *
 * Everything that crosses a module boundary is one of these shapes. They are
 * deliberately flat and JSON-safe: every one of them ends up inside a receipt
 * on disk, and a receipt that cannot be re-read is not a receipt.
 */

export type Side = "buy" | "sell";

/** Where a seat sits. See docs/SEATS.md for what each one is asked to do. */
export type Seat =
  | "chief"
  | "tape"
  | "quant"
  | "macro"
  | "credit"
  | "digital"
  | "risk"
  | "pm"
  | "exec"
  | "clerk"
  | "scribe"
  | "comms";

/** The four desks that may originate a ticket. The other eight seats may not. */
export const DESKS = ["quant", "macro", "credit", "digital"] as const;
export type Desk = (typeof DESKS)[number];

// ─── the tape ────────────────────────────────────────────────────────────────

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One name as the floor sees it at a single instant. */
export interface Quote {
  symbol: string;
  ts: number;
  last: number;
  /** Change on the session, in percent. */
  changePct: number;
  bid: number;
  ask: number;
  /** Displayed size at the touch, in shares. */
  bidSize: number;
  askSize: number;
  /** Session volume so far. */
  volume: number;
  /** Realised volatility over the trailing window, annualised, in percent. */
  vol: number;
}

/** What the tape publishes on every tick: the whole board in one object. */
export interface TapeSnapshot {
  ts: number;
  /** Market minute since the open, 0-based. */
  minute: number;
  quotes: Record<string, Quote>;
  /** Session-wide readings the desks share. */
  session: {
    vix: number;
    tenY: number;
    dxy: number;
    /** Share of the universe up on the session, in percent. */
    breadth: number;
  };
}

/** A tape read: what changed since the last one, in words a desk can use. */
export interface TapeEvent {
  ts: number;
  symbol: string;
  kind: "break" | "reversal" | "volume" | "spread" | "gap" | "quiet";
  note: string;
  /** 0..1, how much the tape seat wants a desk to look at this. */
  weight: number;
}

// ─── tickets ─────────────────────────────────────────────────────────────────

export type TicketState =
  | "written"
  | "queued"
  | "cleared"
  | "refused"
  | "working"
  | "filled"
  | "partial"
  | "cancelled";

/** What a desk writes. It is an intention, not an order. */
export interface Ticket {
  id: string;
  ts: number;
  desk: Desk;
  symbol: string;
  side: Side;
  /** Requested notional in quote currency, before the gate and the PM size it. */
  notional: number;
  /** Worst price the desk will accept. Absent means the desk will take the book. */
  limit?: number;
  /** One sentence. This is what the overnight scorer grades. */
  thesis: string;
  /** How long the desk expects the thesis to hold, in market minutes. */
  horizonMin: number;
  /** 0..100, the desk's own reading of its edge. Not a probability. */
  conviction: number;
  state: TicketState;
}

/** What the gate returns. Every ticket gets exactly one of these. */
export interface Verdict {
  ticketId: string;
  ts: number;
  pass: boolean;
  /** Notional the gate will allow, in quote currency. Never above the request. */
  allowed: number;
  /** Every rule that fired, in the order it was checked. */
  reasons: string[];
  /** Which limit refused it, when `pass` is false. */
  refusedBy?: string;
  /** Set when a model reviewed the ticket on top of the hard limits. */
  review?: { seat: "risk"; model: string; verdict: string; note: string };
}

// ─── the book and fills ──────────────────────────────────────────────────────

export interface Level {
  price: number;
  size: number;
}

export interface BookState {
  symbol: string;
  ts: number;
  bids: Level[];
  asks: Level[];
}

export interface Fill {
  ts: number;
  price: number;
  size: number;
  /** Which level of the book this child order reached, 0-based. */
  level: number;
}

/** The result of working one ticket through the book. */
export interface Execution {
  ticketId: string;
  symbol: string;
  side: Side;
  fills: Fill[];
  /** Size-weighted average price across every fill. */
  avgPrice: number;
  filledSize: number;
  requestedSize: number;
  /** Signed cost against the touch at the moment the order started, in bps. */
  slippageBps: number;
  /** Set when the order stopped before it was done. */
  unfilledReason?: string;
}

// ─── the ledger ──────────────────────────────────────────────────────────────

export interface Position {
  symbol: string;
  /** Positive long, negative short. */
  size: number;
  avgPrice: number;
  realised: number;
  /** Ticket that opened the current size. */
  openedBy: string;
  openedAt: number;
}

export interface Mark {
  symbol: string;
  size: number;
  avgPrice: number;
  last: number;
  unrealised: number;
  unrealisedPct: number;
}

/** An append-only, hash-chained record of one thing that happened. */
export interface Receipt {
  seq: number;
  ts: number;
  kind:
    | "session.open"
    | "session.close"
    | "tape.read"
    | "ticket.written"
    | "gate.verdict"
    | "order.working"
    | "order.fill"
    | "order.done"
    | "position.change"
    | "risk.halt"
    | "overnight.score";
  seat: Seat | "floor";
  /** The payload. Shape depends on `kind`; see docs/RECEIPTS.md. */
  body: Record<string, unknown>;
  /** sha256 over `seq|ts|kind|seat|body|prev`. */
  hash: string;
  prev: string;
}

// ─── overnight ───────────────────────────────────────────────────────────────

/** What the scorer writes about one closed thesis. */
export interface ThesisScore {
  ticketId: string;
  symbol: string;
  desk: Desk;
  thesis: string;
  /** "paid" when the thesis was right within its horizon, "died" when it was not. */
  outcome: "paid" | "died" | "open";
  /** Move over the horizon, in percent, signed for the direction the desk took. */
  movePct: number;
  note: string;
}
