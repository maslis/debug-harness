import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

/** The cap on one sweep. A process dies within milliseconds of SIGKILL unless it is stuck in the kernel. */
const SWEEP_LIMIT_MS = 3_000;
const SCAN_PAUSE_MS = 10;

export interface SweepResult {
  clean: boolean;
  left: number[];
}

export type Sweep = () => SweepResult;

/** Every process still doing anything, except pid 1 and this one. A zombie is already dead, and init reaps it. */
export function otherLiveProcesses(): number[] {
  const live: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === 1 || pid === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The command name may hold spaces and parens; the state comes right after the last ")".
      const state = stat.charAt(stat.lastIndexOf(")") + 2);
      if (state !== "Z" && state !== "X") live.push(pid);
    } catch {
      // The process ended while we were reading.
    }
  }
  return live;
}

/**
 * Kill, then scan, until a scan finds nothing or the cap is reached. It blocks on purpose:
 * nothing can start or be answered while it runs, so it can never overlap a run.
 * The first kill comes before any scan: a zombie leader can still have live threads.
 */
export function sweepUntilEmpty(killAll: () => void, list: () => number[], limitMs = SWEEP_LIMIT_MS): SweepResult {
  const deadline = Date.now() + limitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    killAll();
    Atomics.wait(pause, 0, 0, SCAN_PAUSE_MS);
    let left: number[] | null;
    try {
      left = list();
    } catch {
      // Not being able to look is not the same as finding nothing.
      left = null;
    }
    if (left?.length === 0) return { clean: true, left: [] };
    if (Date.now() >= deadline) return { clean: false, left: left ?? [] };
  }
}

/**
 * The real sweep, or null unless this process sits directly under the image's tini as pid 1.
 * kill(-1) reaches everything this user may signal in the pid namespace, except pid 1 and the
 * caller, in one step a fork cannot outrun. Outside the runner's own container that would be
 * every process of this user, so no other place can get hold of it.
 */
export function containerSweep(): Sweep | null {
  let init: string;
  try {
    init = readFileSync("/proc/1/cmdline", "utf8").split("\0")[0]!;
  } catch {
    return null;
  }
  if (process.ppid !== 1 || basename(init) !== "tini") return null;
  const killAll = (): void => {
    try {
      process.kill(-1, "SIGKILL");
    } catch {
      // ESRCH: nobody else is left to signal.
    }
  };
  return () => sweepUntilEmpty(killAll, otherLiveProcesses);
}
