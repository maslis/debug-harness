import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "..", "fixtures", "pages");

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0]!;
    const file = urlPath === "/" ? "baseline.html" : urlPath.replace(/^\//, "");
    try {
      const body = await readFile(join(PAGES_DIR, file), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server address unavailable");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))),
  };
}
