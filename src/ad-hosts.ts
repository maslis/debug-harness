export const DEFAULT_AD_HOSTS: readonly string[] = [
  "googlesyndication.com",
  "pagead2.googlesyndication.com",
  "doubleclick.net",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adservice.google.com",
  "adsbygoogle",
  "fundingchoicesmessages.google.com",
] as const;

export function isAdHost(hostname: string, blocklist: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return blocklist.some((pattern) => {
    const p = pattern.toLowerCase();
    return h === p || h.endsWith(`.${p}`) || h.includes(p);
  });
}

export function buildAdHostMatcher(blocklist: readonly string[]): (url: string) => boolean {
  return (url: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return isAdHost(parsed.hostname, blocklist);
  };
}
