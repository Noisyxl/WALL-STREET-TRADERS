# Receipts

The claim this repository makes is not that the floor is profitable. It is that **every number the floor
prints can be traced to the thing that produced it.**

That claim is only worth something if the trail cannot be quietly edited afterwards, so the trail is a hash
chain. One file per session, one JSON object per line, append only:

```
data/receipts/2026-09-05-670e.jsonl
```

```
hash_n = sha256( seq | ts | kind | seat | body | hash_{n-1} )
```

## Verifying one

```
outcry receipts --verify
```

```
  data/receipts/2026-09-05-670e.jsonl
   INTACT  192 records · head 7c52f3ec186056fb9d1c...
  this is tamper-evident, not tamper-proof: a whole file can be rewritten and rehashed. It catches an edited line.
```

That last line is the honest limit and it is printed every time, not buried here. Anyone holding the file can
rewrite it end to end and recompute every hash. What the chain defends against is a **single edited line** —
someone improving one fill after a bad session — and it gives a session one short string you can publish
before anyone asks to see the detail.

Four ways to break it, all tested in `test/receipts.test.ts`:

| What was done | What `--verify` says |
|---|---|
| a field changed in one record | `hash does not match the record's own contents`, at that seq |
| a record deleted | `sequence jumped: expected 2, found 3` |
| a record changed **and** rehashed | `prev hash does not match the previous record`, at the *next* seq |
| the file truncated mid-line | `line is not JSON` |

## The record kinds

| `kind` | `seat` | What is in `body` |
|---|---|---|
| `session.open` | floor | config, limits, models, universe, **seed**, starting equity |
| `tape.read` | tape | ranked calls, the board line, the model, round-trip ms |
| `ticket.written` | the desk | the whole ticket, the model, ms, `degraded` if the seat fell back |
| `gate.verdict` | risk | the verdict: pass, allowed, **every reason in the order it fired**, the review |
| `order.working` | exec | the plan: style, depth, participation, limit |
| `order.fill` | exec | one child order: price, size, **level** |
| `order.done` | exec | the whole execution, `savedBps`, realised P&L |
| `position.change` | clerk | the position book, session P&L, equity |
| `risk.halt` | risk / clerk | why the floor stopped |
| `session.close` | comms | the figures, the summary, per-seat call counts and token usage |
| `overnight.score` | scribe | every thesis graded, and the one line carried to tomorrow |

## Reading them back

```
outcry receipts --tail 20                    # the last 20 records of the newest session
outcry receipts 2026-09-05-670e --kind gate.verdict
outcry positions                             # the book rebuilt from fill receipts alone
outcry replay 2026-09-05-670e                # re-derive the close and diff it against what was written
```

`replay` is the one that matters. It verifies the chain, then rebuilds cash and every position from the
`order.done` records alone and compares the result with what `session.close` claims. Two independent paths to
the same number, days later, from a file.

## Why `degraded` is on the record

When a seat's model is unreachable, times out, or answers something that does not satisfy its schema, the
seat runs its offline rule and the receipt carries `degraded` with the reason and `provider: "stub"` where it
applies.

This is not error reporting. It is the difference between "the risk seat cleared this" and "the risk seat was
down and a twelve-line rule cleared this", and a session where half the seats were degraded should not be
read as a session where twelve models agreed. There is no way to tell from the P&L. There is from the file.

## What a receipt does not contain

- **No API keys, ever.** `.env` is git-ignored and nothing reads it into a body.
- **No raw model output.** Only the parsed result, the model name and the timing. A full transcript would be
  more useful and would also make the file a place where a prompt-injected string lives forever; the parsed
  shape is bounded by the schema.
- **Nothing from outside the process.** A receipt is written by the floor about the floor.
