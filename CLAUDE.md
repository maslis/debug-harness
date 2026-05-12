# debug-harness — AI guide

HTTP harness for browser-driven debugging, performance auditing, and durable e2e testing.
Captures rich page state, runs Lighthouse audits, executes Playwright test specs from
consumer projects — all against the same Chromium instance in Docker.

Published image: `ghcr.io/maslis/debug-harness:latest` (consumed by per-project
`compose.test.yml`). The repo's own `docker-compose.yml` is for harness development.

## Choosing a command

| Use case                                              | Command       | Speed |
|-------------------------------------------------------|---------------|-------|
| "Why does this page look broken?" (one-off snapshot)  | `capture`     | ~3 s  |
| "Does local match prod?" (visual diff)                | `compare`     | ~6 s  |
| "Why is perf/a11y/SEO bad here?" (deep audit)         | `audit`       | ~30 s |
| "Did my fix improve the audit?" (compare 2 audits)    | `audit-diff`  | <1 s  |
| "Run my project's e2e specs" (durable assertions)     | `test`        | varies|

Rough rule: `capture` for ad-hoc inspection, `audit` for actionable perf/a11y signal,
`test` for durable specs that live in the project repo.

## When NOT to use it
- CI — this is a local-first tool. (CI projects should run Playwright directly.)
- Multi-browser checks — Chromium only.
- Production traffic monitoring — use a proper RUM/synthetic service.

## Operating it

```bash
debug up                                             # start service
debug health                                         # verify it's alive
debug capture http://localhost:4322/ --inspect "h1,.card"
debug compare http://localhost:4322/ https://setalarmclock.net/
debug audit http://localhost:4322/ --thresholds=performance:90,accessibility:95
debug audit-diff <runId-before> <runId-after>
debug test                                           # runs project's tests/*.spec.ts in container
debug capture http://localhost:4322/ --device "iPhone 13"
debug down                                           # stop when done
```

## Reading artifacts

Each run lands in `artifacts/<runId>/`:
- `viewport.png`, `full.png` — screenshots
- `dom.html` — rendered DOM
- `console.log` — one line per console message
- `network.json` — all requests; filter `blocked: "ads"` or `status >= 400`
- `errors.json` — page errors, unhandled rejections, console.errors
- `computed-styles.json` — `getComputedStyle()` for each `inspect` selector
- `web-vitals.json` — LCP/CLS/FCP/TTFB/INP
- `meta.json` — summary + request echo

For compare runs: `artifacts/<runId>/{local,prod}/` + `diff.png` + `compare-meta.json`.

For audit runs: `artifacts/<runId>/lighthouse.json` (full LHR), `viewport.png`,
`meta.json` (Claude-friendly summary: scores, top opportunities, threshold failures, lab CWV).

## Consumer setup tips (`debug test`)

When wiring a project's `compose.test.yml` for `debug test`, these defaults
prevent the most common failure modes:

- **`shm_size: "1gb"`** is required. Default Docker `/dev/shm` is 64 MB;
  Chromium under 4+ parallel workers crashes with `SIGSEGV` without it.
  Symptom: tests fail with `Target page, context or browser has been closed`
  and the launcher log shows `<process did exit: signal=SIGSEGV>`.
- **Cap Playwright `workers` to ~4** for local runs. Astro dev servers
  re-optimize deps under high concurrency and start serving 5xx; capping
  workers also keeps memory in line with `shm_size`.
- **Enable 1 local retry** (`retries: process.env.CI ? 2 : 1`). Dev-server
  warm-up flakes account for most non-deterministic failures; CI gets more.
- **Mount the project's `playwright.config.ts` read-only** into `/work` —
  the harness image has no project config of its own; `debug test` calls
  `/work/node_modules/.bin/playwright test --config /work/playwright.config.ts`.

## Common cross-suite failure modes

- **Browser crashed (SIGSEGV / context closed)** — almost always `/dev/shm`
  too small. Fix in `compose.test.yml`, not in tests.
- **Lots of tests fail with connection refused** — your dev server isn't
  running. The container talks to your host via `host.docker.internal:PORT`.
- **One test fails only under parallel load** — race on shared dev-server
  state or async-deferred persistence. Use `await expect.poll(...)` or
  `await expect(locator).toHaveText(...)` instead of read-then-assert.
- **Audit perf scores look terrible** — dev mode has no compression /
  minification / HTTP/2. Audit a production preview (`pnpm build && pnpm preview`)
  for meaningful numbers.

`summary.error.kind`:
- `navigation_failed` — `goto` threw / 4xx-5xx on initial
- `action_failed` — selector timeout or other Playwright error
- `click_guard_blocked` — safety layer refused
- `browser_crashed` — Chromium died
- `lighthouse_failed` — Lighthouse threw (CDP issue, audit timeout, etc.)
- `internal` — harness bug

## Safety rules (do not bypass)

- **Never set `allowAds: true`** unless the user explicitly requests it. Ads loading during debug means scripted clicks might hit real ad slots.
- **Never modify `src/safety.ts`** without explicit user review. The ad-host blocklist only grows, never shrinks.
- **`op: "evaluate"` bypasses the click guard.** Only use it when the user asks for raw JS execution. Prefer `click`/`type` for user-gesture simulation.
- The click guard has no kill switch. That's intentional. Don't try to add one.

## Testing protocol

- `pnpm test` before committing changes to `src/`.
- `pnpm test:smoke` before publishing a new Docker image.
- Adding a new ad-host pattern? Add a test to `tests/unit/ad-hosts.test.ts` first.

## Design spec

Full design lives at `~/Workspace/claude/setalarmclock-astro/docs/superpowers/specs/2026-04-20-debug-harness-design.md`. Implementation plan at `.../plans/2026-04-20-debug-harness.md`.
