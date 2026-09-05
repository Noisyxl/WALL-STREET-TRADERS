import { brass, muted } from "./fmt.js";

/**
 * The header. Twelve seats drawn as twelve marks, because the arrangement is
 * the product and the arrangement should be the first thing on the screen.
 */
export function banner(): string {
  const floor = [
    "  ┌─────────────────────────────────────────────────────────────┐",
    "  │  ▚ ▚ ▚ ▚    tape   quant   macro   credit   digital         │",
    "  │  ▚ ▚ ▚ ▚         ↓      ↓       ↓        ↓        ↓         │",
    "  │  ▚ ▚ ▚ ▚              → → →  the gate  → → →                │",
    "  │  ▚ ▚ ▚ ▚                        ↓                           │",
    "  │  ▚ ▚ ▚ ▚              pm  →  exec  →  clerk                 │",
    "  └─────────────────────────────────────────────────────────────┘",
  ];
  return [
    "",
    `  ${brass("outcry")}  ${muted("twelve seats · four desks · one gate · paper by default")}`,
    "",
    ...floor.map((l) => muted(l)),
    "",
  ].join("\n");
}
