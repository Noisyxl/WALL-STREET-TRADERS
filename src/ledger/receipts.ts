import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt, Seat } from "../types.js";
import { sha256 } from "../util/id.js";

/**
 * Receipts.
 *
 * The claim this repository makes is not that the floor is profitable. It is
 * that every number the floor prints can be traced to the thing that produced
 * it. That claim is only worth something if the trail cannot be edited after
 * the fact, so the trail is a hash chain:
 *
 *     hash_n = sha256(seq | ts | kind | seat | body | hash_{n-1})
 *
 * Change one field in one line of a session's JSONL and every hash after it
 * stops matching. `outcry receipts --verify` walks the file and prints the
 * first line where the chain breaks, or the head hash when it does not.
 *
 * This is a tamper-evident log, not a tamper-proof one: anyone with the file
 * can rewrite it end to end and recompute every hash. What it defends against
 * is a single edited line — someone quietly improving one fill after a bad
 * session — and it gives a session one short string you can publish before
 * anyone asks to see the detail.
 */

const GENESIS = "0".repeat(64);

export function digest(r: Omit<Receipt, "hash">): string {
  return sha256(
    [r.seq, r.ts, r.kind, r.seat, JSON.stringify(r.body), r.prev].join("|"),
  );
}

export class ReceiptBook {
  private seq = 0;
  private prev = GENESIS;
  private readonly path: string;
  private readonly memory: Receipt[] = [];
  private readonly keepInMemory: boolean;

  constructor(dataDir: string, sessionId: string, opts: { memory?: boolean } = {}) {
    this.path = join(dataDir, "receipts", `${sessionId}.jsonl`);
    this.keepInMemory = opts.memory ?? true;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  get file(): string {
    return this.path;
  }

  get head(): string {
    return this.prev;
  }

  get count(): number {
    return this.seq;
  }

  /** Append one record and return it, already hashed. */
  write(kind: Receipt["kind"], seat: Seat | "floor", body: Record<string, unknown>): Receipt {
    const draft = { seq: this.seq++, ts: Date.now(), kind, seat, body, prev: this.prev };
    const receipt: Receipt = { ...draft, hash: digest(draft) };
    this.prev = receipt.hash;
    appendFileSync(this.path, JSON.stringify(receipt) + "\n", "utf8");
    if (this.keepInMemory) this.memory.push(receipt);
    return receipt;
  }

  /** Everything written this session, for the floorview and the close summary. */
  all(): readonly Receipt[] {
    return this.memory;
  }

  since(seq: number): Receipt[] {
    return this.memory.filter((r) => r.seq >= seq);
  }
}

export interface VerifyResult {
  ok: boolean;
  lines: number;
  head: string;
  /** Set when the chain breaks: the sequence number of the first bad record. */
  brokeAt?: number;
  reason?: string;
}

/** Walk a receipt file and check every link. */
export function verify(path: string): VerifyResult {
  if (!existsSync(path)) return { ok: false, lines: 0, head: GENESIS, reason: `${path} not found` };

  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  let prev = GENESIS;
  let expectedSeq = 0;

  for (const line of lines) {
    let r: Receipt;
    try {
      r = JSON.parse(line) as Receipt;
    } catch {
      return { ok: false, lines: lines.length, head: prev, brokeAt: expectedSeq, reason: "line is not JSON" };
    }

    if (r.seq !== expectedSeq) {
      return {
        ok: false,
        lines: lines.length,
        head: prev,
        brokeAt: r.seq,
        reason: `sequence jumped: expected ${expectedSeq}, found ${r.seq}`,
      };
    }
    if (r.prev !== prev) {
      return {
        ok: false,
        lines: lines.length,
        head: prev,
        brokeAt: r.seq,
        reason: `prev hash does not match the previous record`,
      };
    }
    const recomputed = digest({ seq: r.seq, ts: r.ts, kind: r.kind, seat: r.seat, body: r.body, prev: r.prev });
    if (recomputed !== r.hash) {
      return {
        ok: false,
        lines: lines.length,
        head: prev,
        brokeAt: r.seq,
        reason: `hash does not match the record's own contents`,
      };
    }

    prev = r.hash;
    expectedSeq++;
  }

  return { ok: true, lines: lines.length, head: prev };
}

/** Read a session's receipts back, for `replay` and the overnight scorer. */
export function read(path: string): Receipt[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Receipt);
}
