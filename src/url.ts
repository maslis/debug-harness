const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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
