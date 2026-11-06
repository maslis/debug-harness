#!/usr/bin/env node
// Client for the debug-harness test runner. One file, Node's standard library
// only: it needs no project, no image copy and no `debug` CLI. Get it from the
// runner itself:
//   curl -sf http://runner:3940/client.mjs -o /tmp/runner-client.mjs && node /tmp/runner-client.mjs --cwd /work -e BASE_URL=http://web:4321 playwright tests/a.spec.ts --workers=1
//
// Exit code: the run's own; 128+n if a signal killed it; 124 at the runner's
// time limit; 125 if it never ran or the result was lost (refused, unreachable,
// connection cut); 2 on bad usage.
import { request } from "node:http";
import { constants } from "node:os";
import { resolve } from "node:path";

const RUNNER_URL = process.env.DEBUG_RUNNER_URL ?? "http://runner:3940";
const NOT_RUN = 125;
const TIMED_OUT = 124;

function exitCodeOf(e) {
  if (e.outcome === "timeout") {
    console.error("runner-client: timeout, the runner stopped this run at its limit");
    return TIMED_OUT;
  }
  if (e.outcome === "spawn_failed") {
    console.error("runner-client: the runner could not start the command");
    return NOT_RUN;
  }
  if (e.code !== null) return e.code;
  console.error(`runner-client: the run was killed by ${e.signal}`);
  const n = constants.signals[e.signal];
  return n === undefined ? NOT_RUN : 128 + n;
}

function parseArgs(args) {
  const env = {};
  let cwd = process.cwd();
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1] !== undefined) {
      cwd = resolve(args[++i]);
    } else if (args[i] === "-e" && args[i + 1] !== undefined) {
      const pair = args[++i];
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? process.env[name] : pair.slice(eq + 1);
      if (value !== undefined) env[name] = value;
    } else {
      break;
    }
  }
  const command = args[i];
  if (command !== "playwright" && command !== "script") return null;
  // Everything after the command is the run's own, untouched.
  return { command, args: args.slice(i + 1), cwd, env };
}

function run(body) {
  return new Promise((done) => {
    let exitCode = null;
    const notRun = (reason) => {
      console.error(`runner-client: ${reason}`);
      done(NOT_RUN);
    };
    const onEvent = (e) => {
      if (e.type === "output") (e.stream === "stderr" ? process.stderr : process.stdout).write(e.data);
      else if (e.type === "queued") console.error(`runner-client: waiting, position ${e.position}`);
      else if (e.type === "started") console.error(`runner-client: results in ${e.resultsDir}`);
      else if (e.type === "refused") notRun(`refused, ${e.code}: ${e.message}`);
      else if (e.type === "exit") exitCode = exitCodeOf(e);
    };
    // node:http, not fetch: fetch gives up on a body silent for 5 minutes, and a
    // quiet test is not a dead one. Leaving this process drops the connection,
    // which is what tells the runner to kill the run.
    const req = request(`${RUNNER_URL}/run`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      if (res.statusCode !== 200) {
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let detail = `HTTP ${res.statusCode}`;
          try {
            const { error } = JSON.parse(buf);
            detail = `${error.code}: ${error.message}`;
          } catch {
            // Not one of the runner's answers: the status is all there is.
          }
          notRun(`refused, ${detail}`);
        });
        return;
      }
      res.on("data", (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onEvent(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      });
      // No exit event means nobody knows the result, which must never read as success.
      const end = () => (exitCode === null ? notRun("lost the runner before the run ended") : done(exitCode));
      res.on("end", end);
      res.on("error", end);
    });
    req.on("error", () => notRun(`cannot reach the runner at ${RUNNER_URL}`));
    req.end(JSON.stringify(body));
  });
}

const body = parseArgs(process.argv.slice(2));
if (!body) {
  console.error("usage: runner-client.mjs [-e NAME[=VALUE]]... [--cwd <dir>] <playwright|script> [args]");
  process.exit(2);
}
process.exit(await run(body));
