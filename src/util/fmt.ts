/** Formatting. The floor prints numbers before adjectives, so this file matters. */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  ink: "\x1b[38;2;43;33;24m",
  paper: "\x1b[38;2;237;227;204m",
  brass: "\x1b[38;2;199;154;60m",
  red: "\x1b[38;2;180;69;60m",
  green: "\x1b[38;2;63;122;78m",
  muted: "\x1b[38;2;122;106;86m",
  onBrass: "\x1b[48;2;199;154;60m\x1b[38;2;43;33;24m",
  onRed: "\x1b[48;2;180;69;60m\x1b[38;2;237;227;204m",
} as const;

const noColor = (): boolean =>
  process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

const wrap = (code: string, s: string): string => (noColor() ? s : code + s + C.reset);

export const brass = (s: string): string => wrap(C.brass, s);
export const muted = (s: string): string => wrap(C.muted, s);
export const dim = (s: string): string => wrap(C.dim, s);
export const red = (s: string): string => wrap(C.red, s);
export const green = (s: string): string => wrap(C.green, s);
export const badge = (s: string): string => wrap(C.onBrass, ` ${s} `);
export const alarm = (s: string): string => wrap(C.onRed, ` ${s} `);

/**
 * A price, always with the same number of decimals so columns line up.
 *
 * `+ 0` normalises negative zero: -0 is >= 0, so a sign prefix elsewhere would
 * print "+" and this would print "-0.0", giving "+-0.0" on a flat number.
 */
export const px = (n: number, dp = 2): string =>
  (n + 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Money with a currency-free thousands separator. */
export const money = (n: number): string =>
  (n < 0 ? "-" : "") + "$" + px(Math.abs(n), Math.abs(n) < 100 ? 2 : 0);

/** A signed percentage, coloured only when it is negative. Profit is not green. */
export const pct = (n: number, dp = 2): string => {
  const s = `${n >= 0 ? "+" : ""}${px(n, dp)}%`;
  return n < 0 ? red(s) : s;
};

export const bps = (n: number): string => `${n >= 0 ? "+" : ""}${px(n, 1)} bps`;

/** Shares, grouped. */
export const shares = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A clock in HH:MM:SS from a market minute offset since 09:30. */
export const clock = (minute: number): string => {
  const total = 9 * 60 + 30 + Math.floor(minute);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export const pad = (s: string, w: number): string =>
  s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);

export const lpad = (s: string, w: number): string =>
  s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;

/** A horizontal rule the width of the board. */
export const rule = (w = 78, ch = "─"): string => muted(ch.repeat(w));

/** A fill bar for the floorview and the CLI, 0..1. */
export const bar = (frac: number, w = 20): string => {
  const f = Math.max(0, Math.min(1, frac));
  const on = Math.round(f * w);
  return "█".repeat(on) + muted("░".repeat(w - on));
};
