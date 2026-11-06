import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { containerSweep, otherLiveProcesses, sweepUntilEmpty, type Sweep } from "../../../src/runner/sweep.ts";
import { makeSandbox, postRun, waitFor, type RunEvent, type Sandbox } from "./helpers.ts";

// These tests run beside vitest, so nothing here may use the real kill of everything:
// the same loop runs with a kill limited to processes carrying this test's marker.
// The real one is proven on a real Compose start, inside the container's pid namespace.
const FOREVER = "setInterval(() => {}, 1000)";
let s: Sandbox;
let marker: string;
let runner: RunnerHandle | undefined;

const hasMarker = (pid: number): boolean => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker);
  } catch {
    return false;
  }
};
const marked = (): number[] => otherLiveProcesses().filter(hasMarker);
const killMarked = (): void => {
  for (const pid of marked()) process.kill(pid, "SIGKILL");
};
const scopedSweep: Sweep = () => sweepUntilEmpty(killMarked, marked);

beforeEach(() => {
  s = makeSandbox();
  marker = `sweep-test-${process.pid}-${Date.now()}`;
});
afterEach(async () => {
  await runner?.close();
  runner = undefined;
  killMarked();
  s.cleanup();
});

describe("otherLiveProcesses", () => {
  it("never lists pid 1 or the runner itself", () => {
    const list = otherLiveProcesses();
    expect(list).not.toContain(1);
    expect(list).not.toContain(process.pid);
  });

  it("lists a running process and leaves out a zombie, which nothing can kill", async () => {
    // The shell starts a child, then becomes a process that never reaps it.
    const parent = spawn("sh", ["-c", `true & echo $!; exec node -e '${FOREVER}' ${marker}`], { stdio: ["ignore", "pipe", "ignore"] });
    const zombie = await new Promise<number>((res) => parent.stdout.once("data", (c) => res(Number(String(c).trim()))));
    const stateOf = (): string => {
      try {
        const stat = readFileSync(`/proc/${zombie}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      } catch {
        return "gone";
      }
    };
    expect(await waitFor(() => stateOf() === "Z")).toBe(true);
    expect(await waitFor(() => otherLiveProcesses().includes(parent.pid!))).toBe(true);
    expect(otherLiveProcesses()).not.toContain(zombie);
  });
});

describe("sweepUntilEmpty on real processes", () => {
  it("kills a detached process", async () => {
    spawn(process.execPath, ["-e", FOREVER, marker], { detached: true, stdio: "ignore" }).unref();
    expect(await waitFor(() => marked().length === 1)).toBe(true);
    expect(scopedSweep()).toEqual({ clean: true, left: [] });
    expect(marked()).toEqual([]);
  });

  it("kills a double fork: setsid under sh -c … &", async () => {
    spawn("sh", ["-c", `setsid node -e '${FOREVER}' ${marker} >/dev/null 2>&1 &`], { stdio: "ignore" });
    expect(await waitFor(() => marked().length === 1)).toBe(true);
    expect(scopedSweep().clean).toBe(true);
    expect(marked()).toEqual([]);
  });

  it("kills a process that ignores SIGTERM", async () => {
    const ignoring = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); console.log("up"); ${FOREVER}`, marker], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((res) => ignoring.stdout.once("data", res));
    ignoring.kill("SIGTERM");
    expect(marked()).toContain(ignoring.pid);
    expect(scopedSweep().clean).toBe(true);
    expect(marked()).toEqual([]);
  });

  it("repeats until a scan finds nothing, so a process forking during the sweep cannot escape", async () => {
    // Each one starts its successor and stays, so a single pass always misses the newest.
    const script = join(s.base, "chain.cjs");
    writeFileSync(
      script,
      `const { spawn } = require("child_process");
       setTimeout(() => spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore" }).unref(), 5);
       setTimeout(() => process.exit(0), 8000);
       ${FOREVER}`,
    );
    spawn(process.execPath, [script, marker], { detached: true, stdio: "ignore" }).unref();
    expect(await waitFor(() => marked().length >= 3)).toBe(true);
    expect(scopedSweep().clean).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(marked()).toEqual([]);
  });
});

describe("sweepUntilEmpty: the cap", () => {
  it("scans again after each kill and stops at the first empty scan", () => {
    const scans = [[11, 12], [13], []];
    let kills = 0;
    expect(sweepUntilEmpty(() => kills++, () => scans.shift()!)).toEqual({ clean: true, left: [] });
    expect(kills).toBe(3);
    expect(scans).toEqual([]);
  });

  it("always kills once before the first scan: a zombie leader can hide live threads from it", () => {
    let kills = 0;
    sweepUntilEmpty(() => kills++, () => []);
    expect(kills).toBe(1);
  });

  it("gives up at the cap and names what is left", () => {
    const started = Date.now();
    expect(sweepUntilEmpty(() => {}, () => [42], 100)).toEqual({ clean: false, left: [42] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a process table it cannot read is not clean", () => {
    const r = sweepUntilEmpty(() => {}, () => {
      throw new Error("no /proc");
    }, 50);
    expect(r.clean).toBe(false);
  });
});

describe("the service and the sweep", () => {
  async function start(sweep: Sweep, over: Parameters<Sandbox["config"]>[0] = {}): Promise<number> {
    runner = await startRunner(s.config(over), { log: () => {}, port: 0, host: "127.0.0.1", sweep });
    return runner.port;
  }
  const pw = (env: Record<string, string> = {}) => ({ command: "playwright", args: [], cwd: s.root, env });
  const exitOf = (ev: RunEvent[]) => ev.find((e) => e.type === "exit");

  it("sweeps before and after every run, never during one, with runs strictly one at a time", async () => {
    const order = join(s.base, "order");
    const port = await start(() => {
      appendFileSync(order, "sweep\n");
      return { clean: true, left: [] };
    });
    const replies = await Promise.all([1, 2, 3].map(() => postRun(port, pw({ FAKE_MODE: "span", FAKE_OUT: order }))));
    for (const r of replies) expect(exitOf(r.events)).toMatchObject({ code: 0 });
    expect(readFileSync(order, "utf8").trim().split("\n")).toEqual([
      "sweep", "start", "end", "sweep",
      "sweep", "start", "end", "sweep",
      "sweep", "start", "end", "sweep",
    ]);
  });

  it("has swept by the time the client hears the exit", async () => {
    let sweeps = 0;
    const port = await start(() => {
      sweeps++;
      return { clean: true, left: [] };
    });
    await postRun(port, pw({ FAKE_MODE: "exit:0" }));
    expect(sweeps).toBe(2);
  });

  it("a detached process and a double fork are gone when the client hears the exit, whatever the run's code", async () => {
    const port = await start(scopedSweep);
    for (const code of [0, 1]) {
      const r = await postRun(port, pw({ FAKE_MODE: "plant", FAKE_MARK: marker, FAKE_CODE: String(code), FAKE_OUT: join(s.base, "planted") }));
      expect(existsSync(join(s.base, "planted"))).toBe(true);
      expect(exitOf(r.events)).toMatchObject({ code });
      expect(marked()).toEqual([]);
    }
  });

  it("a later honest failing run exits 1 and a later honest passing run exits 0", async () => {
    const port = await start(scopedSweep);
    await postRun(port, pw({ FAKE_MODE: "plant", FAKE_MARK: marker, FAKE_CODE: "0", FAKE_OUT: join(s.base, "planted") }));
    expect(exitOf((await postRun(port, pw({ FAKE_MODE: "exit:1" }))).events)).toMatchObject({ code: 1, outcome: "exited" });
    expect(exitOf((await postRun(port, pw({ FAKE_MODE: "exit:0" }))).events)).toMatchObject({ code: 0, outcome: "exited" });
  });

  it("when the sweep cannot finish, the run is refused with sweep_failed and never starts", async () => {
    const out = join(s.base, "out");
    const port = await start(() => ({ clean: false, left: [7] }));
    const r = await postRun(port, pw({ FAKE_MODE: "dump", FAKE_OUT: out }));
    expect(r.events.find((e) => e.type === "refused")).toMatchObject({ code: "sweep_failed" });
    expect(exitOf(r.events)).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });

  it("a sweep failing after a run keeps later runs from reporting anything, until a sweep succeeds", async () => {
    const results = [true, false, false, true, true];
    const port = await start(() => ({ clean: results.shift()!, left: [] }));
    const first = await postRun(port, pw({ FAKE_MODE: "exit:1" }));
    expect(exitOf(first.events)).toMatchObject({ code: 1 });
    expect(first.events.some((e) => e.type === "output" && String(e.data).includes("could not end every process"))).toBe(true);
    const second = await postRun(port, pw({ FAKE_MODE: "exit:0" }));
    expect(second.events.find((e) => e.type === "refused")).toMatchObject({ code: "sweep_failed" });
    expect(exitOf(second.events)).toBeUndefined();
    expect(exitOf((await postRun(port, pw({ FAKE_MODE: "exit:0" }))).events)).toMatchObject({ code: 0 });
  });

  it("a queued run behind a failed sweep is refused too, and the queue does not stall", async () => {
    let clean = true;
    const port = await start(() => ({ clean, left: [] }));
    const running = postRun(port, pw({ FAKE_MODE: "span", FAKE_OUT: join(s.base, "o") }));
    await waitFor(() => existsSync(join(s.base, "o")));
    clean = false;
    const queued = await postRun(port, pw({ FAKE_MODE: "exit:0" }));
    expect(queued.events.find((e) => e.type === "refused")).toMatchObject({ code: "sweep_failed" });
    await running;
  });

  it("the literal client turns sweep_failed into exit 125", async () => {
    const port = await start(() => ({ clean: false, left: [7] }));
    const child = spawn(process.execPath, [resolve("bin/runner-client.mjs"), "--cwd", s.root, "playwright"], {
      env: { ...process.env, DEBUG_RUNNER_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((res) => child.on("close", res));
    expect(code).toBe(125);
    expect(stderr).toContain("sweep_failed");
  });
});

describe("the real kill only exists under the image's init", () => {
  function startIndex(args: string[], env: Record<string, string> = {}) {
    const configFile = join(s.base, "runner.json");
    writeFileSync(configFile, JSON.stringify({ project: "test", roots: [s.root], resultsDir: s.results, playwright: { bin: resolve("tests/fixtures/runner/fake-playwright.mjs") } }));
    return spawnSync(args[0]!, args.slice(1), {
      env: { ...process.env, RUNNER_CONFIG: configFile, RUNNER_PORT: "0", RUNNER_HOST: "127.0.0.1", ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
  }
  const index = resolve("src/runner/index.ts");
  const ts = ["--experimental-strip-types", "--no-warnings"];

  it("containerSweep gives nothing to call here, where it would kill every process of this user", () => {
    expect(containerSweep()).toBeNull();
  });

  it("the service started here refuses to start, and kills nothing", () => {
    const r = startIndex([process.execPath, "--disable-sigusr1", ...ts, index]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("refused_to_start");
    expect(r.stdout).toContain("tini");
  });

  it("the image's start command reaches that check, so it carries the flags the service wants", () => {
    const r = startIndex(["sh", resolve("bin/runner-start")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("tini");
    expect(r.stdout).not.toContain("disable-sigusr1");
  });

  describe("--disable-sigusr1", () => {
    it("a start without the flag is refused, even with the sweep off", () => {
      const r = startIndex([process.execPath, ...ts, index], { RUNNER_PROCESS_SWEEP: "off" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("refused_to_start");
      expect(r.stdout).toContain("--disable-sigusr1");
    });

    it("the image's start command is executable, carries the flag, and replaces the shell so the runner stays under init", () => {
      expect(statSync("bin/runner-start").mode & 0o111).not.toBe(0);
      const text = readFileSync("bin/runner-start", "utf8");
      expect(text).toMatch(/^exec node .*--disable-sigusr1 /m);
    });

    it("the image holds that file", () => {
      expect(readFileSync("Dockerfile", "utf8")).toMatch(/^COPY bin \.\/bin$/m);
      expect(readFileSync(".dockerignore", "utf8")).not.toMatch(/^bin\b/m);
    });

    it("SIGUSR1 opens no inspector on a process started that way", async () => {
      const child = spawn(process.execPath, ["--disable-sigusr1", "--inspect-port=0", "-e", `console.log("up"); ${FOREVER}`, marker], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      await new Promise((res) => child.stdout.once("data", res));
      child.kill("SIGUSR1");
      await new Promise((r) => setTimeout(r, 400));
      expect(child.exitCode).toBeNull();
      expect(stderr).not.toContain("Debugger listening");
      child.kill("SIGKILL");
    });
  });
});

it("a survivor is what these tests kill: without a sweep it stays alive", async () => {
  // The control for the tests above: the runner alone leaves a double fork running.
  runner = await startRunner(s.config(), { log: () => {}, port: 0, host: "127.0.0.1" });
  await postRun(runner.port, { command: "playwright", args: [], cwd: s.root, env: { FAKE_MODE: "plant", FAKE_MARK: marker, FAKE_CODE: "0", FAKE_OUT: join(s.base, "planted") } });
  expect(await waitFor(() => marked().length > 0)).toBe(true);
});
