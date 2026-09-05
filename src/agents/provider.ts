import { withDeadline, withRetry } from "../util/retry.js";

/**
 * Model access.
 *
 * Two wire formats cover every endpoint this floor talks to: the OpenAI chat
 * completions shape (which xAI, together with most self-hosted servers, speaks)
 * and the Anthropic messages shape. A provider is chosen per seat by the model
 * name, so `MODEL_GATE=claude-opus-4-5` and `MODEL_TAPE=grok-4.1-fast` route
 * themselves without any wiring.
 *
 * The third provider is `stub`. It answers from deterministic rules, needs no
 * key and no network, and is what runs when a key is missing. That is not a
 * degraded mode bolted on for tests — it is the reason the whole floor can be
 * run, read and reasoned about by someone who has no API budget at all, and
 * the reason `npm test` is offline.
 */

export interface CallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Hard ceiling on how long one seat may hold the floor, in ms. */
  deadlineMs?: number;
}

export interface Completion {
  text: string;
  model: string;
  provider: "xai" | "anthropic" | "stub";
  /** Milliseconds from call to answer. */
  ms: number;
  usage?: { input: number; output: number };
}

export interface Provider {
  readonly kind: "xai" | "anthropic" | "stub";
  complete(model: string, opts: CallOptions): Promise<Completion>;
}

export interface ProviderKeys {
  xai: string;
  anthropic: string;
}

export interface ProviderBases {
  xai: string;
  anthropic: string;
}

/** Which wire format a model name implies. */
export function providerFor(model: string): "xai" | "anthropic" {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m.includes("anthropic")) return "anthropic";
  return "xai";
}

class OpenAICompatible implements Provider {
  readonly kind = "xai" as const;
  constructor(private readonly base: string, private readonly key: string) {}

  async complete(model: string, opts: CallOptions): Promise<Completion> {
    const t0 = Date.now();
    const body = {
      model,
      max_tokens: opts.maxTokens ?? 900,
      temperature: opts.temperature ?? 0.2,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    };

    const json = await withDeadline(
      () =>
        withRetry(async () => {
          const res = await fetch(`${this.base}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.key}`,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const err = new Error(`${model}: ${res.status} ${await res.text()}`);
            (err as { status?: number }).status = res.status;
            throw err;
          }
          return (await res.json()) as {
            choices?: { message?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
        }),
      opts.deadlineMs ?? 30_000,
      model,
    );

    return {
      text: json.choices?.[0]?.message?.content ?? "",
      model,
      provider: "xai",
      ms: Date.now() - t0,
      usage: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

class AnthropicMessages implements Provider {
  readonly kind = "anthropic" as const;
  constructor(private readonly base: string, private readonly key: string) {}

  async complete(model: string, opts: CallOptions): Promise<Completion> {
    const t0 = Date.now();
    const body = {
      model,
      max_tokens: opts.maxTokens ?? 900,
      temperature: opts.temperature ?? 0.2,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    };

    const json = await withDeadline(
      () =>
        withRetry(async () => {
          const res = await fetch(`${this.base}/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": this.key,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const err = new Error(`${model}: ${res.status} ${await res.text()}`);
            (err as { status?: number }).status = res.status;
            throw err;
          }
          return (await res.json()) as {
            content?: { type: string; text?: string }[];
            usage?: { input_tokens?: number; output_tokens?: number };
          };
        }),
      opts.deadlineMs ?? 30_000,
      model,
    );

    return {
      text: (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
      model,
      provider: "anthropic",
      ms: Date.now() - t0,
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
      },
    };
  }
}

/**
 * The offline seat.
 *
 * It is handed the same system and user prompt as a real model and answers
 * with the rule-based fallback the seat registered. Every seat in
 * src/agents/seats/ ships one, which is why a run with no keys still produces
 * tickets, verdicts, fills and a close summary — with `provider: "stub"` on
 * every receipt so nobody mistakes it for a model's judgement.
 */
export class StubProvider implements Provider {
  readonly kind = "stub" as const;
  constructor(private readonly answer: (system: string, user: string) => string) {}

  async complete(model: string, opts: CallOptions): Promise<Completion> {
    const t0 = Date.now();
    const text = this.answer(opts.system, opts.user);
    return { text, model: `${model}:stub`, provider: "stub", ms: Date.now() - t0 };
  }
}

export function makeProvider(
  model: string,
  keys: ProviderKeys,
  bases: ProviderBases,
  stub: (system: string, user: string) => string,
): Provider {
  const kind = providerFor(model);
  if (kind === "anthropic" && keys.anthropic) {
    return new AnthropicMessages(bases.anthropic, keys.anthropic);
  }
  if (kind === "xai" && keys.xai) {
    return new OpenAICompatible(bases.xai, keys.xai);
  }
  return new StubProvider(stub);
}
