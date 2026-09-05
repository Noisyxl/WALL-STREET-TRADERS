#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { SyntheticFeed } from "./tape/sources/synthetic.js";
import { CsvFeed } from "./tape/sources/csv.js";
import { readTape, type Feed } from "./tape/feed.js";
import { Floor } from "./floor/floor.js";
import { ladder, spreadBps, imbalance, depth } from "./book/book.js";
import { compare } from "./book/walk.js";
import { checkHard, exposureOf } from "./risk/limits.js";
import { read as readReceipts, verify } from "./ledger/receipts.js";
import { ROSTER, modelFor } from "./agents/roster.js";
import { providerFor } from "./agents/provider.js";
import { serveFloor } from "./floorview/server.js";
import { setLogLevel, logLevel } from "./util/log.js";
import { banner } from "./util/banner.js";
import { badge, brass, bps, clock, lpad, money, muted, pad, pct, px, shares } from "./util/fmt.js";
import type { Ticket } from "./types.js";

const program = new Command();

program
  .name("outcry")
  .description(
    "A trading floor you run on your own machine: twelve seats, four desks, one gate. Paper by default.",
  )
  .version("0.1.0")
  .option("-q, --quiet", "one line per session, nothing else")
  .option("-v, --loud", "every seat's chatter, including the ones that decided nothing")
  .hook("preAction", (cmd) => {
    const o = cmd.opts();
    if (o.quiet) setLogLevel("quiet");
    else if (o.loud) setLogLevel("loud");
  });

function makeFeed(cfg: Config, overrides: { seed?: number; minutes?: number } = {}): Feed {
  const sessionMin = overrides.minutes ?? cfg.sessionMin;
  if (cfg.tape.source === "csv") {
    return new CsvFeed({
      dir: cfg.tape.csvDir,
      universe: cfg.universe,
      seed: overrides.seed ?? cfg.tape.seed,
    });
  }
  return new SyntheticFeed({
    universe: cfg.universe,
    seed: overrides.seed ?? cfg.tape.seed,
    sessionMin,
  });
}

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("what the floor believes, before it opens: config, seats, models, feed")
  .option("--probe", "call every distinct model once and report the round trip")
  .action(async (opts: { probe?: boolean }) => {
    const cfg = loadConfig();
    if (logLevel() !== "quiet") process.stdout.write(banner() + "\n");

    const rows: [string, string][] = [
      ["mode", `${cfg.mode}  ${muted("(there is no live mode; see docs/SAFETY.md)")}`],
      ["feed", `${cfg.tape.source}${cfg.tape.source === "synthetic" ? `  seed ${cfg.tape.seed}` : `  ${cfg.tape.csvDir}`}`],
      ["universe", cfg.universe.join(" ")],
      ["session", `${cfg.sessionMin} market minutes`],
      ["equity", money(cfg.equity)],
      ["data", cfg.dataDir],
    ];
    for (const [k, v] of rows) process.stdout.write(`  ${muted(pad(k, 12))} ${v}\n`);

    process.stdout.write(`\n  ${brass("limits")}\n`);
    const L = cfg.risk;
    const limits: [string, string][] = [
      ["ticket", `${L.maxTicketPct}% of equity = ${money((cfg.equity * L.maxTicketPct) / 100)}`],
      ["position", `${L.maxPositionPct}% = ${money((cfg.equity * L.maxPositionPct) / 100)} per name`],
      ["gross", `${L.maxGrossPct}% = ${money((cfg.equity * L.maxGrossPct) / 100)}`],
      ["net", `${L.maxNetPct}% = ${money((cfg.equity * L.maxNetPct) / 100)}`],
      ["names", `${L.maxNames} open at once`],
      ["day stop", `${L.dayStopPct}% = ${money((cfg.equity * L.dayStopPct) / 100)}`],
      ["queue", `${L.queueDepth} tickets may wait at the gate`],
    ];
    for (const [k, v] of limits) process.stdout.write(`  ${muted(pad(k, 12))} ${v}\n`);

    process.stdout.write(`\n  ${brass("seats")}\n`);
    for (const s of ROSTER) {
      const model = s.seat === "clerk" ? muted("no model, by design") : modelFor(s.seat, cfg);
      const key =
        s.seat === "clerk"
          ? ""
          : providerFor(model) === "anthropic"
            ? cfg.keys.anthropic
              ? badge("key")
              : muted("offline")
            : cfg.keys.xai
              ? badge("key")
              : muted("offline");
      process.stdout.write(`  ${muted(pad(s.seat, 9))} ${pad(model, 24)} ${key}\n`);
    }

    const missing = [!cfg.keys.xai && "XAI_API_KEY", !cfg.keys.anthropic && "ANTHROPIC_API_KEY"].filter(Boolean);
    if (missing.length) {
      process.stdout.write(
        `\n  ${muted(`${missing.join(" and ")} not set. Every seat without a key runs its offline rule and every receipt says so. The floor runs end to end either way.`)}\n`,
      );
    }

    // The feed is the one thing that can fail outright, so it is checked last
    // and it is checked by using it rather than by asking it.
    process.stdout.write(`\n  ${brass("feed")}\n`);
    try {
      const feed = makeFeed(cfg, { minutes: 3 });
      const first = feed.peek();
      feed.tick();
      const second = feed.peek();
      const events = readTape(first, second, {});
      const b = feed.book(cfg.universe[0]!);
      process.stdout.write(`  ${muted(pad("board", 12))} ${Object.keys(second.quotes).length} names\n`);
      process.stdout.write(`  ${muted(pad("first tick", 12))} ${events.length} measured events\n`);
      process.stdout.write(
        `  ${muted(pad("book", 12))} ${b.symbol} ${b.bids.length}x${b.asks.length} levels, spread ${spreadBps(b).toFixed(1)} bps, ${shares(depth(b, "buy", 5))} shares in five\n`,
      );
      process.stdout.write(`\n  ${badge("READY")} ${muted("outcry open")}\n`);
    } catch (err) {
      process.stdout.write(`  ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }

    if (opts.probe) {
      process.stdout.write(`\n  ${brass("probe")}\n`);
      const seen = new Set<string>();
      for (const s of ROSTER) {
        if (s.seat === "clerk") continue;
        const model = modelFor(s.seat, cfg);
        if (seen.has(model)) continue;
        seen.add(model);
        const kind = providerFor(model);
        const key = kind === "anthropic" ? cfg.keys.anthropic : cfg.keys.xai;
        if (!key) {
          process.stdout.write(`  ${pad(model, 24)} ${muted("skipped, no key")}\n`);
          continue;
        }
        const t0 = Date.now();
        try {
          const { makeProvider } = await import("./agents/provider.js");
          const p = makeProvider(model, cfg.keys, cfg.bases, () => "");
          const res = await p.complete(model, {
            system: "Answer with the single word: ready",
            user: "ready?",
            maxTokens: 8,
            deadlineMs: 15_000,
          });
          process.stdout.write(`  ${pad(model, 24)} ${badge("OK")} ${res.ms} ms\n`);
        } catch (err) {
          process.stdout.write(`  ${pad(model, 24)} ${(err as Error).message.slice(0, 90)} ${muted(`${Date.now() - t0} ms`)}\n`);
        }
      }
    }
  });

// ── roster ───────────────────────────────────────────────────────────────────

program
  .command("roster")
  .description("the twelve seats: what each one does, and what it structurally cannot")
  .action(() => {
    const cfg = loadConfig();
    process.stdout.write(`\n  ${brass("twelve seats, one human")}\n\n`);
    for (const s of ROSTER) {
      const model = s.seat === "clerk" ? "—" : modelFor(s.seat, cfg);
      process.stdout.write(`  ${brass(pad(s.seat, 9))} ${muted(pad(s.title, 20))} ${muted(pad(s.cadence, 10))} ${model}\n`);
      process.stdout.write(`  ${" ".repeat(9)} ${s.does}\n`);
      process.stdout.write(`  ${" ".repeat(9)} ${muted("cannot: " + s.cannot)}\n\n`);
    }
  });

// ── open ─────────────────────────────────────────────────────────────────────

program
  .command("open")
  .description("run a session, bell to bell")
  .option("--minutes <n>", "market minutes to run", (v) => Number(v))
  .option("--seed <n>", "synthetic feed seed; the same seed is the same session", (v) => Number(v))
  .option("--equity <n>", "starting paper equity", (v) => Number(v))
  .option("--signal-every <n>", "market minutes between desk signals", (v) => Number(v), 5)
  .option("--score", "run the overnight scribe after the close")
  .action(async (opts: { minutes?: number; seed?: number; equity?: number; signalEvery: number; score?: boolean }) => {
    const cfg = loadConfig();
    if (opts.equity) cfg.equity = opts.equity;
    if (opts.minutes) cfg.sessionMin = opts.minutes;
    if (opts.seed !== undefined) cfg.tape.seed = opts.seed;

    if (logLevel() !== "quiet") process.stdout.write(banner() + "\n");
    const feed = makeFeed(cfg, { seed: cfg.tape.seed, minutes: cfg.sessionMin });
    const floor = new Floor({ cfg, feed, signalEvery: opts.signalEvery });

    process.on("SIGINT", () => {
      process.stdout.write("\n");
      floor.stop();
    });

    await floor.run();

    if (opts.score) {
      const { carry, scores } = await floor.score();
      const paid = scores.filter((s) => s.outcome === "paid").length;
      const died = scores.filter((s) => s.outcome === "died").length;
      const open = scores.filter((s) => s.outcome === "open").length;
      process.stdout.write(`\n  ${brass("overnight")}  ${paid} paid · ${died} died · ${open} still open\n`);
      for (const s of scores) {
        process.stdout.write(
          `  ${muted(pad(s.ticketId, 14))} ${pad(s.outcome, 5)} ${lpad(pct(s.movePct), 8)}  ${muted(s.note)}\n`,
        );
      }
      process.stdout.write(`  ${brass("carry")} ${carry}\n`);
    }
  });

// ── tape ─────────────────────────────────────────────────────────────────────

program
  .command("tape")
  .description("watch the board and the measured events, no desks, no orders")
  .option("--for <n>", "market minutes to watch", (v) => Number(v), 20)
  .action((opts: { for: number }) => {
    const cfg = loadConfig();
    const feed = makeFeed(cfg, { minutes: opts.for });
    let prev = feed.peek();

    process.stdout.write(`\n  ${brass("the board")}  ${muted(`${feed.name} feed`)}\n\n`);
    while (!feed.done) {
      const now = feed.tick();
      if (!now) break;
      const events = readTape(prev, now, {});
      prev = now;

      const line = Object.values(now.quotes)
        .map((q) => `${q.symbol} ${px(q.last)} ${pct(q.changePct)}`)
        .join("   ");
      process.stdout.write(`  ${muted(clock(now.minute))}  ${line}\n`);
      for (const e of events.slice(0, 3)) {
        if (e.symbol === "*") continue;
        process.stdout.write(`  ${" ".repeat(7)}${muted(`${e.symbol} [${e.kind}] ${e.note}`)}\n`);
      }
    }
  });

// ── book ─────────────────────────────────────────────────────────────────────

program
  .command("book <symbol>")
  .description("the ladder, and what one order costs worked against swept")
  .option("--size <n>", "shares to price", (v) => Number(v), 1000)
  .option("--side <side>", "buy or sell", "buy")
  .option("--minute <n>", "advance the feed this many minutes first", (v) => Number(v), 0)
  .option("--replenish <pct>", "how much of a lifted level comes back between child orders", (v) => Number(v))
  .action((symbol: string, opts: { size: number; side: string; minute: number; replenish?: number }) => {
    const cfg = loadConfig();
    const feed = makeFeed(cfg, { minutes: Math.max(1, opts.minute + 1) });
    for (let i = 0; i < opts.minute; i++) feed.tick();

    const sym = symbol.toUpperCase();
    const b = feed.book(sym);
    const side = opts.side === "sell" ? "sell" : "buy";

    process.stdout.write(`\n  ${brass(sym)}  ${muted(`minute ${feed.minute} · spread ${spreadBps(b).toFixed(1)} bps · imbalance ${imbalance(b).toFixed(3)}`)}\n\n`);
    for (const l of ladder(b, 5)) process.stdout.write(l + "\n");

    const exec = opts.replenish === undefined ? cfg.exec : { ...cfg.exec, replenishPct: opts.replenish };
    const c = compare(b, side, opts.size, exec);
    process.stdout.write(`\n  ${brass(`${side} ${shares(opts.size)}`)}\n`);
    process.stdout.write(
      `  ${muted(pad("work", 8))} ${shares(c.work.filledSize)} filled @ ${px(c.work.avgPrice, 4)}  ${bps(c.work.slippageBps)}${c.work.unfilledReason ? muted(`  (${c.work.unfilledReason})`) : ""}\n`,
    );
    process.stdout.write(
      `  ${muted(pad("sweep", 8))} ${shares(c.sweep.filledSize)} filled @ ${px(c.sweep.avgPrice, 4)}  ${bps(c.sweep.slippageBps)}\n`,
    );
    process.stdout.write(`  ${muted(pad("saved", 8))} ${c.savedBps.toFixed(1)} bps by working it\n`);
    process.stdout.write(
      `  ${muted(`assumes a lifted level gives back ${exec.replenishPct}% before the next child order — EXEC_REPLENISH, docs/EXECUTION.md`)}\n`,
    );
    process.stdout.write(`\n  ${muted("the ladder, one row per level, with the child orders it took:")}\n`);
    const byLevel = new Map<number, { price: number; size: number; children: number }>();
    for (const f of c.work.fills) {
      const row = byLevel.get(f.level) ?? { price: f.price, size: 0, children: 0 };
      row.size += f.size;
      row.children++;
      byLevel.set(f.level, row);
    }
    for (const [level, row] of byLevel) {
      process.stdout.write(
        `  ${muted(`level ${level}`)}  ${px(row.price)} × ${lpad(shares(row.size), 7)}  ${muted(`${row.children} child order${row.children === 1 ? "" : "s"}`)}\n`,
      );
    }
  });

// ── gate ─────────────────────────────────────────────────────────────────────

program
  .command("gate")
  .description("push a hypothetical ticket through the hard limits and print every rule that fired")
  .requiredOption("--symbol <s>", "name")
  .requiredOption("--side <side>", "buy or sell")
  .requiredOption("--notional <n>", "what the desk would ask for", (v) => Number(v))
  .option("--equity <n>", "equity to test against", (v) => Number(v))
  .option("--gross <n>", "gross already on", (v) => Number(v), 0)
  .option("--net <n>", "net already on", (v) => Number(v), 0)
  .option("--names <n>", "names already open", (v) => Number(v), 0)
  .option("--pnl <n>", "session P&L so far", (v) => Number(v), 0)
  .action((opts: Record<string, string | number>) => {
    const cfg = loadConfig();
    const equity = Number(opts.equity ?? cfg.equity);
    const ticket: Ticket = {
      id: "T-0000-TEST",
      ts: Date.now(),
      desk: "quant",
      symbol: String(opts.symbol).toUpperCase(),
      side: opts.side === "sell" ? "sell" : "buy",
      notional: Number(opts.notional),
      thesis: "hypothetical ticket from the command line",
      horizonMin: 30,
      conviction: 50,
      state: "written",
    };

    const exposure = exposureOf([], {}, equity, Number(opts.pnl));
    exposure.gross = Number(opts.gross);
    exposure.net = Number(opts.net);
    exposure.names = Number(opts.names);

    const hard = checkHard(ticket, exposure, cfg.risk, 0);

    process.stdout.write(`\n  ${brass(`${ticket.side} ${ticket.symbol} ${money(ticket.notional)}`)}  ${muted(`against ${money(equity)} equity`)}\n\n`);
    for (const r of hard.reasons) process.stdout.write(`  ${r.startsWith("refused") ? r : muted(r)}\n`);
    process.stdout.write(
      `\n  ${hard.pass ? badge("CLEARED") : badge("REFUSED")}  ${hard.pass ? money(hard.allowed) : `by ${hard.refusedBy}`}\n`,
    );
    process.stdout.write(
      `  ${muted("the model review runs on top of this and can only tighten it — src/risk/gate.ts")}\n`,
    );
  });

// ── floorview ────────────────────────────────────────────────────────────────

program
  .command("floor")
  .description("the same engine behind a page on 127.0.0.1")
  .option("--port <n>", "port", (v) => Number(v))
  .option("--minutes <n>", "market minutes to run", (v) => Number(v))
  .option("--seed <n>", "synthetic feed seed", (v) => Number(v))
  .option("--signal-every <n>", "market minutes between desk signals", (v) => Number(v), 5)
  .action(async (opts: { port?: number; minutes?: number; seed?: number; signalEvery: number }) => {
    const cfg = loadConfig();
    if (opts.minutes) cfg.sessionMin = opts.minutes;
    if (opts.seed !== undefined) cfg.tape.seed = opts.seed;
    if (opts.port) cfg.view.port = opts.port;

    const feed = makeFeed(cfg, { seed: cfg.tape.seed, minutes: cfg.sessionMin });
    const floor = new Floor({ cfg, feed, signalEvery: opts.signalEvery });
    await serveFloor(floor, cfg.view.port);
  });

// ── receipts ─────────────────────────────────────────────────────────────────

program
  .command("receipts [session]")
  .description("read a session's receipt file, or verify its hash chain")
  .option("--verify", "walk the chain and report the first line that does not match")
  .option("--tail <n>", "print the last n records", (v) => Number(v), 20)
  .option("--kind <kind>", "only this kind of record")
  .action((session: string | undefined, opts: { verify?: boolean; tail: number; kind?: string }) => {
    const cfg = loadConfig();
    const dir = join(cfg.dataDir, "receipts");
    if (!existsSync(dir)) {
      process.stdout.write(`  no receipts yet. Run ${brass("outcry open")} first.\n`);
      return;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    if (files.length === 0) {
      process.stdout.write(`  no receipts yet.\n`);
      return;
    }
    const file = join(dir, session ? `${session}.jsonl` : files[0]!);

    if (opts.verify) {
      const v = verify(file);
      process.stdout.write(`\n  ${file}\n`);
      if (v.ok) {
        process.stdout.write(`  ${badge("INTACT")} ${v.lines} records · head ${brass(v.head)}\n`);
        process.stdout.write(
          `  ${muted("this is tamper-evident, not tamper-proof: a whole file can be rewritten and rehashed. It catches an edited line.")}\n`,
        );
      } else {
        process.stdout.write(`  ${badge("BROKEN")} at record ${v.brokeAt}: ${v.reason}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const all = readReceipts(file).filter((r) => !opts.kind || r.kind === opts.kind);
    process.stdout.write(`\n  ${muted(file)}  ${all.length} records\n\n`);
    for (const r of all.slice(-opts.tail)) {
      const head = `${muted(lpad(String(r.seq), 5))} ${brass(pad(r.seat, 8))} ${pad(r.kind, 17)}`;
      const body = JSON.stringify(r.body);
      process.stdout.write(`${head} ${body.length > 120 ? body.slice(0, 117) + "…" : body}\n`);
    }
  });

// ── positions ────────────────────────────────────────────────────────────────

program
  .command("positions [session]")
  .description("what a session ended holding, rebuilt from its receipts alone")
  .action((session: string | undefined) => {
    const cfg = loadConfig();
    const dir = join(cfg.dataDir, "receipts");
    if (!existsSync(dir)) {
      process.stdout.write(`  no sessions yet.\n`);
      return;
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    const file = join(dir, session ? `${session}.jsonl` : files[files.length - 1]!);
    const records = readReceipts(file);

    const bySymbol = new Map<string, { size: number; notional: number }>();
    for (const r of records) {
      if (r.kind !== "order.done") continue;
      const exec = (r.body as { execution?: { symbol: string; side: string; filledSize: number; avgPrice: number } }).execution;
      if (!exec || !exec.filledSize) continue;
      const signed = exec.side === "buy" ? exec.filledSize : -exec.filledSize;
      const e = bySymbol.get(exec.symbol) ?? { size: 0, notional: 0 };
      e.size += signed;
      e.notional += signed * exec.avgPrice;
      bySymbol.set(exec.symbol, e);
    }

    const close = records.find((r) => r.kind === "session.close");
    process.stdout.write(`\n  ${muted(file)}\n\n`);
    process.stdout.write(`  ${muted(pad("name", 8))}${lpad("size", 10)}${lpad("avg", 12)}\n`);
    for (const [symbol, e] of bySymbol) {
      if (Math.abs(e.size) < 0.001) continue;
      process.stdout.write(
        `  ${pad(symbol, 8)}${lpad(shares(e.size), 10)}${lpad(px(Math.abs(e.notional / e.size), 4), 12)}\n`,
      );
    }
    if (close) {
      const b = close.body as Record<string, number | string>;
      process.stdout.write(`\n  ${brass("close")}  ${money(Number(b.equityStart))} → ${money(Number(b.equityEnd))}\n`);
      process.stdout.write(`  ${String(b.summary ?? "").split("\n").join(`\n  `)}\n`);
    }
  });

// ── replay ───────────────────────────────────────────────────────────────────

program
  .command("replay <session>")
  .description("re-derive a session's close from its receipts and compare it with what was written")
  .action((session: string) => {
    const cfg = loadConfig();
    const file = join(cfg.dataDir, "receipts", `${session}.jsonl`);
    const v = verify(file);
    if (!v.ok) {
      process.stdout.write(`  ${badge("BROKEN")} chain fails at record ${v.brokeAt}: ${v.reason}\n`);
      process.exitCode = 1;
      return;
    }

    const records = readReceipts(file);
    const open = records.find((r) => r.kind === "session.open");
    const close = records.find((r) => r.kind === "session.close");
    if (!open || !close) {
      process.stdout.write(`  ${file} has no open/close pair.\n`);
      process.exitCode = 1;
      return;
    }

    const startEquity = Number((open.body as { equity: number }).equity);
    let cash = startEquity;
    const sizes = new Map<string, number>();
    let fills = 0;

    for (const r of records) {
      if (r.kind !== "order.done") continue;
      const exec = (r.body as { execution?: { symbol: string; side: string; filledSize: number; avgPrice: number; fills: unknown[] } }).execution;
      if (!exec?.filledSize) continue;
      fills += exec.fills.length;
      const signed = exec.side === "buy" ? exec.filledSize : -exec.filledSize;
      cash -= signed * exec.avgPrice;
      sizes.set(exec.symbol, (sizes.get(exec.symbol) ?? 0) + signed);
    }

    const written = close.body as Record<string, number>;
    process.stdout.write(`\n  ${muted(file)}\n`);
    process.stdout.write(`  ${badge("INTACT")} ${v.lines} records · head ${brass(v.head.slice(0, 24))}\n\n`);
    process.stdout.write(`  ${muted(pad("", 18))}${lpad("written", 14)}${lpad("re-derived", 14)}\n`);
    const line = (label: string, a: number, b: number): void => {
      const same = Math.abs(a - b) < 0.02;
      process.stdout.write(
        `  ${pad(label, 18)}${lpad(money(a), 14)}${lpad(money(b), 14)}  ${same ? badge("=") : badge("≠")}\n`,
      );
    };
    line("equity start", Number(written.equityStart), startEquity);
    process.stdout.write(`  ${pad("fills", 18)}${lpad(String(written.fills), 14)}${lpad(String(fills), 14)}\n`);
    process.stdout.write(`\n  ${muted("positions rebuilt from fills alone:")}\n`);
    for (const [symbol, size] of sizes) {
      if (Math.abs(size) < 0.001) continue;
      process.stdout.write(`  ${pad(symbol, 8)}${lpad(shares(size), 10)}\n`);
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`\n  ${err.message}\n\n`);
  process.exitCode = 1;
});
