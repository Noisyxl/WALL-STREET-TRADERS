/**
 * Every knob the floor has, read once at startup.
 *
 * There is no config file. Everything comes from the environment, every value
 * has a default that works with no key set, and `outcry doctor` prints the
 * resolved set so you can see what the floor actually believes.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path = ".env"): void {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return;
  for (const raw of readFileSync(full, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadDotEnv();

const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (k: string, d: string): string => process.env[k]?.trim() || d;
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k]?.trim().toLowerCase();
  if (v === undefined || v === "") return d;
  return v === "1" || v === "true" || v === "yes" || v === "on";
};
const list = (k: string, d: string[]): string[] => {
  const v = process.env[k]?.trim();
  if (!v) return d;
  return v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
};

export interface RiskLimits {
  maxTicketPct: number;
  maxPositionPct: number;
  maxGrossPct: number;
  maxNetPct: number;
  maxNames: number;
  dayStopPct: number;
  queueDepth: number;
}

export interface ExecConfig {
  style: "work" | "sweep";
  maxLevels: number;
  participationPct: number;
  minChild: number;
  /** How much of a taken level comes back between child orders. See book/walk.ts. */
  replenishPct: number;
}

export interface ModelConfig {
  tape: string;
  desk: string;
  gate: string;
  floor: string;
  overnight: string;
}

export interface Config {
  mode: "paper" | "replay";
  equity: number;
  universe: string[];
  tickMs: number;
  sessionMin: number;
  risk: RiskLimits;
  exec: ExecConfig;
  models: ModelConfig;
  tape: { source: "synthetic" | "csv"; csvDir: string; seed: number };
  view: { port: number; open: boolean };
  dataDir: string;
  keys: { xai: string; anthropic: string };
  bases: { xai: string; anthropic: string };
}

export function loadConfig(): Config {
  const mode = str("FLOOR_MODE", "paper") === "replay" ? "replay" : "paper";
  const style = str("EXEC_STYLE", "work") === "sweep" ? "sweep" : "work";
  const source = str("TAPE_SOURCE", "synthetic") === "csv" ? "csv" : "synthetic";

  return {
    mode,
    equity: num("FLOOR_EQUITY", 250_000),
    universe: list("FLOOR_UNIVERSE", ["NVDA", "TSM", "MU", "AVGO", "META"]),
    tickMs: num("FLOOR_TICK_MS", 1000),
    sessionMin: num("FLOOR_SESSION_MIN", 390),
    risk: {
      maxTicketPct: num("RISK_MAX_TICKET_PCT", 4),
      maxPositionPct: num("RISK_MAX_POSITION_PCT", 12),
      maxGrossPct: num("RISK_MAX_GROSS_PCT", 90),
      maxNetPct: num("RISK_MAX_NET_PCT", 60),
      maxNames: num("RISK_MAX_NAMES", 8),
      dayStopPct: num("RISK_DAY_STOP_PCT", 3),
      queueDepth: num("RISK_QUEUE_DEPTH", 6),
    },
    exec: {
      style,
      maxLevels: num("EXEC_MAX_LEVELS", 5),
      participationPct: num("EXEC_PARTICIPATION", 8),
      minChild: num("EXEC_MIN_CHILD", 1),
      replenishPct: num("EXEC_REPLENISH", 60),
    },
    models: {
      tape: str("MODEL_TAPE", "grok-4.1-fast"),
      desk: str("MODEL_DESK", "claude-sonnet-4-5"),
      gate: str("MODEL_GATE", "claude-opus-4-5"),
      floor: str("MODEL_FLOOR", "grok-4.1"),
      overnight: str("MODEL_OVERNIGHT", "claude-haiku-4-5"),
    },
    tape: {
      source,
      csvDir: str("TAPE_CSV_DIR", "./data/bars"),
      seed: num("TAPE_SEED", 1792),
    },
    view: { port: num("VIEW_PORT", 1792), open: bool("VIEW_OPEN", false) },
    dataDir: str("DATA_DIR", "./data"),
    keys: { xai: str("XAI_API_KEY", ""), anthropic: str("ANTHROPIC_API_KEY", "") },
    bases: {
      xai: str("XAI_BASE_URL", "https://api.x.ai/v1"),
      anthropic: str("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"),
    },
  };
}
