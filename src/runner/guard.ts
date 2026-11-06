/**
 * What an error may say in the log: its type and where it happened. Its message
 * can repeat what a client sent, and that never goes in the log.
 */
export function errorForLog(err: unknown): { error: string; frames: string[] } {
  if (!(err instanceof Error)) return { error: typeof err, frames: [] };
  return { error: err.name, frames: (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).map((l) => l.trim()) };
}

/**
 * The last line of defence: whatever a request manages to throw, the service stays
 * up for the next one. Installed only once the service listens, so a bad config
 * or a taken port still stops it at startup.
 */
export function installProcessGuard(log: (line: string) => void): void {
  const report = (kind: string) => (err: unknown): void => {
    log(JSON.stringify({ ts: new Date().toISOString(), event: "uncaught", kind, ...errorForLog(err) }));
  };
  process.on("uncaughtException", report("exception"));
  process.on("unhandledRejection", report("rejection"));
}
