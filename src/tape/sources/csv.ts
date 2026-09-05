import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Bar, BookState, Level, Quote, TapeSnapshot } from "../../types.js";
import type { Feed } from "../feed.js";
import { breadth } from "../feed.js";
import { mulberry32 } from "../../util/id.js";

/**
 * Replay from your own bars.
 *
 * One file per name, `<SYMBOL>.csv`, with a header row and these columns in
 * any order: ts, open, high, low, close, volume. `ts` is either an ISO string
 * or epoch milliseconds. Bars are sorted on load and the shortest file decides
 * how long the session runs.
 *
 * A bar is not a book. What the floor needs to work an order is depth, and no
 * bar file has it, so the book here is synthesised around the bar's close from
 * the bar's own range and volume: the spread comes from the high-low range,
 * the depth from the volume. This is stated in every receipt written during a
 * replay (`book: "inferred"`) so a fill from a replay is never mistaken for a
 * fill against real depth.
 */

export interface CsvOptions {
  dir: string;
  universe: readonly string[];
  seed: number;
}

function parseBars(text: string): Bar[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string): number => head.indexOf(name);
  const iTs = idx("ts") >= 0 ? idx("ts") : idx("time") >= 0 ? idx("time") : idx("date");
  const iO = idx("open");
  const iH = idx("high");
  const iL = idx("low");
  const iC = idx("close");
  const iV = idx("volume");
  if ([iTs, iO, iH, iL, iC, iV].some((i) => i < 0)) {
    throw new Error(`csv needs ts,open,high,low,close,volume; got: ${head.join(",")}`);
  }

  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(",");
    const rawTs = (c[iTs] ?? "").trim();
    const ts = /^\d+$/.test(rawTs) ? Number(rawTs) : Date.parse(rawTs);
    if (!Number.isFinite(ts)) continue;
    const bar: Bar = {
      ts,
      open: Number(c[iO]),
      high: Number(c[iH]),
      low: Number(c[iL]),
      close: Number(c[iC]),
      volume: Number(c[iV]),
    };
    if (!Number.isFinite(bar.close)) continue;
    bars.push(bar);
  }
  return bars.sort((a, b) => a.ts - b.ts);
}

export class CsvFeed implements Feed {
  readonly name = "csv";
  readonly universe: readonly string[];

  private readonly bars = new Map<string, Bar[]>();
  private readonly rng: () => number;
  private readonly length: number;
  private i = 0;
  private snapshot: TapeSnapshot;
  private cumVolume = new Map<string, number>();

  constructor(opts: CsvOptions) {
    if (!existsSync(opts.dir)) {
      throw new Error(
        `TAPE_CSV_DIR ${opts.dir} does not exist. Put one <SYMBOL>.csv per name there, or run with TAPE_SOURCE=synthetic.`,
      );
    }
    const present = new Set(
      readdirSync(opts.dir)
        .filter((f) => f.toLowerCase().endsWith(".csv"))
        .map((f) => f.replace(/\.csv$/i, "").toUpperCase()),
    );

    const wanted = opts.universe.filter((s) => present.has(s));
    if (wanted.length === 0) {
      throw new Error(
        `no csv found in ${opts.dir} for any of ${opts.universe.join(", ")}. Files present: ${[...present].join(", ") || "none"}`,
      );
    }

    for (const symbol of wanted) {
      const bars = parseBars(readFileSync(join(opts.dir, `${symbol}.csv`), "utf8"));
      if (bars.length === 0) throw new Error(`${symbol}.csv has no usable rows`);
      this.bars.set(symbol, bars);
      this.cumVolume.set(symbol, 0);
    }

    this.universe = wanted;
    this.rng = mulberry32(opts.seed);
    this.length = Math.min(...[...this.bars.values()].map((b) => b.length));
    this.snapshot = this.build();
  }

  get minute(): number {
    return this.i;
  }

  get done(): boolean {
    return this.i >= this.length - 1;
  }

  peek(): TapeSnapshot {
    return this.snapshot;
  }

  tick(): TapeSnapshot | null {
    if (this.done) return null;
    this.i += 1;
    for (const [symbol, bars] of this.bars) {
      const bar = bars[this.i];
      if (bar) this.cumVolume.set(symbol, (this.cumVolume.get(symbol) ?? 0) + bar.volume);
    }
    this.snapshot = this.build();
    return this.snapshot;
  }

  book(symbol: string): BookState {
    const bars = this.bars.get(symbol);
    const bar = bars?.[this.i];
    if (!bar) throw new Error(`${symbol} has no bar at index ${this.i}`);
    const q = this.quoteFor(symbol, bar, bars![0]!);
    const tick = bar.close > 500 ? 0.05 : 0.01;
    // Depth inferred from the bar's own volume; see the note at the top.
    const base = Math.max(50, Math.round(bar.volume * 0.04));
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let k = 0; k < 8; k++) {
      const decay = Math.exp(-k * 0.45) * (0.75 + this.rng() * 0.5);
      bids.push({ price: +(q.bid - k * tick).toFixed(4), size: Math.max(1, Math.round(base * decay)) });
      asks.push({ price: +(q.ask + k * tick).toFixed(4), size: Math.max(1, Math.round(base * decay)) });
    }
    return { symbol, ts: bar.ts, bids, asks };
  }

  private quoteFor(symbol: string, bar: Bar, first: Bar): Quote {
    // Spread from the bar's own range: a wide bar traded wide.
    const range = Math.max(bar.high - bar.low, bar.close * 0.0002);
    const half = Math.max(0.005, range * 0.06);
    const volume = this.cumVolume.get(symbol) ?? bar.volume;
    return {
      symbol,
      ts: bar.ts,
      last: bar.close,
      changePct: ((bar.close - first.open) / first.open) * 100,
      bid: +(bar.close - half).toFixed(4),
      ask: +(bar.close + half).toFixed(4),
      bidSize: Math.max(1, Math.round(bar.volume * 0.04)),
      askSize: Math.max(1, Math.round(bar.volume * 0.04)),
      volume,
      vol: +(((range / bar.close) * Math.sqrt(252 * 390) * 100)).toFixed(1),
    };
  }

  private build(): TapeSnapshot {
    const quotes: Record<string, Quote> = {};
    let ts = 0;
    for (const [symbol, bars] of this.bars) {
      const bar = bars[this.i] ?? bars[bars.length - 1]!;
      quotes[symbol] = this.quoteFor(symbol, bar, bars[0]!);
      ts = Math.max(ts, bar.ts);
    }
    return {
      ts,
      minute: this.i,
      quotes,
      session: { vix: 0, tenY: 0, dxy: 0, breadth: +breadth(quotes).toFixed(1) },
    };
  }
}
