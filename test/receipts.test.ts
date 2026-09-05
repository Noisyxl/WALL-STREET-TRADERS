import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptBook, verify, read, digest } from "../src/ledger/receipts.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "outcry-"));

test("a fresh book chains from genesis and every link matches", () => {
  const dir = scratch();
  const b = new ReceiptBook(dir, "s1");
  b.write("session.open", "floor", { equity: 1 });
  b.write("ticket.written", "quant", { id: "Q-0001" });
  b.write("session.close", "comms", { equity: 2 });

  const v = verify(b.file);
  assert.equal(v.ok, true);
  assert.equal(v.lines, 3);
  assert.equal(v.head, b.head);
});

test("editing one field in one line breaks the chain at that line", () => {
  const dir = scratch();
  const b = new ReceiptBook(dir, "s2");
  b.write("session.open", "floor", { equity: 100 });
  b.write("order.fill", "exec", { price: 10, size: 5 });
  b.write("session.close", "comms", { equity: 150 });

  const lines = readFileSync(b.file, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]!);
  tampered.body.price = 9; // a quiet improvement to one fill
  lines[1] = JSON.stringify(tampered);
  writeFileSync(b.file, lines.join("\n") + "\n");

  const v = verify(b.file);
  assert.equal(v.ok, false);
  assert.equal(v.brokeAt, 1);
  assert.match(v.reason ?? "", /hash does not match/);
});

test("deleting a line breaks the sequence", () => {
  const dir = scratch();
  const b = new ReceiptBook(dir, "s3");
  b.write("session.open", "floor", {});
  b.write("order.fill", "exec", { n: 1 });
  b.write("order.fill", "exec", { n: 2 });

  const lines = readFileSync(b.file, "utf8").trim().split("\n");
  writeFileSync(b.file, [lines[0], lines[2]].join("\n") + "\n");

  const v = verify(b.file);
  assert.equal(v.ok, false);
  assert.equal(v.brokeAt, 2);
  assert.match(v.reason ?? "", /sequence jumped/);
});

test("re-hashing a rewritten line is still caught by the link to the next one", () => {
  const dir = scratch();
  const b = new ReceiptBook(dir, "s4");
  b.write("session.open", "floor", {});
  b.write("order.fill", "exec", { price: 10 });
  b.write("order.fill", "exec", { price: 11 });

  const lines = readFileSync(b.file, "utf8").trim().split("\n");
  const r = JSON.parse(lines[1]!);
  r.body.price = 9;
  r.hash = digest({ seq: r.seq, ts: r.ts, kind: r.kind, seat: r.seat, body: r.body, prev: r.prev });
  lines[1] = JSON.stringify(r);
  writeFileSync(b.file, lines.join("\n") + "\n");

  const v = verify(b.file);
  assert.equal(v.ok, false, "record 2 still points at the old hash");
  assert.equal(v.brokeAt, 2);
  assert.match(v.reason ?? "", /prev hash/);
});

test("records read back in order with their bodies intact", () => {
  const dir = scratch();
  const b = new ReceiptBook(dir, "s5");
  b.write("ticket.written", "macro", { thesis: "VIX at 19.4 with breadth 38%" });
  const all = read(b.file);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.seat, "macro");
  assert.equal((all[0]!.body as { thesis: string }).thesis, "VIX at 19.4 with breadth 38%");
});

test("a missing file is reported, not thrown", () => {
  const v = verify(join(scratch(), "nothing.jsonl"));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /not found/);
});
