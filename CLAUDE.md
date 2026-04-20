# debug-harness — AI guide

Standalone HTTP debug harness. Captures rich page state (screenshots, DOM, console, network, computed styles, Core Web Vitals) for any URL, with safe action scripting and local-vs-prod diffing.

## When to use it
- Styling regressions, component layout bugs, hydration/mount failures in SPA/SSR apps.
- Comparing a local dev build against production ("why does mine look different").
- Mobile layout checks without touching a real device (`--device "iPhone 13"`).
- Quick console/network/error snapshots when a user reports "something broke on /foo".

## When NOT to use it
- Assertion-style e2e testing (use Playwright test runner directly).
- CI — this is a local debugging tool.
- Anything requiring multi-browser (Firefox/WebKit not wired up).

## Operating it

```bash
debug up                                             # start service
debug health                                         # verify it's alive
debug capture http://localhost:4322/ --inspect "h1,.card"
debug compare http://localhost:4322/ https://setalarmclock.net/
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

`summary.error.kind`:
- `navigation_failed` — `goto` threw / 4xx-5xx on initial
- `action_failed` — selector timeout or other Playwright error
- `click_guard_blocked` — safety layer refused
- `browser_crashed` — Chromium died
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
