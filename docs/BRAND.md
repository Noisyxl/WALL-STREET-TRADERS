# Brand

Tokens: [`design-tokens.json`](./design-tokens.json). Everything below explains why they are what they are.

## The name

**Open outcry** is how a floor traded before screens: you announced your order out loud, in a pit, and
everyone heard it. It was slow, it was chaotic, and it had one property no electronic venue has ever
matched — every participant could hear every intention, and nobody could claim afterwards that a price had
appeared from nowhere.

That is the whole design of this repository. Twelve agents announce what they are doing, in writing, in a
form that can be read back. A desk says what it wants and why. The gate says what it allowed and which
rule did the allowing. Execution says which levels it climbed. The clerk says whether the numbers agree.
None of it happens quietly.

One word, one image, one mechanic. Every command comes from the same world: `open`, `floor`, `tape`,
`book`, `gate`, `roster`, `positions`, `receipts`. Nothing is called `run`, `start`, `analyze` or `process`.

## The mark

Twelve blocks in a grid, eleven ink, one brass. Eleven seats do their own job; the twelfth is the gate every
ticket clears. It is the product drawn at its simplest, and it has to survive at 40 px in a list of
repositories, so there is nothing else in it.

`assets/icon.svg` is the tile. `assets/logo.svg` adds the wordmark. `assets/token.svg` is the 1000×1000
token image: the mark alone on ink, no text.

## Palette

A trading floor before screens: ledger paper, ink, and one brass fitting.

| Token | Hex | Where it is used |
|---|---|---|
| `paper` | `#EDE3CC` | every page ground and every terminal frame |
| `panel` | `#F5EDD8` | panels sitting on paper |
| `sunk` | `#E2D5B8` | section-label strips, idle seats |
| `line` | `#C2AF8E` | every hairline; there is only one border in this product |
| `ink` | `#2B2118` | names, headline numbers, the mark |
| `ink-2` | `#4A3B2C` | a thesis, secondary body |
| `muted` | `#7A6A56` | timestamps, reasons, footnotes |
| `brass` | `#C79A3C` | **decisions only** |
| `loss` | `#B4453C` | negative P&L, a refusal, a reconciliation break |
| `gain` | `#3F7A4E` | declared, almost never used |

**Brass is spent on decisions, never on moods.** A cleared verdict is brass. The live badge is brass. A seat
that is acting is brass. A profit is not — a winning position is ink on paper with no colour at all, and a
losing one is `loss` text and still no fill. The floorview has three colours on it at any moment and two of
them are the paper.

`gain` exists in the tokens and is used almost nowhere on purpose. Colouring gains green and losses red
turns a P&L column into a mood ring: a page that is mostly green feels like a good session before anyone has
read a number. The one colour that means anything here is the one that marks a decision.

## Type

One face: **JetBrains Mono**, weights 400 and 500, ceiling 500. Nothing bold.

This is a terminal product and a ledger. A proportional face would misalign every column it has, and the
floorview, the CLI and the README screenshots would stop looking like one thing. Caps are for section
labels and the wordmark only — tickers are data, not emphasis, and stay as they are written.

## Shape

- **No rounded corners.** Not on panels, not on tags, not on buttons. The one exception is the mark's tile.
- **No shadows and no gradients.** Depth is surface tone plus one hairline, the way a printed form has depth.
- **One border colour** for the whole product.
- **One polarity flip per surface:** a brass ground with `on-brass` text, on a cleared verdict, the gate box
  in the banner, and the live badge. Everything else stays ink on paper.

## Voice

Sentence case. Short declaratives. Numbers before adjectives.

The interface says what it read and what it decided. It does not promise a return, it does not describe a
session as good or difficult, and it does not congratulate anyone. `comms` is given nothing but figures from
the receipt file for exactly this reason, and its prompt forbids it from explaining *why* something happened,
because it cannot see why — and a plausible story attached to a number nobody can trace is the most
expensive thing this floor could produce.

Every claim in the README is either a measurement anyone can reproduce with the seed printed next to it, or
a stated assumption with the parameter that controls it.

## Assets

Nothing in `assets/` is drawn by hand or screenshotted from a design tool.

| File | What makes it |
|---|---|
| `icon.png`, `logo.png`, `token.png`, `banner.png` | `python assets/render.py` — the SVGs through headless Chromium at 2× |
| `roster.png`, `doctor.png`, `book.png`, `gate.png`, `session.png` | `python assets/term2png.py <capture>.txt <out>.png` — the bytes the program actually wrote, repainted in the palette |
| `floorview.png` | `python assets/shot_floor.py` against a running `outcry floor` |

So a palette change is one edit to `design-tokens.json`, one edit to the three files that mirror it, and one
command. The README never drifts away from the product.
