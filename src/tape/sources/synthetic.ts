import type { BookState, Level, Quote, TapeSnapshot } from "../../types.js";
import type { Feed } from "../feed.js";
import { breadth } from "../feed.js";
import { gaussian, mulberry32 } from "../../util/id.js";

/**
 * A seeded market.
 *
 * It exists for one reason: a claim about a session has to be checkable by
 * someone who was not there. `TAPE_SEED=1792` produces the same 390 minutes on
 * any machine, so "the floor took this trade at this price" is a statement
 * anyone can reproduce, and the test suite runs with no network at all.
 *
 * What it models, and nothing more:
 *   - a drift-free geometric random walk per name, at its own volatility
 *   - one market factor every name loads on, so breadth is not noise
 *   - a U-shaped intraday volume curve, heavy at the open and the close
 *   - a spread that widens with volatility and tightens with volume
 *   - a five-level book whose depth thins as you walk away from the touch
 *
 * What it does not model: news, earnings, halts, auctions, borrow, or anyone
 * else's order flow. It is a rehearsal room, not a market.
 */

interface Name {
  symbol: string;
  ref: number;
  last: number;
  open: number;
  annualVol: number;
  beta: number;
  advShares: number;
  volume: number;
  tick: number;
}

const SEEDS: Record<string, { ref: number; vol: number; beta: number; adv: number }> = {
  NVDA: { ref: 185.39, vol: 48, beta: 1.35, adv: 210_000_000 },
  TSM: { ref: 212.12, vol: 34, beta: 1.05, adv: 22_000_000 },
  MU: { ref: 128.72, vol: 52, beta: 1.4, adv: 30_000_000 },
  AVGO: { ref: 248.19, vol: 38, beta: 1.15, adv: 28_000_000 },
  META: { ref: 707.9, vol: 31, beta: 1.0, adv: 14_000_000 },
  AMD: { ref: 164.4, vol: 46, beta: 1.3, adv: 45_000_000 },
  ASML: { ref: 812.5, vol: 33, beta: 1.1, adv: 4_000_000 },
  ARM: { ref: 138.2, vol: 55, beta: 1.45, adv: 12_000_000 },
};

/** Intraday volume curve: heavy at the bells, thin at lunch. */
function volumeShape(minute: number, sessionMin: number): number {
  const t = Math.max(0, Math.min(1, minute / sessionMin));
  return 0.55 + 1.9 * Math.exp(-((t - 0.02) ** 2) / 0.006) + 1.3 * Math.exp(-((t - 0.98) ** 2) / 0.01);
}

export interface SyntheticOptions {
  universe: readonly string[];
  seed: number;
  sessionMin: number;
  /** Market minutes advanced per tick. */
  minutesPerTick?: number;
}

export class SyntheticFeed implements Feed {
  readonly name = "synthetic";
  readonly universe: readonly string[];

  private readonly rng: () => number;
  private readonly names = new Map<string, Name>();
  private readonly sessionMin: number;
  private readonly step: number;
  private m = 0;
  private t0 = Date.UTC(2026, 8, 4, 13, 30, 0);
  private vix = 14.2;
  private tenY = 4.18;
  private dxy = 103.4;
  private snapshot: TapeSnapshot;

  constructor(opts: SyntheticOptions) {
    this.universe = opts.universe;
    this.rng = mulberry32(opts.seed);
    this.sessionMin = opts.sessionMin;
    this.step = opts.minutesPerTick ?? 1;

    for (const symbol of opts.universe) {
      const s = SEEDS[symbol] ?? { ref: 100 + this.rng() * 200, vol: 40, beta: 1.1, adv: 10_000_000 };
      const gap = gaussian(this.rng) * (s.vol / 100) * 0.35;
      const open = Math.max(1, s.ref * (1 + gap / 100));
      this.names.set(symbol, {
        symbol,
        ref: s.ref,
        last: open,
        open,
        annualVol: s.vol,
        beta: s.beta,
        advShares: s.adv,
        volume: 0,
        tick: open > 500 ? 0.05 : 0.01,
      });
    }

    this.snapshot = this.build();
  }

  get minute(): number {
    return this.m;
  }

  get done(): boolean {
    return this.m >= this.sessionMin;
  }

  peek(): TapeSnapshot {
    return this.snapshot;
  }

  tick(): TapeSnapshot | null {
    if (this.done) return null;
    this.m += this.step;

    // One factor everyone loads on, plus idiosyncratic noise per name.
    const factor = gaussian(this.rng) * 0.0009;
    const shape = volumeShape(this.m, this.sessionMin);

    for (const n of this.names.values()) {
      const perMinuteVol = (n.annualVol / 100) / Math.sqrt(252 * 390);
      const shock = n.beta * factor + gaussian(this.rng) * perMinuteVol;
      n.last = Math.max(n.tick, n.last * (1 + shock * this.step));
      n.last = Math.round(n.last / n.tick) * n.tick;
      const perMinuteShares = n.advShares / 390;
      n.volume += Math.round(perMinuteShares * shape * (0.6 + this.rng() * 0.9) * this.step);
    }

    this.vix = Math.max(9, this.vix + gaussian(this.rng) * 0.08 - (this.vix - 14.2) * 0.02);
    this.tenY = Math.max(0.5, this.tenY + gaussian(this.rng) * 0.004);
    this.dxy = this.dxy + gaussian(this.rng) * 0.03;

    this.snapshot = this.build();
    return this.snapshot;
  }

  book(symbol: string): BookState {
    const n = this.names.get(symbol);
    if (!n) throw new Error(`${symbol} is not on this board`);
    const q = this.quote(n);
    const bids: Level[] = [];
    const asks: Level[] = [];
    const base = displayedSize(n);

    for (let i = 0; i < 8; i++) {
      // Depth thins geometrically away from the touch; the far levels are where
      // a careless market order finds out what it costs.
      const decay = Math.exp(-i * 0.42);
      const jitter = 0.7 + this.rng() * 0.6;
      bids.push({
        price: round(q.bid - i * n.tick, n.tick),
        size: Math.max(1, Math.round(base * decay * jitter)),
      });
      asks.push({
        price: round(q.ask + i * n.tick, n.tick),
        size: Math.max(1, Math.round(base * decay * jitter)),
      });
    }
    return { symbol, ts: this.snapshot.ts, bids, asks };
  }

  private quote(n: Name): Quote {
    // Spread widens with volatility, tightens as the day's volume builds.
    const volFactor = n.annualVol / 40;
    const liq = Math.max(0.35, 1 - this.m / (this.sessionMin * 1.6));
    const halfBps = Math.max(0.4, 1.6 * volFactor * liq);
    const half = Math.max(n.tick / 2, (n.last * halfBps) / 10_000);
    const bid = round(n.last - half, n.tick);
    const ask = round(n.last + half, n.tick);
    const base = displayedSize(n);
    return {
      symbol: n.symbol,
      ts: this.snapshot?.ts ?? this.t0,
      last: n.last,
      changePct: ((n.last - n.open) / n.open) * 100,
      bid,
      ask,
      bidSize: Math.max(1, Math.round(base * (0.6 + this.rng() * 0.8))),
      askSize: Math.max(1, Math.round(base * (0.6 + this.rng() * 0.8))),
      volume: n.volume,
      vol: n.annualVol,
    };
  }

  private build(): TapeSnapshot {
    const quotes: Record<string, Quote> = {};
    for (const n of this.names.values()) quotes[n.symbol] = this.quote(n);
    return {
      ts: this.t0 + this.m * 60_000,
      minute: this.m,
      quotes,
      session: {
        vix: round(this.vix, 0.01),
        tenY: round(this.tenY, 0.001),
        dxy: round(this.dxy, 0.01),
        breadth: round(breadth(quotes), 0.1),
      },
    };
  }
}

/**
 * Displayed size at the touch, in shares.
 *
 * Not a share of volume. What a book *shows* is a small multiple of the tick
 * value, not of the day's turnover, and it is quoted in dollars long before it
 * is quoted in shares: roughly $10k on a quiet name and $45k on the busiest,
 * which on a $700 stock is a few dozen shares and on a $130 stock is a few
 * hundred. Getting this wrong is the difference between a simulator where
 * every order fills at the touch — and therefore where execution is free and
 * this whole repository has no point — and one where size costs something.
 */
function displayedSize(n: Name): number {
  const notional = 8_000 + (n.advShares / 1_000_000) * 180;
  return Math.min(2_000, Math.max(15, Math.round(notional / n.last)));
}

const round = (v: number, step: number): number =>
  Math.round(v / step) * step + 0; // + 0 normalises -0
