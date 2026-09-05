# The gate

Every ticket written on this floor passes through `src/risk/gate.ts`. There is no bypass, no urgent path,
and no flag that turns it off. `outcry open --no-gate` does not exist, and the test that would catch someone
adding it is called `the gate cannot be bypassed` — it reads `floor.ts` and asserts there is exactly one call
to `gate.decide` and exactly one call to `ledger.apply` in the whole file.

## The order, which is the whole design

```
1. hard limits, in code, deterministic     →  an allowed notional
2. a model review of what got through      →  advisory only
3. the intersection                        →  the verdict
```

Step 2 can shrink the number from step 1 or refuse outright. **It can never raise it.**

If the reviewer times out, throws, returns nothing, or returns something that does not parse, the hard result
stands and the reason line says so. A floor whose risk control depends on a model answering is not risk
control.

```ts
// src/risk/gate.ts — applyReview
if (typeof asked === "number" && asked > v.allowed) {
  v.reasons.push(`review ignored · risk seat asked for $${asked}, above the hard allowance; a review can only tighten`);
  return v;
}
```

That is the invariant. Read it once and you can stop worrying about what any prompt in this repository says.

## The hard limits

`src/risk/limits.ts`. Every rule answers with a number, not a judgement, and every rule that fires ends up in
the verdict's `reasons`, in the order it was checked. `outcry gate --symbol NVDA --side buy --notional 40000`
runs them against a hypothetical and prints the lot.

| Rule | Env | Default | Refuses or trims |
|---|---|---|---|
| day stop | `RISK_DAY_STOP_PCT` | 3% of equity | **refuses, and halts the floor for the session** |
| gate queue | `RISK_QUEUE_DEPTH` | 6 tickets | refuses |
| per ticket | `RISK_MAX_TICKET_PCT` | 4% of equity | trims |
| per name | `RISK_MAX_POSITION_PCT` | 12% of equity | trims to the room left, refuses at none |
| name count | `RISK_MAX_NAMES` | 8 open | refuses a *new* name only |
| gross | `RISK_MAX_GROSS_PCT` | 90% of equity | trims |
| net | `RISK_MAX_NET_PCT` | 60% of equity | trims |

**Trimming is preferred to refusing.** A trim keeps the desk's information in the book at a size the floor can
survive; a refusal throws it away. A ticket that asks for 6% when the cap is 4% comes back cleared for 4%,
with the trim named. A desk whose tickets are always trimmed is a desk asking for too much, and the close
summary counts it.

Three details that are easy to get wrong and are therefore tested:

- **A ticket that reduces a position is not measured against the name cap.** Otherwise a full position could
  never be closed.
- **Only a *new* name is refused by the name count.** Adding to something already open does not need a slot.
- **The day stop is checked first.** Once it fires nothing else matters, and the halt is permanent for the
  session — set from inside `decide`, so there is one place to read.

## What the risk seat is actually for

Limits are blind to everything that is not a number about the current book. The seat exists for the rest:

- **Correlation the caps priced but did not judge.** Four tickets, four names, four desks, one trade. Each is
  inside every cap. Together they are a single position with four ways to be wrong at once.
- **Horizon against the clock.** A 90-minute thesis with 40 minutes left will be flat before it can be right.
  That is not a risk limit, it is arithmetic nobody ran.
- **Adding to a name the floor was already wrong about.** The caps see exposure. They do not see that this
  desk wrote the opposite ticket ninety minutes ago.
- **A thesis that does not say what it is.** If nobody can tell what would make it wrong, nobody can size it
  and the scribe cannot grade it tonight.

What it is explicitly **not** for: having a better view than the desk. "I don't think NVDA goes up" is not a
reason to refuse anything, and a refusal on those grounds is the one failure mode that makes this seat worse
than no seat at all. The prompt says so in those words.

## VaR

`src/risk/var.ts` computes a one-day 95% parametric VaR with a flat correlation, and the file opens by saying
what that is worth:

> VaR here is not a forecast. It is a single number that says how the current book is arranged: how big it
> is, how correlated it is, and how volatile its names are. It is used for one thing — comparing the book
> against itself, hour to hour, inside one session.

It assumes returns are normal, correlations are the constant given, and past volatility continues. All three
assumptions fail exactly when it would matter most. The floorview labels the panel `VaR 95` and this
paragraph is why it is not labelled anything stronger.

The one property worth having is that the per-name contributions add to the total, so the panel can say
*which* name is carrying the risk rather than only how much there is. That is asserted in `test/gate.test.ts`.

## The halt

Two things halt the floor, both permanently for the session:

1. **The day stop.** Session loss reaches `RISK_DAY_STOP_PCT`. Every subsequent ticket is refused with
   `refusedBy: "halt"`.
2. **A reconciliation break.** The clerk found the ledger and the receipts disagreeing. See
   [SEATS.md](./SEATS.md#why-the-clerk-has-no-model).

Both write a `risk.halt` receipt with the reason, so a halted session explains itself when read back weeks
later.
