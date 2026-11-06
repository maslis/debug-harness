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

## Test runner (no Docker socket)

Runs `playwright test` and allowed scripts for workers in a project container that has no Docker socket. It is one more compose service, from this image: HTTP on port 3940, reached by service name inside the project's network, with no published host port.

### Add it to a project

Network, aliases and mounts are compose values the project sets. The runner has no code for them.

SetAlarmClock (`examples/runner.setalarmclock.json`):

```yaml
  runner:
    image: ghcr.io/maslis/debug-harness:latest
    command: ["node", "--experimental-strip-types", "--no-warnings", "/app/src/runner/index.ts"]
    user: pwuser
    read_only: true              # the only writable places are the two below
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    shm_size: "1gb"
    mem_limit: 2g
    tmpfs:
      - /tmp:mode=1777
      - /app/artifacts           # or the image's VOLUME creates an anonymous volume
    networks: [default]          # only this project's network
    volumes:
      # Read-only at every path workers use, so new untracked specs show at once.
      - ${WORKSPACE_DIR}:/work:ro
      - ${WORKSPACE_DIR}:${WORKSPACE_DIR}:ro
      - ${WORKSPACE_DIR}/.debug-harness:/work/.debug-harness   # the one writable folder
      # Mask secrets at the root. See the limits below: this does not reach worktrees.
      - /dev/null:/work/.env:ro
      - /dev/null:/work/.dev.vars:ro
      - /dev/null:${WORKSPACE_DIR}/.env:ro
      - /dev/null:${WORKSPACE_DIR}/.dev.vars:ro
      - ./.debug-harness/runner.json:/etc/debug-harness/runner.json:ro
```

ProTag (`examples/runner.protag.json`), same service with these values. This shape comes from ProTag's measured list and has not been run; `/work/worktrees` in the example config is a placeholder for its real path:

```yaml
    networks:
      mysite: {}                 # protag-docker_mysite; protag.test is an alias set on this network
    extra_hosts:
      - "host.docker.internal:host-gateway"   # real-page mode
    # No `internal: true`: the PRO-47 tests load Google's public sample ad.
```

### Config

JSON at `RUNNER_CONFIG` (default `/etc/debug-harness/runner.json`). Port and host: `RUNNER_PORT` (3940), `RUNNER_HOST`.

| Key | Meaning | Default |
|---|---|---|
| `project` | Name in logs and `/health` | required |
| `roots` | Every path the repo is mounted at. A run's cwd must be inside one | required |
| `worktreeRoots` | Folders whose direct children are worktrees; each is a root of its own | `[]` |
| `resultsDir` | The one folder the runner writes results to | required |
| `allowedEnv` | Env names a request may set, as regular expressions matched against the whole name | `[]` |
| `defaultEnv` | Env every run starts with | `{}` |
| `playwright.bin` | The binary | the image's |
| `playwright.config` | Config file, relative to the run's root | `playwright.config.ts` |
| `playwright.flags` | Allowed flags, chosen from `--workers --browser --grep --project --reporter --retries --output` (`-g` and `-j` are aliases) | all |
| `scripts.dir` | `node <dir>/*.mjs` may run. Absent means scripts are off | off |
| `timeoutMs` | The one limit per run, from its start. A request cannot change it | 30 min |
| `killGraceMs` | SIGTERM to SIGKILL | 5 s |
| `maxQueue` | How many may wait behind the running one; past that, 429 | 8 |
| `keepRuns` | Run folders kept under `<resultsDir>/runner` | 20 |
| `scratchDir` | Where each run's throwaway `TMPDIR` and `HOME` are made | OS temp |
| `sweepDirs` | Folders emptied after every run. Only for a container that does nothing else | `[]` |
| `secretFiles` | File names `/health` and the startup log report if a run could read them | `.env`, `.dev.vars` |

Rules that are not config: arguments are an argv, never a shell. Paths are resolved through symlinks and must stay in the run's own root. `--config` and custom reporters are refused. `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `HOME`, `LD_*` and `DYLD_*` can never be set; `PLAYWRIGHT_*`, `PW_*`, `PWTEST_*` and `PWDEBUG` only when the project lists the exact name. An env value that names a path is not checked: the read-only mount is what protects the repo.

`--output` must be strictly under `resultsDir`. Because Playwright empties that folder when a run starts, it is also refused for the results folder itself, the runner's run folders, and any non-empty folder without Playwright's `.last-run.json`. A run killed before it finishes leaves no `.last-run.json`, so that folder is refused until someone empties it. Without `--output`, each run gets its own folder, printed at the start.

### Calling it

The client is one file with no dependencies, and does not need the `debug` CLI. Get it from the runner:

```bash
curl -s http://runner:3940/client.mjs -o /tmp/runner-client.mjs
node /tmp/runner-client.mjs -e BASE_URL=http://web:4321 playwright tests/a.spec.ts --workers=1
node /tmp/runner-client.mjs script scripts/shell/css-coverage.mjs --base http://web:4321 --out /work/.debug-harness/runs/x.json
```

`DEBUG_RUNNER_URL` overrides the address, `--cwd` the folder. Exit code: the run's own; 128+n if a signal killed it; 124 at the time limit; 125 if it never ran or the result was lost; 2 on bad usage. Killing the client kills the run.

Or plain HTTP. The reply is one JSON event per line, and the last line holds the exit code:

```bash
curl -sN http://runner:3940/run -H 'content-type: application/json' \
  -d '{"command":"playwright","args":["tests/a.spec.ts"],"cwd":"/work","env":{"BASE_URL":"http://web:4321"}}'
# {"type":"started",...} {"type":"output","stream":"stdout","data":"..."} {"type":"exit","code":0,"signal":null,"outcome":"exited",...}
```

`GET /health` shows the state, the Playwright version and `readableSecretFiles`.

### What it does not protect against

**Specs are code.** A spec or script can do anything the runner container can, so the path, flag and env checks only stop mistakes and bad arguments. The protection is what the container lacks: the socket, write access to the repo, other projects' networks. That leaves these real gaps:

- **Secret copies in worktrees are readable.** A `/dev/null` mask covers fixed paths only. Any `.env` or `.dev.vars` inside a worktree can be read by a spec, and file modes do not help: on the Mac file share (OrbStack) the file's owner shows as whichever uid is asking. `/health` lists the files with the names in `secretFiles`; other secrets under other names are not detected. Closing this needs those copies moved out of the mounted tree.
- **The host is reachable.** `host.docker.internal` resolves in the container even without `extra_hosts`, so ports published on the host, including other projects', can be reached over the network. Not being on another project's network only removes the names.
- **The project's own network is open.** A spec can reach every service on it, and anything on that network can call the runner: there is no login. Requests with an `Origin` header or without a JSON content type are refused, which stops a web page from calling it.
- **The internet is open** unless the project sets `internal: true`, so a spec can send out anything it can read.
- **The results folder can be changed by any run,** including earlier results and anything else kept there.
- **The whole repo is readable,** `.git` included.

Clean-up covers what a run leaves under its `TMPDIR` and `HOME` and in `sweepDirs`. With the `read_only` setup above there is nowhere else to write. A process that a finished run deliberately left running outside its process tree is only caught when the run was stopped by a drop or a timeout.

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
