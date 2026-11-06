import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerConfig } from "./config.ts";
import { resolveRun, type ResolvedRun } from "./validate.ts";

const MAX_BODY_BYTES = 1_000_000;
/** What a child takes from the runner's own environment. Everything else stays behind. */
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH"];
const PIN_HOOK = fileURLToPath(new URL("./pin-playwright.mjs", import.meta.url));
const CLIENT_FILE = fileURLToPath(new URL("../../bin/runner-client.mjs", import.meta.url));
/** After a run exits, how long its output pipes may stay open before they are cut. */
const PIPE_DRAIN_MS = 1_000;

export interface RunnerOptions {
  log: (line: string) => void;
  port: number;
  host: string;
}

export interface RunnerHandle {
  port: number;
  close: () => Promise<void>;
}

interface Waiting {
  raw: unknown;
  res: ServerResponse;
  left: boolean;
}

interface LogEntry {
  command: string;
  outcome: string;
  [k: string]: unknown;
}

function send(res: ServerResponse, event: object): boolean {
  if (res.destroyed || res.writableEnded) return true;
  return res.write(`${JSON.stringify(event)}\n`);
}

function replyError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function readProcTable(): Map<number, { ppid: number; start: string }> {
  const table = new Map<number, { ppid: number; start: string }>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The command name may hold spaces and parens; the fields after the last ")" are fixed.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { ppid: Number(fields[1]), start: fields[19]! });
    } catch {
      // The process ended while we were reading.
    }
  }
  return table;
}

/** Every process below `pid`, with its start time so a recycled pid is never signalled. */
function descendantsOf(pid: number): Map<number, string> {
  const table = readProcTable();
  const found = new Map<number, string>();
  const pending = [pid];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const [p, info] of table) {
      if (info.ppid === parent && !found.has(p)) {
        found.set(p, info.start);
        pending.push(p);
      }
    }
  }
  return found;
}

function signalQuietly(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // Already gone.
  }
}

/** Everything `/health` warns about: secret-named files a run could read right now. */
export function findReadableSecretFiles(config: RunnerConfig): string[] {
  const dirs = [...config.roots];
  for (const wt of config.worktreeRoots) {
    try {
      for (const d of readdirSync(wt, { withFileTypes: true })) if (d.isDirectory()) dirs.push(join(wt, d.name));
    } catch {
      // No worktree folder here.
    }
  }
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of config.secretFiles) {
      const file = join(dir, name);
      try {
        // A mask (a mount of /dev/null) is not a regular file.
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.R_OK);
        found.push(file);
      } catch {
        // Absent or unreadable: nothing to report.
      }
    }
  }
  return found;
}

function imagePlaywrightVersion(config: RunnerConfig): string | null {
  try {
    const pkg = join(dirname(config.playwright.bin), "..", "playwright", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return null;
  }
}

export async function startRunner(config: RunnerConfig, options: RunnerOptions): Promise<RunnerHandle> {
  const queue: Waiting[] = [];
  let active: { stop: (reason: string) => void; finished: Promise<void> } | null = null;
  let runCounter = 0;
  let closing = false;

  const log = (entry: LogEntry): void => options.log(JSON.stringify({ ts: new Date().toISOString(), project: config.project, ...entry }));
  const commandName = (raw: unknown): string => {
    const c = (raw as { command?: unknown } | null)?.command;
    return c === "playwright" || c === "script" ? c : "unknown";
  };

  /** A fresh run folder under the results folder; older ones past the limit go. */
  function makeRunDir(): string {
    const runs = join(config.resultsDir, "runner");
    mkdirSync(runs, { recursive: true });
    const name = `${String(Date.now())}-${String(++runCounter).padStart(4, "0")}`;
    const dir = join(runs, name);
    mkdirSync(dir);
    const all = readdirSync(runs).sort();
    for (const old of all.slice(0, Math.max(0, all.length - config.keepRuns))) {
      rmSync(join(runs, old), { recursive: true, force: true });
    }
    return dir;
  }

  /**
   * The throwaway part of a run: what a one-shot container would lose with it.
   * The browser profile and transform cache follow TMPDIR, ~/.npm and friends follow HOME.
   */
  function makeScratch(): { dir: string; tmp: string; home: string } {
    const dir = mkdtempSync(join(config.scratchDir, "runner-run-"));
    const tmp = join(dir, "tmp");
    const home = join(dir, "home");
    mkdirSync(tmp);
    mkdirSync(home);
    return { dir, tmp, home };
  }

  function removeScratch(scratchDir: string): void {
    rmSync(scratchDir, { recursive: true, force: true });
    for (const dir of config.sweepDirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  function buildSpawn(
    run: ResolvedRun,
    runDir: string,
    scratch: { tmp: string; home: string },
  ): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = {};
    for (const name of INHERITED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, config.defaultEnv, run.env, { TMPDIR: scratch.tmp, HOME: scratch.home });
    if (run.command === "script") {
      return { file: process.execPath, args: [run.scriptPath, ...run.scriptArgs], env };
    }
    // Set last: these keep every report inside the run folder and are not the request's to change.
    Object.assign(env, {
      NODE_OPTIONS: `--import=${PIN_HOOK}`,
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(runDir, "report.json"),
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(runDir, "junit.xml"),
      PLAYWRIGHT_HTML_OUTPUT_DIR: join(runDir, "html"),
      PLAYWRIGHT_HTML_OPEN: "never",
    });
    const reporter = run.flags.some((f) => f.startsWith("--reporter=")) ? [] : ["--reporter=list,json"];
    const output = run.flags.some((f) => f.startsWith("--output=")) ? [] : [`--output=${join(runDir, "output")}`];
    return {
      file: config.playwright.bin,
      args: ["test", `--config=${run.configPath}`, ...output, ...reporter, ...run.flags, ...run.specs],
      env,
    };
  }

  function startNext(): void {
    if (active || closing) return;
    let next: Waiting | undefined;
    while ((next = queue.shift())) {
      if (next.left) continue;
      const stream = next;
      // Checked again: while it waited, its files may have changed.
      const run = resolveRun(config, stream.raw);
      if ("refused" in run) {
        log({ command: commandName(stream.raw), outcome: "refused", refused: run.refused });
        send(stream.res, { type: "refused", code: run.refused, message: run.message });
        stream.res.end();
        continue;
      }
      let runDir: string;
      let scratch: { dir: string; tmp: string; home: string };
      try {
        runDir = makeRunDir();
        scratch = makeScratch();
      } catch {
        log({ command: run.command, outcome: "refused", refused: "results_not_writable" });
        send(stream.res, { type: "refused", code: "results_not_writable", message: `cannot write under ${config.resultsDir} or ${config.scratchDir}` });
        stream.res.end();
        continue;
      }
      active = launch(stream, run, runDir, scratch);
      return;
    }
  }

  function launch(
    waiting: Waiting,
    run: ResolvedRun,
    runDir: string,
    scratch: { dir: string; tmp: string; home: string },
  ): { stop: (reason: string) => void; finished: Promise<void> } {
    const { res } = waiting;
    const startedAt = Date.now();
    const plan = buildSpawn(run, runDir, scratch);
    let child: ChildProcess;
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((r) => (markFinished = r));
    let stopReason: string | null = null;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    // Playwright starts browsers in a session of their own, so the group alone does not reach them.
    let tracked = new Map<number, string>();

    const killTracked = (): void => {
      const now = readProcTable();
      for (const [pid, start] of tracked) if (now.get(pid)?.start === start) signalQuietly(pid, "SIGKILL");
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, failed?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(limitTimer);
      clearTimeout(graceTimer);
      const outcome = failed ?? stopReason ?? "exited";
      const durationMs = Date.now() - startedAt;
      // Before the exit event: when the client hears the run ended, nothing of it is left.
      removeScratch(scratch.dir);
      send(res, { type: "exit", code, signal, outcome, durationMs });
      res.end();
      log({
        command: run.command,
        args: run.logArgs,
        cwd: run.cwd,
        envNames: Object.keys(run.env),
        outcome,
        exit: code,
        signal,
        durationMs,
      });
      active = null;
      markFinished();
      startNext();
    };

    child = spawn(plan.file, plan.args, { cwd: run.cwd, env: plan.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    const stop = (reason: string): void => {
      if (stopReason || done) return;
      stopReason = reason;
      const pid = child.pid;
      if (pid === undefined) return;
      tracked = descendantsOf(pid);
      signalQuietly(-pid, "SIGTERM");
      graceTimer = setTimeout(() => {
        for (const [p, start] of descendantsOf(pid)) tracked.set(p, start);
        signalQuietly(-pid, "SIGKILL");
        killTracked();
      }, config.killGraceMs);
    };

    const limitTimer = setTimeout(() => stop("timeout"), config.timeoutMs);

    for (const [name, stream] of [["stdout", child.stdout!], ["stderr", child.stderr!]] as const) {
      stream.setEncoding("utf8");
      stream.on("data", (data: string) => {
        // A slow client slows the run instead of filling this process's memory.
        if (!send(res, { type: "output", stream: name, data })) {
          stream.pause();
          res.once("drain", () => stream.resume());
          res.once("close", () => stream.resume());
        }
      });
    }

    child.on("error", () => finish(null, null, "spawn_failed"));
    child.on("exit", (code, signal) => {
      if (child.pid !== undefined) signalQuietly(-child.pid, "SIGKILL");
      if (stopReason) killTracked();
      // A survivor holding the pipes must not hold the queue.
      const cut = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, PIPE_DRAIN_MS);
      child.once("close", () => {
        clearTimeout(cut);
        finish(code, signal);
      });
    });

    res.on("close", () => {
      if (!res.writableFinished) stop("client_dropped");
    });

    send(res, { type: "started", runId: runDir.slice(runDir.lastIndexOf("/") + 1), resultsDir: runDir });
    return { stop, finished };
  }

  function acceptRun(raw: unknown, res: ServerResponse): void {
    const command = commandName(raw);
    const run = resolveRun(config, raw);
    if ("refused" in run) {
      // The code only: the message may repeat what the client sent.
      log({ command, outcome: "refused", refused: run.refused });
      replyError(res, 400, run.refused, run.message);
      return;
    }
    if (active && queue.length >= config.maxQueue) {
      log({ command, outcome: "refused", refused: "queue_full" });
      replyError(res, 429, "queue_full", `${queue.length} runs are already waiting, try again later`);
      return;
    }
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const waiting: Waiting = { raw, res, left: false };
    if (active) {
      queue.push(waiting);
      send(res, { type: "queued", position: queue.length });
      res.on("close", () => {
        if (queue.includes(waiting)) {
          waiting.left = true;
          queue.splice(queue.indexOf(waiting), 1);
          log({ command, outcome: "left_queue" });
        }
      });
      return;
    }
    queue.push(waiting);
    startNext();
  }

  function handleRun(req: IncomingMessage, res: ServerResponse): void {
    // Any page a browser opens on this network can send a POST. Only an
    // Origin-less JSON request gets through, which a page cannot send without a preflight we never answer.
    if (req.headers.origin !== undefined) {
      log({ command: "unknown", outcome: "refused", refused: "origin_refused" });
      replyError(res, 403, "origin_refused", "browser requests are refused");
      req.resume();
      return;
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      log({ command: "unknown", outcome: "refused", refused: "not_json" });
      replyError(res, 415, "not_json", "content-type must be application/json");
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          log({ command: "unknown", outcome: "refused", refused: "body_too_large" });
          replyError(res, 413, "body_too_large", `body over ${MAX_BODY_BYTES} bytes`);
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        log({ command: "unknown", outcome: "refused", refused: "bad_request" });
        replyError(res, 400, "bad_request", "body is not JSON");
        return;
      }
      acceptRun(raw, res);
    });
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          project: config.project,
          running: active !== null,
          queued: queue.length,
          playwrightVersion: imagePlaywrightVersion(config),
          readableSecretFiles: findReadableSecretFiles(config),
        }),
      );
      return;
    }
    if (req.method === "GET" && path === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(CLIENT_FILE));
      return;
    }
    if (req.method === "POST" && path === "/run") {
      handleRun(req, res);
      return;
    }
    req.resume();
    replyError(res, 404, "not_found", "POST /run, GET /health or GET /client.mjs");
  });

  await new Promise<void>((res) => server.listen(options.port, options.host, res));

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      closing = true;
      for (const w of queue.splice(0)) w.res.destroy();
      const current = active;
      if (current) {
        current.stop("runner_stopped");
        await current.finished;
      }
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
