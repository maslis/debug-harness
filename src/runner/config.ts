import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";

/** The flags the runner knows how to check. A project picks from these; it cannot add to them. */
export const KNOWN_FLAGS = ["--workers", "--browser", "--grep", "--project", "--reporter", "--retries", "--output"] as const;

const AbsolutePath = z.string().refine(isAbsolute, "must be an absolute path");

const EnvPattern = z.string().refine((p) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

export const RunnerConfigSchema = z
  .object({
    project: z.string().min(1),
    /** Where a run may start. List each path the project is mounted at. */
    roots: z.array(AbsolutePath).min(1),
    /** Folders whose direct children are worktrees, each one a root of its own. */
    worktreeRoots: z.array(AbsolutePath).default([]),
    /** The only place the runner writes. Must be a writable mount. */
    resultsDir: AbsolutePath,
    /** Env names a request may set, as regular expressions matched against the whole name. */
    allowedEnv: z.array(EnvPattern).default([]),
    /** Env every run starts with; a request may override a name it is allowed to set. */
    defaultEnv: z.record(z.string()).default({}),
    playwright: z
      .object({
        bin: AbsolutePath.default("/app/node_modules/.bin/playwright"),
        /** Relative to the run's root. */
        config: z.string().default("playwright.config.ts"),
        flags: z.array(z.enum(KNOWN_FLAGS)).default([...KNOWN_FLAGS]),
      })
      .strict()
      .default({}),
    /** `node <dir>/*.mjs`, relative to the run's root. Off unless set. */
    scripts: z.object({ dir: z.string().min(1) }).strict().optional(),
    /** Each run's TMPDIR and HOME live in a folder made here and removed when the run ends. */
    scratchDir: AbsolutePath.default(tmpdir()),
    /**
     * Folders emptied after every run, for what a run writes at a fixed path
     * instead of under TMPDIR. Only for a container that does nothing else.
     */
    sweepDirs: z.array(AbsolutePath).default([]),
    /** The one limit per run, counted from its start. */
    timeoutMs: z.number().int().positive().default(30 * 60_000),
    /** How long a killed run gets between SIGTERM and SIGKILL. */
    killGraceMs: z.number().int().nonnegative().default(5_000),
    /** How many requests may wait behind the running one. */
    maxQueue: z.number().int().nonnegative().default(8),
    /** How many run folders stay under `<resultsDir>/runner`. */
    keepRuns: z.number().int().positive().default(20),
    /** File names reported by /health and at startup when a run could read them. */
    secretFiles: z.array(z.string()).default([".env", ".dev.vars"]),
  })
  .strict();

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export function loadRunnerConfig(path: string): RunnerConfig {
  return RunnerConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
