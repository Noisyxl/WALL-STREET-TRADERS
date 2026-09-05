import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Seat } from "../types.js";
import type { Completion, Provider } from "./provider.js";

/**
 * A seat.
 *
 * Every agent on this floor is the same three things: a prompt file, a model,
 * and a schema its answer has to satisfy. There is no seat that gets to be
 * special, no seat that can call another seat directly, and no seat that can
 * write to the ledger. They return data; the floor decides what happens to it.
 *
 * That constraint is what makes the floor debuggable. When a session goes
 * wrong, the question is never "which agent did this" — it is "which receipt",
 * and the receipt names the seat, the model, the prompt hash and the raw text
 * that came back.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** prompts/ sits next to src/ in a checkout and next to dist/ after a build. */
function promptPath(seat: Seat): string {
  const candidates = [
    join(HERE, "..", "..", "prompts", `${seat}.md`),
    join(HERE, "..", "..", "..", "prompts", `${seat}.md`),
    join(process.cwd(), "prompts", `${seat}.md`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`prompt for the ${seat} seat not found; looked in ${candidates.join(", ")}`);
}

const cache = new Map<Seat, string>();

export function loadPrompt(seat: Seat): string {
  const hit = cache.get(seat);
  if (hit) return hit;
  const text = readFileSync(promptPath(seat), "utf8");
  cache.set(seat, text);
  return text;
}

export interface AgentSpec<Out> {
  seat: Seat;
  model: string;
  provider: Provider;
  /** Turn the floor's state into the user turn. */
  brief: (input: never) => string;
  /** Parse and validate. Return null to fall back to the seat's own default. */
  parse: (text: string) => Out | null;
  /** What the seat does when parsing fails or the model is unreachable. */
  fallback: (input: never) => Out;
  maxTokens?: number;
  temperature?: number;
  deadlineMs?: number;
}

export interface AgentResult<Out> {
  seat: Seat;
  out: Out;
  /** Set when the answer came from a model rather than the fallback. */
  completion?: Completion;
  /** Why the fallback was used, when it was. */
  degraded?: string;
  ms: number;
}

export class Agent<In, Out> {
  readonly seat: Seat;
  readonly model: string;
  private readonly spec: AgentSpec<Out>;
  private calls = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private msTotal = 0;

  constructor(spec: AgentSpec<Out>) {
    this.spec = spec;
    this.seat = spec.seat;
    this.model = spec.model;
  }

  get stats(): { calls: number; tokensIn: number; tokensOut: number; msAvg: number } {
    return {
      calls: this.calls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      msAvg: this.calls ? Math.round(this.msTotal / this.calls) : 0,
    };
  }

  async run(input: In): Promise<AgentResult<Out>> {
    const t0 = Date.now();
    const system = loadPrompt(this.spec.seat);
    const user = this.spec.brief(input as never);

    let completion: Completion | undefined;
    let degraded: string | undefined;
    let out: Out;

    try {
      completion = await this.spec.provider.complete(this.spec.model, {
        system,
        user,
        maxTokens: this.spec.maxTokens ?? 800,
        temperature: this.spec.temperature ?? 0.2,
        deadlineMs: this.spec.deadlineMs ?? 25_000,
      });
      const parsed = completion.text ? this.spec.parse(completion.text) : null;
      if (parsed === null) {
        degraded =
          completion.provider === "stub"
            ? `no key for ${this.spec.model}; the seat ran its offline rule`
            : "answer did not parse against the seat's schema";
        out = this.spec.fallback(input as never);
      } else {
        out = parsed;
      }
    } catch (err) {
      degraded = (err as Error).message;
      out = this.spec.fallback(input as never);
    }

    this.calls++;
    const ms = Date.now() - t0;
    this.msTotal += ms;
    if (completion?.usage) {
      this.tokensIn += completion.usage.input;
      this.tokensOut += completion.usage.output;
    }

    return {
      seat: this.spec.seat,
      out,
      ...(completion ? { completion } : {}),
      ...(degraded ? { degraded } : {}),
      ms,
    };
  }
}

/**
 * Models are asked for JSON and sometimes return prose around it. This finds
 * the first balanced object or array in the text rather than trusting the
 * model to have obeyed. A seat whose answer cannot be found here falls back —
 * it never guesses.
 */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;

  const start = body.search(/[[{]/);
  if (start < 0) return null;

  const open = body[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Clamp a model's number into a range, or return null so the seat falls back. */
export function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

export function str(v: unknown, maxLen = 240): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, maxLen) : null;
}
