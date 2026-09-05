# The twelve seats

A bank splits this work across four departments and a compliance function. The split is the design, not the
headcount: each seat sees a different slice of the same state, and **no seat can do another seat's job.**
That is enforced in `src/floor/floor.ts`, not requested in a prompt.

`outcry roster` prints this table with the model currently bound to each chair.

| Seat | Chair | Runs | Does | Cannot |
|---|---|---|---|---|
| `chief` | floor | every 30 min | sets the session posture every desk reads | write a ticket, overrule the gate |
| `tape` | tape | every tick | ranks what changed, hands the desks a short list | have an opinion about direction |
| `quant` | desk | every signal | mean reversion and dispersion inside the universe | size its own ticket |
| `macro` | desk | every signal | rates, dollar and volatility against the board | size its own ticket |
| `credit` | desk | every signal | funding stress read through the equity tape | size its own ticket |
| `digital` | desk | every signal | flow, positioning, momentum breaks | size its own ticket |
| `risk` | gate | every ticket | reviews what the hard limits let through | **raise a limit, ever** |
| `pm` | floor | every ticket | turns a cleared notional into a size against the book | clear a ticket the gate refused |
| `exec` | floor | every ticket | picks style and limit, works the order | change the side, name or size |
| `clerk` | — | every fill | reconciles fills against positions | use a model at all |
| `comms` | floor | at the close | writes what was done and what it cost | see anything not already in a receipt |
| `scribe` | overnight | after the close | grades yesterday's theses against the tape | change a position or write a ticket |

## Why five chairs and not twelve models

Seats are bound to models by **role**, not by name:

```
MODEL_TAPE=grok-4.1-fast        # runs on every tick; the floor waits for it
MODEL_DESK=claude-sonnet-4-5    # four of these, in parallel
MODEL_GATE=claude-opus-4-5      # the strongest model, with the least authority
MODEL_FLOOR=grok-4.1            # chief, pm, exec, comms
MODEL_OVERNIGHT=claude-haiku-4-5 # the scribe: cheap, slow, patient
```

Moving the whole floor onto one model is five lines in `.env` and changes nothing else. That is the point of
the abstraction, and it is also the honest test: **if a floor of one model performs the same as a floor of
five, the arrangement is doing the work, not the model shopping.** Run it both ways with the same seed and
compare the receipts.

## Why the strongest model has the least power

The risk seat sits on the largest model available and can only ever make a number smaller. Everything it
might get wrong is bounded above by `src/risk/limits.ts`, which is arithmetic and has no opinions.

This is the opposite of the usual arrangement, where the best model is given the most authority. The reason
is simple: the failure that costs money is not a mediocre decision, it is an unbounded one. A weaker model
inside a hard bound is safer than a stronger model outside it, and the gate is the only place on this floor
where "safer" is the whole objective.

## Why the clerk has no model

The clerk's job is to catch the floor lying to itself. It rebuilds the position book from the fill receipts
alone and compares it, name by name, with what the ledger believes; it rebuilds cash from the executions and
compares it to the cent. Two independent paths to the same number.

A seat whose job is to detect a discrepancy cannot be the kind of thing that can be talked into an answer.
So the clerk is `reconcile()` and `reconcileCash()` in `src/agents/seats/clerk.ts`, it has no prompt file,
and `test/agents.test.ts` asserts that `loadPrompt("clerk")` throws.

A break is not a warning. It halts the floor. A floor that cannot reconcile its own fills has nothing left
worth protecting.

## What a seat is, mechanically

Every seat is the same three things — a prompt file, a model, and a schema its answer has to satisfy:

```ts
new Agent<In, Out>({
  seat: "quant",
  model,
  provider,          // xai | anthropic | stub
  brief:   (state) => string,   // the floor's state → the user turn
  parse:   (text)  => Out | null,  // null means "this did not satisfy the schema"
  fallback:(state) => Out,      // what the seat does when parse fails or the model is unreachable
})
```

Three consequences worth stating out loud:

1. **A seat returns data. It never acts.** No seat can write to the ledger, call another seat, or reach the
   network for anything but its own model.
2. **An answer that does not parse is not used.** `extractJson` finds the first balanced object even inside
   prose or fences, and a schema violation falls back — it never half-uses a malformed answer.
3. **Every seat has an offline rule.** With no key set, every seat runs its fallback, the floor completes a
   full session, and every receipt carries `provider: "stub"` so nobody mistakes the run for a model's
   judgement. That is why `npm test` needs no network, and why someone with no API budget can still read,
   run and reason about the whole thing.

## The offline rules

They are deliberately simple, they are not strategies, and they are not claimed to be. They exist so the
wiring can be exercised end to end.

| Seat | Offline rule |
|---|---|
| `tape` | rank by the weight the arithmetic in `readTape` already produced |
| `quant` | fade the widest laggard when dispersion clears 0.8% |
| `macro` | trim the strongest name when VIX is at or above 16 |
| `credit` | sell the weakest name when breadth is at or below 40% |
| `digital` | stay with the strongest name once it clears 0.6% on the session |
| `risk` | trim to half when the horizon runs past the close; trim to 60% on a third ticket the same way |
| `pm` | never take more than a fifth of the depth showing in five levels |
| `exec` | work, unless the horizon is under 15 minutes and the spread is under 3 bps |
| `chief` | defensive above VIX 18, constructive under 13 with breadth over 60 |
| `comms` | the figures, in order, with no adjectives |
| `scribe` | the arithmetic alone: signed move over the horizon against a 0.15% threshold |

Note what the four desks do **not** do offline: agree. They read the same board and reach different
conclusions, which is the only property of the arrangement that a stub can honestly demonstrate.
