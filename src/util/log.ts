import { brass, muted, pad, red } from "./fmt.js";
import type { Seat } from "../types.js";

/**
 * One line per thing that happened, prefixed by the seat that did it.
 * The floor is twelve agents talking at once; without the seat column the
 * transcript is unreadable.
 */

const WIDTH = 7;

export type Level = "quiet" | "normal" | "loud";

let level: Level = "normal";
export const setLogLevel = (l: Level): void => {
  level = l;
};

const stamp = (): string => new Date().toISOString().slice(11, 19);

function emit(seat: Seat | "floor", body: string): void {
  if (level === "quiet") return;
  process.stdout.write(`${muted(stamp())} ${brass(pad(seat, WIDTH))} ${body}\n`);
}

export const say = (seat: Seat | "floor", body: string): void => emit(seat, body);

export const chatter = (seat: Seat | "floor", body: string): void => {
  if (level !== "loud") return;
  emit(seat, muted(body));
};

export const warn = (seat: Seat | "floor", body: string): void =>
  emit(seat, red(body));

export const blank = (): void => {
  if (level !== "quiet") process.stdout.write("\n");
};
