/** The floorview page is not TypeScript, so tsc does not carry it into dist/. */
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "floorview"), { recursive: true });
copyFileSync(
  join(root, "src", "floorview", "index.html"),
  join(root, "dist", "floorview", "index.html"),
);
process.stdout.write("copied floorview/index.html\n");
