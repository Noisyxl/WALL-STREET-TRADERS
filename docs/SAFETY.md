# Safety

## There is no live mode

`FLOOR_MODE` accepts `paper` and `replay`. It does not accept `live`, there is no `--live` flag, and **no
broker adapter ships in this repository.** The order type at the boundary is an interface with two
implementations, both of which walk a book in memory.

This is a deliberate choice, not an unfinished one.

A multi-agent floor is an interesting thing to build and read. It is not, on this evidence, a thing anyone
should point at a brokerage account, and shipping the last thirty lines would convert "interesting" into
"one config change from real money" for every person who clones it — including the ones who will not read
this file. The parts that would need to be true first are listed below, and none of them are true yet.

If you write that adapter yourself: it is your code, your account and your money, and nothing in this
repository has been tested against a venue.

## What the simulator does not model

Every item here makes real trading **worse** than what this repository prints. The numbers are an upper
bound, not an estimate.

| Missing | Why it matters |
|---|---|
| market impact beyond the visible ladder | taking size moves the mid. Here it does not |
| adverse selection | the book does not thin out *because* you are buying, which is the main thing that happens when you are buying |
| queue position | working always takes liquidity and never posts, so the real advantage of patience — earning the spread — is absent |
| other participants | nobody reacts to the order, ever |
| latency | a decision is applied at the price that produced it |
| news, earnings, halts, auctions | the synthetic feed is a random walk with a volume curve; it has no events |
| borrow, financing, dividends, corporate actions | shorts are free and infinite here. They are neither |
| slippage between the mark and a real exit | marks are book quotes, not fills |
| fees beyond a flat 1 bp | no commissions, no exchange fees, no regulatory fees, no spread crossing at the venue level |

The replenishment assumption behind every execution number is a single parameter, `EXEC_REPLENISH`, and
[EXECUTION.md](./EXECUTION.md) prints the same order priced with it removed.

## What this repository does not claim

- It does not claim a return. There is no backtest in here, no equity curve, no Sharpe ratio and no
  performance figure anywhere in the README, because a number produced by the model above would not mean
  anything.
- It does not claim the arrangement makes better decisions than one model would. It makes decisions that can
  be **read**: which desk, on what reading, cleared by which rule, filled at which levels. Whether that is
  also more profitable is an open question and this repository does not answer it. `MODEL_DESK`,
  `MODEL_GATE` and the rest exist partly so you can run one model in every chair and find out.
- It does not claim the offline rules in `src/agents/seats/` are strategies. They are twelve-line placeholders
  that let the wiring run without a key.

**Nothing here is investment advice, and nothing here is a recommendation about any security.** The names in
`FLOOR_UNIVERSE` are there because they are liquid and well known, not because anyone thinks anything about
them.

## Keys and what leaves your machine

- The only secrets are `XAI_API_KEY` and `ANTHROPIC_API_KEY` in your own `.env`. `.env` is git-ignored.
- Keys are read once in `src/config.ts` and used only in the `authorization` / `x-api-key` header of a call
  to the base URL you configured. They are never printed, never logged and never written into a receipt.
- With no keys set, **nothing leaves your machine at all.** The floor runs a full session offline and the
  test suite has no network access by design.
- With keys set, what leaves is the brief each seat is given: the board, the book, positions, the tickets and
  the limits. That is market data and your own configuration. If any of that is sensitive to you, run offline
  — the whole loop works.
- `data/` holds receipts, positions and summaries. No keys. Delete it freely.

## The floorview

- Binds `127.0.0.1` and nothing else.
- **Every route is a GET.** There is no route that mutates anything — no arm button, no order form, no
  parameter change. A page that could arm a floor would be a page worth attacking; this one is a window.
- Anyone on your machine can open it. Nobody outside can. If several people share the machine, start it on a
  different `--port` and assume they can read it.

## Prompt injection

The seats read market data and each other's structured output, both generated inside this process. There is
no path today by which text from outside reaches a prompt.

If you add one — a news feed, a filings scraper, a social sentiment source — assume every string it returns
is an instruction aimed at your risk seat, because eventually one will be. Two things in the current design
are the reason that would be survivable, and both should stay:

1. **A model can only tighten the gate.** An injected string that talks the risk seat into clearing more gets
   `review ignored` and a line in the receipt.
2. **Every seat's answer is parsed against a schema, and a failure falls back.** A seat cannot return an
   action, only data of a fixed shape.

Neither of those is a defence against a well-aimed injection reaching a *desk* and producing a plausible
ticket. The hard limits are what bound that, and they are the reason they run first.

## If you extend this

The four properties worth keeping, in the order that matters:

1. The hard limits run in code, before any model, and a model can only ever tighten them.
2. Only the four desks originate a ticket, and no seat can act — every seat returns data.
3. The clerk reconciles from an independent path and a break halts the floor.
4. Everything that happened is on disk, hash-chained, with the seat and the model that did it.

`test/gate.test.ts` and `test/floor.test.ts` check the first three by reading the source, not by trusting a
convention. If you change the design, change those tests deliberately rather than deleting them.
