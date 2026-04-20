import Fastify from "fastify";
import { chromium, devices, type Browser } from "playwright";
import { CaptureRequestSchema, CompareRequestSchema } from "./types.ts";
import { capture } from "./capture.ts";
import { compareRuns } from "./compare.ts";
import { HARNESS_VERSION } from "./version.ts";

export async function buildServer(): Promise<{
  app: ReturnType<typeof Fastify>;
  close: () => Promise<void>;
}> {
  let browser: Browser = await chromium.launch();
  const app = Fastify({ logger: { level: "info" } });

  async function getBrowser(): Promise<Browser> {
    if (!browser.isConnected()) {
      app.log.warn("browser disconnected; relaunching");
      browser = await chromium.launch();
    }
    return browser;
  }

  const startedAt = Date.now();

  app.get("/health", async () => ({
    status: "ok",
    harnessVersion: HARNESS_VERSION,
    browserVersion: browser.version(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get("/devices", async () => Object.keys(devices));

  app.post("/capture", async (req, reply) => {
    const parsed = CaptureRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await capture(await getBrowser(), parsed.data);
      const status = result.summary.error ? 422 : 200;
      return reply.code(status).send(result);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "internal", reason: (err as Error).message });
    }
  });

  app.post("/compare", async (req, reply) => {
    const parsed = CompareRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await compareRuns(await getBrowser(), parsed.data);
      return reply.send(result);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "internal", reason: (err as Error).message });
    }
  });

  return {
    app,
    close: async () => {
      await app.close();
      await browser.close();
    },
  };
}
