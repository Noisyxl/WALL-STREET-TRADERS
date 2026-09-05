# Execution

`src/book/walk.ts`. No model is involved in the arithmetic here, and it is tested line by line.

## The two styles

**sweep** is one instruction: take every level at once, at whatever it costs. The price you get is the last
level you reached, not the one you saw.

**work** is a sequence of child orders. Each takes its share of what is displayed at the best level
available, and the level gives some of it back before the next child arrives. The order steps to a worse
price only when the level in front of it is genuinely used up, and stops entirely at its limit.

```
outcry book MU --size 1200 --minute 60
```

```
  buy 1,200
  work     612 filled @ 126.8496  +0.8 bps  (588 shares left after 5 levels at 8% participation)
  sweep    310 filled @ 126.8549  +1.2 bps
  saved    0.4 bps by working it

  the ladder, one row per level, with the child orders it took:
  level 0  126.84 ×     314   34 child orders
  level 1  126.85 ×     111   29 child orders
  level 2  126.86 ×     108   28 child orders
  level 3  126.87 ×      57   29 child orders
  level 4  126.88 ×      22   22 child orders
```

Every `order.done` receipt carries `savedBps` for that order, and the close summary averages it. **If that
number is not positive across a session, the execution seat is costing the floor money and comms says so.**

## The assumption, stated out loud

Working an order beats sweeping it *only* because the book comes back between child orders. That assumption
is the entire advantage this seat claims, so it is a parameter and not a constant:

```
EXEC_REPLENISH=60   # % of a lifted level that returns before the next child order
```

- A book that **never** refreshes makes working pointless: you climb the same ladder as a sweep, one rung at
  a time, for the same average price. `test/walk.test.ts` asserts exactly this at `replenishPct: 0`.
- A book that **fully** refreshes makes it free, which is a fantasy.
- The default of 60 says a level gives back roughly three fifths of what was lifted. That is the behaviour of
  a liquid name in normal conditions and it is optimistic in a fast one.

Every claim this repository makes about execution can be re-measured with the assumption removed:

```
outcry book NVDA --size 900 --minute 40 --replenish 0
```

```
  work     604 filled @ 188.1825  +0.7 bps  (296 shares left after 5 levels at 8% participation)
  sweep    670 filled @ 188.1870  +0.9 bps
  saved    0.2 bps by working it
```

Same book, same order, the advantage down from 0.7 bps to 0.2 and the fill 66 shares short. That is the
honest range, and it is one flag away in either direction.

## The knobs

| Env | Default | What it does |
|---|---|---|
| `EXEC_STYLE` | `work` | the default the exec seat starts from |
| `EXEC_MAX_LEVELS` | 5 | how deep one order may reach |
| `EXEC_PARTICIPATION` | 8 | percent of a level's displayed size one child order may take |
| `EXEC_MIN_CHILD` | 1 | smallest child worth sending, in shares |
| `EXEC_REPLENISH` | 60 | the assumption above |

A high replenish rate cannot loop forever: a hard ceiling of 400 child orders per parent stops it and says so
in `unfilledReason`. That is a test, not a comment.

## What the exec seat may and may not choose

It chooses **style, depth and limit**. It is handed side, name and size already settled, and
`test/floor.test.ts` checks every `order.done` in a session against the `order.working` that preceded it to
confirm none of the three changed.

The limit is where the order **stops**, not where it hopes to trade — usually two levels out from the touch.
A limit that is never reached did nothing; a limit at the touch means no fill at all.

## What is not modelled

Stated plainly, because an execution simulator that does not say this is selling something:

- **No market impact beyond the ladder.** Taking size does not move the mid in this model. Real size does.
- **No adverse selection.** The book does not thin out *because* you are buying, which is the main thing that
  happens when you are buying.
- **No queue position.** Working here always takes liquidity; it never posts and waits, so a passive
  strategy's real advantage — earning the spread — is not represented at all.
- **No other participants.** Nobody reacts to the order.
- **No latency, no partial-day halts, no auctions, no borrow.**

Every one of those makes real execution worse than this model, not better. The numbers this repository prints
are therefore an **upper bound** on how well an order would have done, and should be read as one.
