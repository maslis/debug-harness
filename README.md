# debug-harness

HTTP debug harness: point it at a URL, get back screenshots, DOM, console, network, computed styles, Core Web Vitals. Safe by default against accidental ad clicks.

## Quickstart

```bash
pnpm install
pnpm exec playwright install chromium --with-deps
pnpm build:vendor
debug up                                    # docker compose up -d
debug capture https://example.com
debug open <runId printed above>
```

## CLI

```
debug up | down | logs [-f]
debug health | devices
debug capture <url> [flags]
debug compare <local> <prod> [flags]
debug open <runId>
```

Flags: `--viewport WxH`, `--device "iPhone 13"`, `--actions <path|-|json>`, `--inspect "sel,sel"`, `--allow-ads`, `--block-host <h>`, `--settle <ms>`, `--run-id <name>`, `--header "Name: Value"` (repeatable, applied to every request), `--timeout <ms>`, `--json`, `--quiet`.

Custom headers are useful for bypassing upstream WAF/bot-fight rules in front of staging or prod sites — pick a header name your consumer project's firewall rule recognizes. The schema is generic; the harness does not know about any specific consumer header.

## HTTP API

Endpoints on port 3939: `GET /health`, `GET /devices`, `POST /capture`, `POST /compare`. See the design spec (link below) for full request/response schemas.

## Safety

- Default: ad-host blocklist (`googlesyndication.com`, `doubleclick.net`, ...) blocks requests at `page.route()` level.
- Always-on **click guard** refuses `click`/`hover`/`type` when the target (or any ancestor or enclosing iframe) is an ad slot. No opt-out.
- `op: "evaluate"` bypasses the guard by design — use deliberately.

## Limitations

- INP is synthetic (scripted interactions) — flag `synthetic: true` in `web-vitals.json`.
- LCP/CLS are mid-page values, not finalized.
- `op: "emulate"` mid-run only changes viewport; UA / deviceScaleFactor are context-level.

## Testing

```
pnpm test             # unit + integration (no external network)
pnpm test:watch
pnpm test:smoke       # hits example.com
```
