import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../../../src/runner/config.ts";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { makeSandbox, openRun, postRun, type Sandbox } from "./helpers.ts";

const SECRET = "s3cr3t-in-a-message";
const trap = vi.hoisted(() => ({ resolveThrows: false }));

// A bug in the checks, which is what finding 1 was. The real ones run otherwise.
vi.mock("../../../src/runner/validate.ts", async (real) => {
  const mod = await real<typeof import("../../../src/runner/validate.ts")>();
  return {
    ...mod,
    resolveRun: (...a: Parameters<typeof mod.resolveRun>) => {
      if (trap.resolveThrows) throw new TypeError(SECRET);
      return mod.resolveRun(...a);
    },
  };
});

let s: Sandbox;
let runner: RunnerHandle;
let logs: string[];

async function start(config: RunnerConfig): Promise<number> {
  logs = [];
  runner = await startRunner(config, { log: (l) => logs.push(l), port: 0, host: "127.0.0.1" });
  return runner.port;
}
const pw = (env: Record<string, string> = {}) => ({ command: "playwright", args: [], cwd: s.root, env });
const healthStatus = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).status;

/** A config value that throws when read while `on` is true. */
function throwingWhenRead<K extends keyof RunnerConfig>(config: RunnerConfig, key: K): { on: boolean } {
  const state = { on: false };
  const value = config[key];
  Object.defineProperty(config, key, {
    get() {
      if (state.on) throw new TypeError(SECRET);
      return value;
    },
  });
  return state;
}

beforeEach(() => {
  s = makeSandbox();
  trap.resolveThrows = false;
});
afterEach(async () => {
  trap.resolveThrows = false;
  await runner?.close();
  s.cleanup();
});

describe("a throw inside the service", () => {
  it("while reading a POST /run body answers 500, and the service still answers", async () => {
    const port = await start(s.config());
    trap.resolveThrows = true;
    const r = await postRun(port, pw());
    expect(r.status).toBe(500);
    expect(r.error?.code).toBe("internal");
    expect(r.error?.message).not.toContain(SECRET);
    trap.resolveThrows = false;
    expect(await healthStatus(port)).toBe(200);
    expect((await postRun(port, pw({ FAKE_MODE: "exit:3" }))).events.at(-1)).toMatchObject({ type: "exit", code: 3 });
  });

  it("in the request handler itself answers 500, and the service still answers", async () => {
    const config = s.config();
    const secretFiles = throwingWhenRead(config, "secretFiles");
    const port = await start(config);
    secretFiles.on = true;
    const reply = await fetch(`http://127.0.0.1:${port}/health`);
    expect(reply.status).toBe(500);
    expect(((await reply.json()) as { error: { code: string } }).error.code).toBe("internal");
    secretFiles.on = false;
    expect(await healthStatus(port)).toBe(200);
  });

  it("while re-checking a queued run refuses that run, and the queue moves on", async () => {
    const port = await start(s.config({ killGraceMs: 100 }));
    const out = join(s.base, "first.json");
    const first = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    const second = await openRun(port, pw({ FAKE_MODE: "exit:5" }), (e) => e.type === "queued");
    trap.resolveThrows = true;
    first.drop();
    await second.done;
    trap.resolveThrows = false;
    expect(second.events.at(-1)).toMatchObject({ type: "refused", code: "internal" });
    expect((await postRun(port, pw({ FAKE_MODE: "exit:6" }))).events.at(-1)).toMatchObject({ type: "exit", code: 6 });
  });

  it("while cleaning up after a run still delivers its exit, and frees the runner", async () => {
    const config = s.config({ sweepDirs: [join(s.base, "sweep")] });
    const sweep = throwingWhenRead(config, "sweepDirs");
    const port = await start(config);
    sweep.on = true;
    const r = await postRun(port, pw({ FAKE_MODE: "exit:4" }));
    sweep.on = false;
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 4 });
    expect((await postRun(port, pw({ FAKE_MODE: "exit:6" }))).events.at(-1)).toMatchObject({ type: "exit", code: 6 });
  });

  it("is logged by type, never by message", async () => {
    const port = await start(s.config());
    trap.resolveThrows = true;
    await postRun(port, pw());
    trap.resolveThrows = false;
    expect(logs.some((l) => l.includes('"internal_error"') && l.includes("TypeError"))).toBe(true);
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});
