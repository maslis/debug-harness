import { loadRunnerConfig } from "./config.ts";
import { installProcessGuard } from "./guard.ts";
import { findReadableSecretFiles, startRunner } from "./server.ts";
import { containerSweep } from "./sweep.ts";
import { replaceableBin } from "./validate.ts";

const config = loadRunnerConfig(process.env.RUNNER_CONFIG ?? "/etc/debug-harness/runner.json");
const log = (line: string): void => void process.stdout.write(`${line}\n`);

const refuseToStart = (reason: string): never => {
  log(JSON.stringify({ event: "refused_to_start", reason }));
  process.exit(1);
};

const replaceableIn = replaceableBin(config);
if (replaceableIn !== null) refuseToStart(`playwright.bin is under ${replaceableIn}, which a run or a worker can write`);

// Not left to each compose block: without it a spec can open an inspector into this process and fake every later result.
if (!process.execArgv.includes("--disable-sigusr1")) refuseToStart("started without --disable-sigusr1; use the image's /app/bin/runner-start");

// Off only for this repo's own tests, which start the service beside everything else.
const sweepOff = process.env.RUNNER_PROCESS_SWEEP === "off";
const sweep = sweepOff ? undefined : (containerSweep() ?? refuseToStart("the runner kills every other process between runs, so it only starts directly under the image's tini as pid 1"));

const runner = await startRunner(config, {
  log,
  // Not PORT: the image sets that for the harness server.
  port: Number(process.env.RUNNER_PORT ?? 3940),
  host: process.env.RUNNER_HOST ?? "0.0.0.0",
  sweep,
});

installProcessGuard(log);

// Names here: this log is only for whoever can read the container's logs. /health gives a count.
const secrets = findReadableSecretFiles(config);
log(JSON.stringify({ event: "listening", project: config.project, port: runner.port, processSweep: !sweepOff, readableSecretFiles: secrets }));

const shutdown = async (): Promise<void> => {
  await runner.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
