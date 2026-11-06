import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunnerConfig } from "./config.ts";

export type RefusalCode =
  | "bad_request"
  | "cwd_outside_root"
  | "path_outside_root"
  | "path_not_found"
  | "config_not_found"
  | "flag_not_allowed"
  | "flag_bad_value"
  | "output_outside_results"
  | "output_would_wipe"
  | "env_not_allowed"
  | "scripts_disabled"
  | "script_not_allowed"
  | "script_not_found";

export interface Refusal {
  refused: RefusalCode;
  /** For the client. May echo what the client sent, so it never goes in the log. */
  message: string;
}

export interface ResolvedRun {
  command: "playwright" | "script";
  cwd: string;
  root: string;
  configPath: string;
  flags: string[];
  specs: string[];
  scriptPath: string;
  scriptArgs: string[];
  env: Record<string, string>;
  /** The arguments as they may appear in the log: no values. */
  logArgs: string[];
}

const BUILTIN_REPORTERS = new Set(["list", "line", "dot", "json", "junit", "html", "null"]);
const notEmpty = (v: string): boolean => v !== "";
/** A count past this is a typo or an attack: one run on a memory-capped container. */
const MAX_WORKERS = 16;

function isWorkerCount(v: string): boolean {
  const match = /^([1-9][0-9]*)(%?)$/.exec(v);
  return match !== null && Number(match[1]) <= (match[2] ? 100 : MAX_WORKERS);
}

const FLAG_VALUE_RULES: Record<string, (v: string) => boolean> = {
  "--workers": isWorkerCount,
  "--browser": (v) => ["chromium", "firefox", "webkit", "all"].includes(v),
  "--grep": notEmpty,
  "--project": notEmpty,
  // A reporter that is not built in is a path to code, so only the names pass.
  "--reporter": (v) => v.split(",").every((r) => BUILTIN_REPORTERS.has(r)),
  "--retries": (v) => /^[0-9]+$/.test(v),
  // Checked by checkOutput, which also needs the cwd.
  "--output": notEmpty,
};

const FLAG_ALIASES: Record<string, string> = { "-g": "--grep", "-j": "--workers" };

/** Never settable, whatever the project's patterns say. */
const ENV_NEVER = /^(NODE_OPTIONS|NODE_PATH|PATH|HOME|LD_.*|DYLD_.*)$/;
/** Settable only when the project lists the exact name. */
const ENV_ONLY_IF_NAMED = /^(PLAYWRIGHT_.*|PW_.*|PWTEST_.*|PWDEBUG)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function refuse(refused: RefusalCode, message: string): Refusal {
  return { refused, message };
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** The worktree or project root that holds this real path. */
function findRoot(config: RunnerConfig, realCwd: string): string | null {
  for (const wt of config.worktreeRoots) {
    const realWt = realpathOrNull(wt);
    if (realWt && realCwd !== realWt && isInside(realWt, realCwd)) {
      return join(realWt, relative(realWt, realCwd).split(sep)[0]!);
    }
  }
  for (const root of config.roots) {
    const realRoot = realpathOrNull(root);
    if (realRoot && isInside(realRoot, realCwd)) return realRoot;
  }
  return null;
}

/** A path that need not exist yet: real up to its deepest existing folder, literal after that. */
function realpathOfNew(p: string): string {
  const real = realpathOrNull(p);
  if (real) return real;
  const parent = dirname(p);
  return parent === p ? p : join(realpathOfNew(parent), basename(p));
}

/**
 * Playwright empties its output folder when a run starts, so "under the results
 * folder" is not enough: the folder also has to be one it is safe to empty.
 */
function checkOutput(config: RunnerConfig, value: string, cwd: string): string | Refusal {
  const target = resolve(cwd, value);
  const results = realpathOfNew(config.resultsDir);
  const real = realpathOfNew(target);
  if (!isInside(results, real)) return refuse("output_outside_results", `--output must be under ${config.resultsDir}`);
  const wipe = (why: string): Refusal => refuse("output_would_wipe", `--output ${value}: Playwright empties this folder, and ${why}`);
  if (real === results) return wipe("it is the whole results folder");
  if (isInside(join(results, "runner"), real)) return wipe("it holds the runner's own run folders");
  if (existsSync(real)) {
    if (!statSync(real).isDirectory()) return wipe("it is a file");
    const entries = readdirSync(real);
    if (entries.length > 0 && !entries.includes(".last-run.json")) {
      return wipe("it is not an earlier Playwright output folder (no .last-run.json); choose another or empty it yourself");
    }
  }
  return real;
}

function checkEnv(config: RunnerConfig, env: Record<string, string>): Refusal | null {
  for (const name of Object.keys(env)) {
    const notAllowed = refuse("env_not_allowed", `env name ${ENV_NAME.test(name) ? name : "<malformed>"} is not allowed`);
    if (!ENV_NAME.test(name) || ENV_NEVER.test(name)) return notAllowed;
    if (ENV_ONLY_IF_NAMED.test(name)) {
      if (!config.allowedEnv.includes(name)) return notAllowed;
      continue;
    }
    if (!config.allowedEnv.some((p) => new RegExp(`^(?:${p})$`).test(name))) return notAllowed;
  }
  return null;
}

function parsePlaywrightArgs(
  config: RunnerConfig,
  args: string[],
  cwd: string,
  root: string,
): { flags: string[]; specs: string[] } | Refusal {
  const flags: string[] = [];
  const specs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      const spec = checkSpec(arg, cwd, root);
      if (typeof spec !== "string") return spec;
      specs.push(spec);
      continue;
    }
    const eq = arg.indexOf("=");
    const given = eq === -1 ? arg : arg.slice(0, eq);
    const name = FLAG_ALIASES[given] ?? given;
    const rule = FLAG_VALUE_RULES[name];
    if (!rule || !(config.playwright.flags as string[]).includes(name)) {
      return refuse("flag_not_allowed", `flag ${given} is not allowed`);
    }
    // Written back as --name=value, so a value can never be read as a flag.
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || !rule(value)) return refuse("flag_bad_value", `bad value for ${name}`);
    if (name === "--output") {
      const output = checkOutput(config, value, cwd);
      if (typeof output !== "string") return output;
      flags.push(`--output=${output}`);
      continue;
    }
    flags.push(`${name}=${value}`);
  }
  return { flags, specs };
}

function checkSpec(arg: string, cwd: string, root: string): string | Refusal {
  // Each of these terminators stops the "." below, so the regex would find no match.
  if (/[\n\r\u2028\u2029]/.test(arg)) return refuse("bad_request", "a spec argument cannot hold a line break");
  const match = /^(.*?)(:[0-9]+(?::[0-9]+)?)?$/.exec(arg)!;
  const path = match[1]!;
  // No file means the cwd, and that means the whole suite.
  if (path === "") return refuse("bad_request", "a spec argument must name a file");
  const target = resolve(cwd, path);
  if (!isInside(root, target)) return refuse("path_outside_root", `${arg} is outside ${root}`);
  const real = realpathOrNull(target);
  if (real === null) return refuse("path_not_found", `${arg} does not exist`);
  if (!isInside(root, real)) return refuse("path_outside_root", `${arg} leads outside ${root}`);
  return (relative(cwd, target) || ".") + (match[2] ?? "");
}

function checkScript(scriptsDir: string, cwd: string, arg: string | undefined): string | Refusal {
  const notAllowed = refuse("script_not_allowed", `only ${scriptsDir}/*.mjs may run`);
  if (!arg || arg.startsWith("-") || !arg.endsWith(".mjs")) return notAllowed;
  const target = resolve(cwd, arg);
  if (dirname(target) !== scriptsDir) return notAllowed;
  const real = realpathOrNull(target);
  if (real === null) return refuse("script_not_found", `${arg} does not exist`);
  if (dirname(real) !== realpathOrNull(scriptsDir)) return notAllowed;
  return target;
}

const hasNul = (s: string): boolean => s.includes("\0");

/** Checks one request against the project's config. Touches nothing, starts nothing. */
export function resolveRun(config: RunnerConfig, raw: unknown): ResolvedRun | Refusal {
  const badRequest = refuse("bad_request", "expected { command, args: string[], cwd, env?: {name: string} }");
  if (typeof raw !== "object" || raw === null) return badRequest;
  const { command, args, cwd, env = {} } = raw as Record<string, unknown>;
  if (command !== "playwright" && command !== "script") return badRequest;
  if (typeof cwd !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return badRequest;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return badRequest;
  const argv = args as string[];
  const envMap = env as Record<string, string>;
  if (!Object.values(envMap).every((v) => typeof v === "string")) return badRequest;
  if (hasNul(cwd) || argv.some(hasNul) || Object.values(envMap).some(hasNul)) return badRequest;

  const realCwd = isAbsolute(cwd) ? realpathOrNull(cwd) : null;
  const root = realCwd && findRoot(config, realCwd);
  if (!realCwd || !root) return refuse("cwd_outside_root", `cwd ${cwd} is outside the project`);

  const envRefusal = checkEnv(config, envMap);
  if (envRefusal) return envRefusal;

  const base = { cwd: realCwd, root, env: envMap, configPath: "", flags: [], specs: [], scriptPath: "", scriptArgs: [] };

  if (command === "script") {
    if (!config.scripts) return refuse("scripts_disabled", `scripts are off for ${config.project}`);
    const scriptPath = checkScript(join(root, config.scripts.dir), realCwd, argv[0]);
    if (typeof scriptPath !== "string") return scriptPath;
    const scriptArgs = argv.slice(1);
    return { ...base, command, scriptPath, scriptArgs, logArgs: [relative(root, scriptPath), `+${scriptArgs.length} args`] };
  }

  const parsed = parsePlaywrightArgs(config, argv, realCwd, root);
  if ("refused" in parsed) return parsed;
  const configPath = join(root, config.playwright.config);
  const realConfig = realpathOrNull(configPath);
  if (!realConfig || !isInside(root, realConfig)) return refuse("config_not_found", `no ${config.playwright.config} in ${root}`);
  const logArgs = [...parsed.specs, ...parsed.flags.map((f) => `${f.slice(0, f.indexOf("="))}=<hidden>`)];
  return { ...base, command, configPath, flags: parsed.flags, specs: parsed.specs, logArgs };
}
