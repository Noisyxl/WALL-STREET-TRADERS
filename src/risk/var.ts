import type { Position } from "../types.js";

/**
 * A one-day parametric value at risk, and the honest caveat that goes with it.
 *
 * VaR here is not a forecast. It is a single number that says how the current
 * book is arranged: how big it is, how correlated it is, and how volatile its
 * names are. Two books with the same gross exposure can differ by a factor of
 * three on this number, and that is the only thing it is used for — comparing
 * the book against itself, hour to hour, inside one session.
 *
 * What it assumes and therefore what it will get wrong: returns are normal,
 * correlations are the constant given, and the past volatility of each name
 * continues. All three assumptions fail exactly when it would matter most.
 * The floorview labels this panel `VAR` with the assumptions in the tooltip
 * for that reason.
 */

/** 1-day, 95 % one-tailed. 1.645 sigma. */
const Z95 = 1.645;
const TRADING_DAYS = 252;

export interface VarInput {
  positions: Position[];
  marks: Record<string, number>;
  /** Annualised volatility per name, in percent. */
  vols: Record<string, number>;
  /** Flat pairwise correlation across the book, 0..1. */
  correlation?: number;
}

export interface VarResult {
  /** One-day 95 % VaR, in quote currency, positive. */
  var95: number;
  /** The same as a share of gross exposure, in percent. */
  var95PctOfGross: number;
  /** Sum of each name's standalone VaR: what the book would risk uncorrelated. */
  standalone: number;
  /** standalone − var95: what the arrangement of the book saves. */
  diversification: number;
  /** Per-name contribution, largest first. */
  contributions: { symbol: string; var95: number; sharePct: number }[];
}

export function var95(input: VarInput): VarResult {
  const rho = Math.max(0, Math.min(1, input.correlation ?? 0.45));
  const daily = (annualPct: number): number => annualPct / 100 / Math.sqrt(TRADING_DAYS);

  const rows = input.positions
    .filter((p) => p.size !== 0)
    .map((p) => {
      const price = input.marks[p.symbol] ?? p.avgPrice;
      const value = p.size * price;
      const sigma = daily(input.vols[p.symbol] ?? 35);
      return { symbol: p.symbol, value, sigma, risk: value * sigma };
    });

  if (rows.length === 0) {
    return { var95: 0, var95PctOfGross: 0, standalone: 0, diversification: 0, contributions: [] };
  }

  // Portfolio variance with a flat correlation: sum of squares plus rho times
  // every cross term. Signed values, so a short against a long nets down.
  let variance = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      variance += (i === j ? 1 : rho) * a.risk * b.risk;
    }
  }
  const sigmaP = Math.sqrt(Math.max(0, variance));
  const v = sigmaP * Z95;

  const standalone = rows.reduce((s, r) => s + Math.abs(r.risk) * Z95, 0);
  const gross = rows.reduce((s, r) => s + Math.abs(r.value), 0);

  // Marginal contribution: d(VaR)/d(weight) scaled back to currency, so the
  // parts add to the whole.
  const contributions = rows
    .map((r) => {
      let cov = 0;
      for (const o of rows) cov += (o.symbol === r.symbol ? 1 : rho) * r.risk * o.risk;
      const contribution = sigmaP > 0 ? (cov / sigmaP) * Z95 : 0;
      return {
        symbol: r.symbol,
        var95: +contribution.toFixed(2),
        sharePct: v > 0 ? +((contribution / v) * 100).toFixed(1) : 0,
      };
    })
    .sort((a, b) => Math.abs(b.var95) - Math.abs(a.var95));

  return {
    var95: +v.toFixed(2),
    var95PctOfGross: gross > 0 ? +((v / gross) * 100).toFixed(2) : 0,
    standalone: +standalone.toFixed(2),
    diversification: +(standalone - v).toFixed(2),
    contributions,
  };
}
