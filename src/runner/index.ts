import { loadRunnerConfig } from "./config.ts";
import { installProcessGuard } from "./guard.ts";
import { findReadableSecretFiles, startRunner } from "./server.ts";

const config = loadRunnerConfig(process.env.RUNNER_CONFIG ?? "/etc/debug-harness/runner.json");
const log = (line: string): void => void process.stdout.write(`${line}\n`);

const runner = await startRunner(config, {
  log,
  // Not PORT: the image sets that for the harness server.
  port: Number(process.env.RUNNER_PORT ?? 3940),
  host: process.env.RUNNER_HOST ?? "0.0.0.0",
});

installProcessGuard(log);

// Names here: this log is only for whoever can read the container's logs. /health gives a count.
const secrets = findReadableSecretFiles(config);
log(JSON.stringify({ event: "listening", project: config.project, port: runner.port, readableSecretFiles: secrets }));

const shutdown = async (): Promise<void> => {
  await runner.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
