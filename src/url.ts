import { existsSync } from "node:fs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when running inside a Docker container (/.dockerenv exists or DOCKER=1 is set). */
export function isInDocker(): boolean {
  return process.env["DOCKER"] === "1" || existsSync("/.dockerenv");
}

export function rewriteLocalhost(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  if (LOCAL_HOSTS.has(u.hostname)) {
    u.hostname = "host.docker.internal";
    return u.toString();
  }
  return input;
}
