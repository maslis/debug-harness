import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { isAlive, makeSandbox, openRun, postRun, waitFor, type RunEvent, type Sandbox } from "./helpers.ts";

let s: Sandbox;
let runner: RunnerHandle;
let logs: string[];

async function start(over: Parameters<Sandbox["config"]>[0] = {}): Promise<number> {
  logs = [];
  runner = await startRunner(s.config({ killGraceMs: 300, ...over }), { log: (l) => logs.push(l), port: 0, host: "127.0.0.1" });
  return runner.port;
}
beforeEach(() => {
  s = makeSandbox();
});
afterEach(async () => {
  await runner?.close();
  s.cleanup();
});

const exitOf = (ev: RunEvent[]) => ev.find((e) => e.type === "exit");
const pw = (env: Record<string, string> = {}, args: string[] = []) => ({ command: "playwright", args, cwd: s.root, env });

describe("run", () => {
  it("passes the exit code through", async () => {
    const port = await start();
    for (const code of [0, 1, 3, 77]) {
      const r = await postRun(port, pw({ FAKE_MODE: `exit:${code}` }));
      expect(exitOf(r.events)).toMatchObject({ code, outcome: "exited" });
    }
  });

  it("reports a death by signal as a signal, never as success", async () => {
    const port = await start();
    const r = await postRun(port, pw({ FAKE_MODE: "kill-self" }));
    expect(exitOf(r.events)).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("streams stdout and stderr separately", async () => {
    const port = await start();
    const r = await postRun(port, pw());
    const text = (stream: string) => r.events.filter((e) => e.type === "output" && e.stream === stream).map((e) => e.data).join("");
    expect(text("stdout")).toBe("fake stdout\n");
    expect(text("stderr")).toBe("fake stderr\n");
  });

  it("delivers output before the run ends", async () => {
    const port = await start();
    const out = join(s.base, "hang.json");
    const open = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    expect(open.events.some((e) => e.type === "exit")).toBe(false);
    open.drop();
    await open.done;
  });

  it("runs with an argv, so shell characters stay literal", async () => {
    const port = await start();
    const out = join(s.base, "argv.json");
    const canary = join(s.base, "canary");
    const evil = `$(touch ${canary}); touch ${canary} | touch ${canary} \`touch ${canary}\` && "' *`;
    const r = await postRun(port, pw({ FAKE_OUT: out, BASE_URL: evil }, [`--grep=${evil}`, "tests/a.spec.ts"]));
    expect(exitOf(r.events)).toMatchObject({ code: 0 });
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.argv).toContain(`--grep=${evil}`);
    expect(seen.env.BASE_URL).toBe(evil);
    expect(existsSync(canary)).toBe(false);
  });

  it("fixes the command: config, output, reporter and pin are the runner's", async () => {
    const port = await start();
    const out = join(s.base, "argv.json");
    const r = await postRun(port, pw({ FAKE_OUT: out }, ["tests/a.spec.ts", "--workers=1"]));
    const started = r.events.find((e) => e.type === "started") as unknown as { resultsDir: string };
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.cwd).toBe(s.root);
    expect(seen.argv[0]).toBe("test");
    expect(seen.argv).toContain(`--config=${join(s.root, "playwright.config.ts")}`);
    expect(seen.argv).toContain(`--output=${join(started.resultsDir, "output")}`);
    expect(seen.argv).toContain("--reporter=list,json");
    expect(seen.argv).toContain("--workers=1");
    expect(seen.argv.slice(-2)).toEqual(["--", `^${s.root}/tests/a\\.spec\\.ts$`]);
    expect(seen.env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(join(started.resultsDir, "report.json"));
    expect(seen.env.NODE_OPTIONS).toMatch(/^--import=.*pin-playwright\.mjs$/);
    expect(started.resultsDir.startsWith(s.results)).toBe(true);
    expect(existsSync(started.resultsDir)).toBe(true);
  });

  it("a client's --reporter replaces the default", async () => {
    const port = await start();
    const out = join(s.base, "argv.json");
    await postRun(port, pw({ FAKE_OUT: out }, ["--reporter=dot"]));
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.argv).toContain("--reporter=dot");
    expect(seen.argv).not.toContain("--reporter=list,json");
  });

  it("gives the child only a clean environment, not the runner's own", async () => {
    process.env.RUNNER_TEST_SECRET = "hunter2";
    try {
      const port = await start({ defaultEnv: { BASE_URL: "http://web:4321" } });
      const out = join(s.base, "env.json");
      await postRun(port, pw({ FAKE_OUT: out }));
      const seen = JSON.parse(readFileSync(out, "utf8"));
      expect(seen.env.RUNNER_TEST_SECRET).toBeUndefined();
      expect(seen.env.BASE_URL).toBe("http://web:4321");
      expect(seen.env.PATH).toBeTruthy();
    } finally {
      delete process.env.RUNNER_TEST_SECRET;
    }
  });

  it("a request's env overrides the project's default", async () => {
    const port = await start({ defaultEnv: { BASE_URL: "http://web:4321" } });
    const out = join(s.base, "env.json");
    await postRun(port, pw({ FAKE_OUT: out, BASE_URL: "http://web:4399" }));
    expect(JSON.parse(readFileSync(out, "utf8")).env.BASE_URL).toBe("http://web:4399");
  });

  it("runs an allowed script with node, and does not preload the pin", async () => {
    const port = await start({ scripts: { dir: "scripts/shell" } });
    const r = await postRun(port, { command: "script", args: ["scripts/shell/ok.mjs", "--a", "b c"], cwd: s.root });
    expect(exitOf(r.events)).toMatchObject({ code: 0 });
    const text = r.events.filter((e) => e.type === "output").map((e) => e.data).join("");
    expect(JSON.parse(text)).toEqual(["--a", "b c"]);
  });

  it("keeps only the most recent run folders", async () => {
    const port = await start({ keepRuns: 2 });
    for (let i = 0; i < 4; i++) await postRun(port, pw({ FAKE_MODE: "exit:0" }));
    expect(readdirSync(join(s.results, "runner"))).toHaveLength(2);
  });
});

describe("--output", () => {
  it("replaces the runner's default output folder", async () => {
    const port = await start();
    const out = join(s.base, "argv.json");
    await postRun(port, pw({ FAKE_OUT: out }, ["--output=.debug-harness/mine"]));
    const argv = JSON.parse(readFileSync(out, "utf8")).argv as string[];
    expect(argv.filter((a) => a.startsWith("--output="))).toEqual([`--output=${join(s.results, "mine")}`]);
  });
});

describe("clean-up", () => {
  const entries = (dir: string) => readdirSync(dir);

  async function start2(fixed: string, over: Parameters<Sandbox["config"]>[0] = {}) {
    const scratch = join(s.base, "scratch");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(fixed, { recursive: true });
    return { port: await start({ scratchDir: scratch, sweepDirs: [fixed], ...over }), scratch };
  }

  it("gives each run its own TMPDIR and HOME, and removes them when it ends", async () => {
    const fixed = join(s.base, "fixed");
    const { port, scratch } = await start2(fixed);
    const out = join(s.base, "litter.json");
    await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    const first = JSON.parse(readFileSync(out, "utf8"));
    expect(first.tmp.startsWith(scratch)).toBe(true);
    expect(first.home.startsWith(scratch)).toBe(true);
    expect(first.tmp).not.toBe(first.home);
    expect(existsSync(first.tmp)).toBe(false);
    expect(existsSync(first.home)).toBe(false);
    expect(entries(scratch)).toEqual([]);

    await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    expect(JSON.parse(readFileSync(out, "utf8")).tmp).not.toBe(first.tmp);
  });

  it("sweeps a configured folder of what a run wrote at a fixed path, keeping the folder", async () => {
    const fixed = join(s.base, "fixed");
    const { port } = await start2(fixed);
    const out = join(s.base, "litter.json");
    await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    expect(existsSync(fixed)).toBe(true);
    expect(entries(fixed)).toEqual([]);
  });

  it("is clean by the time the client gets the exit event", async () => {
    const fixed = join(s.base, "fixed");
    const { port, scratch } = await start2(fixed);
    const out = join(s.base, "litter.json");
    const r = await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    expect(exitOf(r.events)).toMatchObject({ code: 0 });
    expect(entries(scratch)).toEqual([]);
    expect(entries(fixed)).toEqual([]);
  });

  it("cleans up after a dropped client and after a timeout", async () => {
    const fixed = join(s.base, "fixed");
    const { port, scratch } = await start2(fixed, { timeoutMs: 400 });
    const out = join(s.base, "litter.json");
    const env = { FAKE_MODE: "litter", FAKE_THEN_HANG: "1", FAKE_OUT: out, FAKE_FIXED: fixed };
    await postRun(port, pw(env));
    expect(entries(scratch)).toEqual([]);
    expect(entries(fixed)).toEqual([]);
    const open = await openRun(port, pw(env), (e) => e.type === "output");
    open.drop();
    await waitForIdle(port);
    expect(entries(scratch)).toEqual([]);
    expect(entries(fixed)).toEqual([]);
  });

  it("sweeps nothing unless a project asks", async () => {
    const fixed = join(s.base, "fixed");
    mkdirSync(fixed);
    const port = await start();
    const out = join(s.base, "litter.json");
    await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    expect(entries(fixed)).toEqual(["fixed-path"]);
  });

  it("keeps the results folder across the sweep", async () => {
    const fixed = join(s.base, "fixed");
    const { port } = await start2(fixed);
    const out = join(s.base, "litter.json");
    const r = await postRun(port, pw({ FAKE_MODE: "litter", FAKE_OUT: out, FAKE_FIXED: fixed }));
    expect(existsSync((r.events.find((e) => e.type === "started") as unknown as { resultsDir: string }).resultsDir)).toBe(true);
  });
});

describe("refusals", () => {
  it("answers 400 with a code, and starts nothing", async () => {
    const port = await start();
    const r = await postRun(port, { command: "playwright", args: ["--config=/tmp/x"], cwd: s.root });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("flag_not_allowed");
    expect(existsSync(join(s.results, "runner"))).toBe(false);
  });

  it.each([["not json"], ["[]"], ['{"command":"playwright"}'], ['{"command":"playwright","args":"x","cwd":"/"}']])(
    "answers 400 to the malformed body %s",
    async (body) => {
      const port = await start();
      expect((await postRun(port, body)).status).toBe(400);
    },
  );

  it("refuses an oversized body", async () => {
    const port = await start();
    expect((await postRun(port, { command: "playwright", args: ["x".repeat(2_000_000)], cwd: s.root })).status).toBe(413);
  });

  it("refuses a browser page: no JSON content type", async () => {
    const port = await start();
    const r = await postRun(port, pw(), { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });

  it("refuses a browser page: any Origin header", async () => {
    const port = await start();
    const r = await postRun(port, pw(), { origin: "https://ads.example" });
    expect(r.status).toBe(403);
  });
});

describe("read-only note", () => {
  const note = (r: { events: RunEvent[] }) =>
    r.events.filter((e) => e.type === "output" && e.stream === "stderr" && String(e.data).includes("runner: note:"));
  const wt = () => join(s.worktrees, "wt1");
  const printing = (text: string, cwd: string) => ({ command: "playwright", args: [], cwd, env: { FAKE_MODE: "print", FAKE_PRINT: text } });

  it("explains a read-only error once, before the exit event, with the writable folder", async () => {
    const port = await start();
    const r = await postRun(port, printing("EROFS: read-only file system, open 'a.png'\nEROFS: read-only file system, open 'b.png'", wt()));
    expect(note(r)).toHaveLength(1);
    expect(note(r)[0]!.data).toContain(s.results);
    expect(r.events.indexOf(note(r)[0]!)).toBeLessThan(r.events.findIndex((e) => e.type === "exit"));
    expect(exitOf(r.events)).toMatchObject({ code: 1 });
  });

  it("explains the ENOENT a worktree gets for a results folder it cannot create", async () => {
    const port = await start();
    const r = await postRun(port, printing("ENOENT: no such file or directory, open '.debug-harness/runs/x.png'", wt()));
    expect(note(r)).toHaveLength(1);
  });

  it("stays quiet on that ENOENT from the root that holds the results folder", async () => {
    const port = await start();
    const r = await postRun(port, printing("ENOENT: no such file or directory, open '.debug-harness/runs/x.png'", s.root));
    expect(note(r)).toHaveLength(0);
  });

  it("stays quiet on an unrelated ENOENT and on a clean run", async () => {
    const port = await start();
    expect(note(await postRun(port, printing("ENOENT: no such file or directory, open 'fixtures/x.json'", wt())))).toHaveLength(0);
    expect(note(await postRun(port, pw()))).toHaveLength(0);
  });

  it("does not put the note or the output in the log", async () => {
    const port = await start();
    await postRun(port, printing("EROFS: read-only file system, open 'canary-name.png'", wt()));
    expect(logs.join("\n")).not.toContain("canary-name");
  });
});

describe("queue", () => {
  it("runs one at a time, in order", async () => {
    const port = await start();
    const out = join(s.base, "first.json");
    const first = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    const second = await openRun(port, pw({ FAKE_MODE: "exit:5" }), (e) => e.type === "queued");
    const third = await openRun(port, pw({ FAKE_MODE: "exit:6" }), (e) => e.type === "queued");
    expect(second.events[0]).toMatchObject({ type: "queued", position: 1 });
    expect(third.events[0]).toMatchObject({ type: "queued", position: 2 });
    await new Promise((r) => setTimeout(r, 200));
    expect(second.events.some((e) => e.type === "started")).toBe(false);

    first.drop();
    await second.done;
    expect(exitOf(second.events)).toMatchObject({ code: 5 });
    await third.done;
    expect(third.events.some((e) => e.type === "started")).toBe(true);
    expect(exitOf(third.events)).toMatchObject({ code: 6 });
  });

  it("refuses clearly when the queue is full", async () => {
    const port = await start({ maxQueue: 1 });
    const out = join(s.base, "first.json");
    const first = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    const waiting = await openRun(port, pw({ FAKE_MODE: "exit:0" }), (e) => e.type === "queued");
    const r = await postRun(port, pw({ FAKE_MODE: "exit:0" }));
    expect(r.status).toBe(429);
    expect(r.error?.code).toBe("queue_full");
    first.drop();
    await waiting.done;
  });

  it("a client that leaves while waiting never starts", async () => {
    const port = await start();
    const out = join(s.base, "first.json");
    const marker = join(s.base, "second.json");
    const first = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    const second = await openRun(port, pw({ FAKE_OUT: marker }), (e) => e.type === "queued");
    second.drop();
    await new Promise((r) => setTimeout(r, 100));
    first.drop();
    await first.done;
    await waitForIdle(port);
    expect(existsSync(marker)).toBe(false);
  });

  it("a spec removed while queued is refused when its turn comes, and the queue moves on", async () => {
    const port = await start();
    const out = join(s.base, "first.json");
    const first = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    const spec = join(s.root, "tests/temp.spec.ts");
    execFileSync("touch", [spec]);
    const second = await openRun(port, pw({ FAKE_MODE: "exit:0" }, ["tests/temp.spec.ts"]), (e) => e.type === "queued");
    const third = await openRun(port, pw({ FAKE_MODE: "exit:9" }), (e) => e.type === "queued");
    execFileSync("rm", [spec]);
    first.drop();
    await second.done;
    expect(second.events.at(-1)).toMatchObject({ type: "refused", code: "path_not_found" });
    await third.done;
    expect(exitOf(third.events)).toMatchObject({ code: 9 });
  });
});

async function health(port: number): Promise<Record<string, unknown>> {
  return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
}

async function waitForIdle(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await health(port)).running === false) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("runner never went idle");
}

describe("kill", () => {
  async function expectAllDead(file: string): Promise<void> {
    const pids = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    for (const [name, pid] of Object.entries(pids)) {
      expect(await waitFor(() => !isAlive(pid)), `${name} (${pid}) still alive`).toBe(true);
    }
  }

  it("a dropped client kills the group, and the child in its own session", async () => {
    const port = await start();
    const out = join(s.base, "pids.json");
    const open = await openRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }), (e) => e.type === "output");
    expect(Object.values(JSON.parse(readFileSync(out, "utf8")) as Record<string, number>).every(isAlive)).toBe(true);
    open.drop();
    await expectAllDead(out);
  });

  it("a timeout kills the group, and reports the timeout", async () => {
    const port = await start({ timeoutMs: 300 });
    const out = join(s.base, "pids.json");
    const r = await postRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }));
    expect(exitOf(r.events)).toMatchObject({ outcome: "timeout" });
    await expectAllDead(out);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const port = await start({ timeoutMs: 300, killGraceMs: 100 });
    const out = join(s.base, "pids.json");
    const r = await postRun(port, pw({ FAKE_MODE: "ignore-term", FAKE_OUT: out }));
    expect(exitOf(r.events)).toMatchObject({ outcome: "timeout", signal: "SIGKILL" });
    await expectAllDead(out);
  });

  it("the limit is the project's: a request cannot set it", async () => {
    const port = await start({ timeoutMs: 300 });
    const out = join(s.base, "pids.json");
    const r = await postRun(port, { ...pw({ FAKE_MODE: "hang", FAKE_OUT: out }), timeoutMs: 999_999 });
    expect(exitOf(r.events)).toMatchObject({ outcome: "timeout" });
  });

  it("the next run starts after a killed one", async () => {
    const port = await start({ timeoutMs: 200 });
    const out = join(s.base, "pids.json");
    await postRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }));
    const r = await postRun(port, pw({ FAKE_MODE: "exit:4" }));
    expect(exitOf(r.events)).toMatchObject({ code: 4 });
  });
});

describe("log", () => {
  const SECRET = "s3cr3t-VALUE-do-not-log";

  it("records command, cwd, env names, exit code and duration", async () => {
    const port = await start();
    await postRun(port, pw({ FAKE_MODE: "exit:3", BASE_URL: "http://web" }, ["tests/a.spec.ts", "--workers=1"]));
    const entry = JSON.parse(logs.at(-1)!);
    expect(entry).toMatchObject({ command: "playwright", cwd: s.root, exit: 3, outcome: "exited" });
    expect(entry.envNames.sort()).toEqual(["BASE_URL", "FAKE_MODE"]);
    expect(entry.args).toEqual(expect.arrayContaining(["tests/a.spec.ts", "--workers=<hidden>"]));
    expect(typeof entry.durationMs).toBe("number");
  });

  it("never holds env values, grep values, script arguments or refused input", async () => {
    const port = await start({ scripts: { dir: "scripts/shell" } });
    await postRun(port, pw({ BASE_URL: SECRET, PRO1_KEY: SECRET, FAKE_MODE: "exit:0" }, [`--grep=${SECRET}`]));
    await postRun(port, { command: "script", args: ["scripts/shell/ok.mjs", `--token=${SECRET}`, SECRET], cwd: s.root });
    await postRun(port, pw({ NOT_ALLOWED: SECRET }));
    await postRun(port, pw({}, [`--nope=${SECRET}`]));
    await postRun(port, pw({}, [`tests/${SECRET}.spec.ts`]));
    await postRun(port, { command: "playwright", args: [], cwd: `/${SECRET}` });
    await postRun(port, `{"not json ${SECRET}`);
    expect(logs.length).toBeGreaterThanOrEqual(7);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("never logs the child's output", async () => {
    const port = await start({ scripts: { dir: "scripts/shell" } });
    await postRun(port, { command: "script", args: ["scripts/shell/ok.mjs", SECRET], cwd: s.root });
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("refusals name the offending env name to the client, never its value", async () => {
    const port = await start();
    const r = await postRun(port, pw({ NOT_ALLOWED: SECRET }));
    expect(r.error?.message).toContain("NOT_ALLOWED");
    expect(r.error?.message).not.toContain(SECRET);
  });

  it("logs a drop and a timeout as such", async () => {
    const port = await start({ timeoutMs: 200 });
    const out = join(s.base, "pids.json");
    await postRun(port, pw({ FAKE_MODE: "hang", FAKE_OUT: out }));
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ outcome: "timeout" });
  });
});

describe("health", () => {
  it("reports idle state, the Playwright pin and exposed secret files", async () => {
    mkdirSync(join(s.worktrees, "wt1/sub"), { recursive: true });
    execFileSync("touch", [join(s.root, ".env"), join(s.worktrees, "wt1/.dev.vars")]);
    const port = await start({ secretFiles: [".env", ".dev.vars"] });
    const h = await health(port);
    expect(h).toMatchObject({ status: "ok", project: "test", running: false, queued: 0, readableSecretFileCount: 2 });
  });

  it("is unauthenticated, so it gives a count and never a file's name or path", async () => {
    execFileSync("touch", [join(s.root, ".env"), join(s.worktrees, "wt1/.dev.vars")]);
    const port = await start({ secretFiles: [".env", ".dev.vars"] });
    const text = await (await fetch(`http://127.0.0.1:${port}/health`)).text();
    expect(text).not.toContain(".env");
    expect(text).not.toContain(".dev.vars");
    expect(text).not.toContain("wt1");
    expect(text).not.toContain("readableSecretFiles");
  });
});

describe("oversized values", () => {
  const huge = "x".repeat(200_000);

  it.each([
    ["env", () => pw({ BASE_URL: huge })],
    ["--grep=", () => pw({}, [`--grep=${huge}`])],
    ["--grep", () => pw({}, ["--grep", huge])],
    ["script argument", () => ({ command: "script", args: ["scripts/shell/ok.mjs", huge], cwd: s.root })],
  ])("%s: bad_request before spawn, no run folder, no internal error", async (_name, make) => {
    const port = await start({ scripts: { dir: "scripts/shell" } });
    const r = await postRun(port, make());
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("bad_request");
    expect(existsSync(join(s.results, "runner"))).toBe(false);
    expect(logs.join("\n")).not.toContain("internal_error");
  });
});
