import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Floor, FloorState } from "../floor/floor.js";
import { brass, muted } from "../util/fmt.js";

/**
 * The floorview.
 *
 * The same engine as `outcry open`, behind a page. It binds 127.0.0.1 and
 * nothing else, it has no controls that can place an order, and there is no
 * route that mutates anything — the only verbs are GET. A page that could arm
 * a floor would be a page worth attacking; this one is a window.
 *
 * State reaches the browser over server-sent events, which needs no dependency
 * and reconnects on its own. One `state` message per signal, plus a `pulse`
 * every ten seconds so a quiet session is visibly different from a dead one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function pagePath(): string {
  for (const c of [join(HERE, "index.html"), join(HERE, "..", "..", "src", "floorview", "index.html")]) {
    if (existsSync(c)) return c;
  }
  throw new Error("floorview/index.html not found");
}

export async function serveFloor(floor: Floor, port: number): Promise<void> {
  const clients = new Set<ServerResponse>();

  const push = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end("the floorview is read-only");
      return;
    }

    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(pagePath(), "utf8"));
      return;
    }

    if (url === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(floor.state()));
      return;
    }

    if (url === "/roster") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(floor.seatStats()));
      return;
    }

    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(floor.state())}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404).end("not here");
  });

  floor.on("tick", (state: FloorState) => push("state", state));
  const pulse = setInterval(() => push("pulse", { ts: Date.now(), minute: floor.minute }), 10_000);

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  process.stdout.write(
    `\n  ${brass(`http://127.0.0.1:${port}`)}  ${muted("read-only · loopback only · no route places an order")}\n\n`,
  );

  try {
    await floor.run();
    push("state", floor.state());
    push("closed", { sessionId: floor.sessionId });
    process.stdout.write(`\n  ${muted("the session is over; the page stays up. ctrl-c to stop.")}\n`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  } finally {
    clearInterval(pulse);
    for (const c of clients) c.end();
    server.close();
  }
}
