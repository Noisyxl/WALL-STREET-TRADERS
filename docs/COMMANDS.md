# Commands

Every command runs with no API key. `open` and `floor` will use models when keys are present and their own
offline rules when they are not; everything else never touches a model at all.

---

## `outcry doctor [--probe]`

What the floor believes, before it opens: resolved config, the limits in currency as well as percent, which
model sits in which chair and whether it has a key, and a live check of the feed — performed by *using* it
rather than by asking it.

`--probe` calls every distinct model once and prints the round trip. Skipped for chairs with no key.

Exit code 1 if the feed cannot start.

---

## `outcry roster`

The twelve seats: title, cadence, bound model, what each does, and what each structurally cannot do.

---

## `outcry open [options]`

Run a session, bell to bell.

| Flag | Default | |
|---|---|---|
| `--minutes <n>` | `FLOOR_SESSION_MIN` (390) | market minutes |
| `--seed <n>` | `TAPE_SEED` (1792) | the same seed is the same session |
| `--equity <n>` | `FLOOR_EQUITY` | starting paper equity |
| `--signal-every <n>` | 5 | market minutes between desk signals |
| `--score` | off | run the overnight scribe after the close |
| `-q, --quiet` | | one line per session |
| `-v, --loud` | | every seat's chatter, including the ones that decided nothing |

`ctrl-c` stops at the next tick and still writes a close.

---

## `outcry floor [options]`

The same engine behind a page on `127.0.0.1`. Read-only; see [SAFETY.md](./SAFETY.md#the-floorview).

| Flag | Default | |
|---|---|---|
| `--port <n>` | `VIEW_PORT` (1792) | loopback only |
| `--minutes <n>` | `FLOOR_SESSION_MIN` | |
| `--seed <n>` | `TAPE_SEED` | |
| `--signal-every <n>` | 5 | |

Routes: `/` the page, `/state` the current state as JSON, `/roster` per-seat models and call counts,
`/events` server-sent events. The page stays up after the close; `ctrl-c` to stop.

---

## `outcry tape [--for <n>]`

Watch the board and the measured events. No desks, no gate, no orders — just what `readTape` produces before
any model is asked anything. Default 20 minutes.

---

## `outcry book <symbol> [options]`

The ladder, and what one order costs worked against swept.

| Flag | Default | |
|---|---|---|
| `--size <n>` | 1000 | shares to price |
| `--side <buy\|sell>` | `buy` | |
| `--minute <n>` | 0 | advance the feed this many minutes first |
| `--replenish <pct>` | `EXEC_REPLENISH` (60) | **0 removes the assumption behind every execution claim** |

Prints both styles, the difference in basis points, the assumption in force, and one row per level with the
number of child orders it took.

---

## `outcry gate --symbol <s> --side <side> --notional <n> [options]`

Push a hypothetical ticket through the hard limits and print every rule that fired, in order. No model, no
session, no files written.

| Flag | Default | |
|---|---|---|
| `--equity <n>` | `FLOOR_EQUITY` | equity to test against |
| `--gross <n>` | 0 | gross already on |
| `--net <n>` | 0 | net already on |
| `--names <n>` | 0 | names already open |
| `--pnl <n>` | 0 | session P&L so far |

The fastest way to see what the limits actually do:

```
outcry gate --symbol NVDA --side buy --notional 40000 --gross 180000 --names 5
```

---

## `outcry receipts [session] [options]`

| Flag | |
|---|---|
| `--verify` | walk the hash chain and report the first line that does not match; exit 1 if broken |
| `--tail <n>` | print the last n records (default 20) |
| `--kind <kind>` | only this record kind |

With no session id, the most recently modified file in `data/receipts/`.

---

## `outcry positions [session]`

What a session ended holding, **rebuilt from its fill receipts alone** rather than read from any saved
position file, plus the close summary.

---

## `outcry replay <session>`

Verify the chain, then re-derive cash and every position from the `order.done` records and diff the result
against what `session.close` claims. Two independent paths to the same number.

---

# Environment

Everything has a default that works with nothing set. `outcry doctor` prints the resolved values.

## Models

| | Default | |
|---|---|---|
| `XAI_API_KEY` | — | absent → every xAI-routed seat runs its offline rule |
| `XAI_BASE_URL` | `https://api.x.ai/v1` | any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | absent → every Anthropic-routed seat runs its offline rule |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | |
| `MODEL_TAPE` | `grok-4.1-fast` | runs on every tick; the floor waits for it |
| `MODEL_DESK` | `claude-sonnet-4-5` | all four desks |
| `MODEL_GATE` | `claude-opus-4-5` | the risk seat |
| `MODEL_FLOOR` | `grok-4.1` | chief, pm, exec, comms |
| `MODEL_OVERNIGHT` | `claude-haiku-4-5` | the scribe |

A model name routes itself: anything starting `claude` takes the Anthropic wire format, everything else the
OpenAI chat-completions one.

## The floor

| | Default | |
|---|---|---|
| `FLOOR_MODE` | `paper` | `paper` \| `replay`. There is no live mode |
| `FLOOR_EQUITY` | 250000 | starting paper equity |
| `FLOOR_UNIVERSE` | `NVDA,TSM,MU,AVGO,META` | |
| `FLOOR_SESSION_MIN` | 390 | a full US session |
| `FLOOR_TICK_MS` | 1000 | |

## Risk — [RISK.md](./RISK.md)

| | Default | |
|---|---|---|
| `RISK_MAX_TICKET_PCT` | 4 | one ticket, % of equity |
| `RISK_MAX_POSITION_PCT` | 12 | one name |
| `RISK_MAX_GROSS_PCT` | 90 | |
| `RISK_MAX_NET_PCT` | 60 | |
| `RISK_MAX_NAMES` | 8 | open names at once |
| `RISK_DAY_STOP_PCT` | 3 | halts the floor for the session |
| `RISK_QUEUE_DEPTH` | 6 | tickets allowed to wait |

## Execution — [EXECUTION.md](./EXECUTION.md)

| | Default | |
|---|---|---|
| `EXEC_STYLE` | `work` | `work` \| `sweep` |
| `EXEC_MAX_LEVELS` | 5 | |
| `EXEC_PARTICIPATION` | 8 | % of a level one child may take |
| `EXEC_MIN_CHILD` | 1 | shares |
| `EXEC_REPLENISH` | 60 | the assumption; 0 removes it |

## Tape

| | Default | |
|---|---|---|
| `TAPE_SOURCE` | `synthetic` | `synthetic` \| `csv` |
| `TAPE_CSV_DIR` | `./data/bars` | one `<SYMBOL>.csv` per name: `ts,open,high,low,close,volume` |
| `TAPE_SEED` | 1792 | the same seed is the same session |

## Floorview and data

| | Default | |
|---|---|---|
| `VIEW_PORT` | 1792 | binds 127.0.0.1 only |
| `DATA_DIR` | `./data` | receipts and summaries |
