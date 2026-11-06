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
    restart: unless-stopped      # workers have no other way to bring it back
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
      # Named, never the workspace itself: see "What is mounted" below.
      - ${WORKSPACE_DIR:-${PWD}}/tests:/work/tests:ro
      - ${WORKSPACE_DIR:-${PWD}}/playwright.config.ts:/work/playwright.config.ts:ro
      - ${WORKSPACE_DIR:-${PWD}}/package.json:/work/package.json:ro
      - ${WORKSPACE_DIR:-${PWD}}/scripts:/work/scripts:ro
      - ${WORKSPACE_DIR:-${PWD}}/src:/work/src:ro
      - ${WORKSPACE_DIR:-${PWD}}/.worktrees:/work/.worktrees:ro
      - ${WORKSPACE_DIR:-${PWD}}/.claude/worktrees:/work/.claude/worktrees:ro
      - ${WORKSPACE_DIR:-${PWD}}/.debug-harness:/work/.debug-harness   # the one writable folder
      # The same names at the repo's host path, which workers also use.
      - ${WORKSPACE_DIR:-${PWD}}/tests:${WORKSPACE_DIR:-${PWD}}/tests:ro
      - ${WORKSPACE_DIR:-${PWD}}/playwright.config.ts:${WORKSPACE_DIR:-${PWD}}/playwright.config.ts:ro
      - ${WORKSPACE_DIR:-${PWD}}/package.json:${WORKSPACE_DIR:-${PWD}}/package.json:ro
      - ${WORKSPACE_DIR:-${PWD}}/scripts:${WORKSPACE_DIR:-${PWD}}/scripts:ro
      - ${WORKSPACE_DIR:-${PWD}}/src:${WORKSPACE_DIR:-${PWD}}/src:ro
      - ${WORKSPACE_DIR:-${PWD}}/.worktrees:${WORKSPACE_DIR:-${PWD}}/.worktrees:ro
      - ${WORKSPACE_DIR:-${PWD}}/.claude/worktrees:${WORKSPACE_DIR:-${PWD}}/.claude/worktrees:ro
      - ${WORKSPACE_DIR:-${PWD}}/.debug-harness:${WORKSPACE_DIR:-${PWD}}/.debug-harness:ro
      # Outside the workspace: see "The config file".
      - type: bind
        source: ${HOME}/.config/debug-harness/setalarmclock.runner.json
        target: /etc/debug-harness/runner.json
        read_only: true
        bind:
          create_host_path: false
```

**What is mounted.** Only these names, so the root's `.env` and `.dev.vars` are not in the container at all, in any letter case. A `/dev/null` mask cannot do that here: the Mac file share is case-insensitive, so a mask on `.env` leaves `.ENV` readable. `tests`, `playwright.config.ts` and `package.json` are what specs need (measured: `playwright test --list` loads all 854 tests in 49 files with these alone, and no spec reads a file outside `tests/` and `.debug-harness/`). `scripts` and `src` are for `scripts/shell/*.mjs`, which reads `src/styles`. `@playwright/test` comes from the image, so the repo's `node_modules` is not needed. **A new top-level name a spec or script needs must be added here, at both paths**; until then it fails with `ENOENT` or `Cannot find module`. Every one of these names exists in a fresh clone or is created empty by Docker on start (`.worktrees`, `.claude/worktrees`), so a clean checkout starts without preparing anything.

**A mount of a single file breaks when the file is replaced.** A `git checkout` or `git pull` that changes `playwright.config.ts` or `package.json` in the main checkout replaces the file, and on the Mac share the path is then missing inside the container. Runs from the root fail until the runner is restarted: `config_not_found` (125) for the config, `Cannot find module '/work/package.json'` (exit 1) for the other. Never a pass. Worktree runs are not affected, and `docker restart <the runner>` brings it back. The folders are not affected: a new file in `tests/` shows at once.

ProTag (`examples/runner.protag.json`) names each mount instead of mounting the workspace. These are the mounts of its `test` service, minus `worktrees`. A build under test is copied into the results folder and read through `PROTAG_PUBLIC_DIR`, so `worktreeRoots` is not set and every call uses `--cwd /work`. `extra_hosts` is left out because these tests do not need real-page mode:

```yaml
  runner:
    image: ghcr.io/maslis/debug-harness:latest
    command: ["node", "--experimental-strip-types", "--no-warnings", "/app/src/runner/index.ts"]
    user: pwuser
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    shm_size: "1gb"
    mem_limit: 2g
    tmpfs:
      - /tmp:mode=1777
      - /app/artifacts
    networks:
      mysite: {}                 # protag-docker_mysite; protag.test is an alias set on this network
    # No `internal: true`: the PRO-47 tests load Google's public sample ad.
    volumes:
      # Never the workspace itself, at any path: it holds worktrees/.
      - ${WORKSPACE_DIR:-${PWD}}/tests:/work/tests:ro
      - ${WORKSPACE_DIR:-${PWD}}/playwright.config.ts:/work/playwright.config.ts:ro
      - ${WORKSPACE_DIR:-${PWD}}/protag/public:/work/protag-public:ro
      - ${WORKSPACE_DIR:-${PWD}}/.debug-harness:/work/.debug-harness   # the one writable folder
      - ${WORKSPACE_DIR:-${PWD}}/.debug-harness/work-package.json:/work/package.json:ro
      # Outside the workspace: see "The config file".
      - type: bind
        source: ${HOME}/.config/debug-harness/protag.runner.json
        target: /etc/debug-harness/runner.json
        read_only: true
        bind:
          create_host_path: false
```

The secret files under `worktrees/` are out of a run's reach only with these mounts. Leaving out `worktreeRoots` does not do it: any mount that holds `worktrees/` makes them readable again, under whatever path it is mounted. A file copied into `.debug-harness`, or into a mounted folder, is readable like everything else there, so copy a build's output, not a worktree. `work-package.json` (`{}` is enough) must exist before the service starts, or Docker creates a folder in its place.

### The config file

**It lives outside the workspace, on the host: `~/.config/debug-harness/<project>.runner.json`. A person creates it, from `examples/runner.<project>.json`, before the first start.** Without it the service does not start and Docker names the missing path (`bind source path does not exist`); `create_host_path: false` stops it from making a folder in its place.

The config decides which binary runs and which flags and env a request may use, so whoever can write it decides what a run reports. A mount with `:ro` only protects that one path: a file under the results folder or the repo stays writable at its other path, and a spec or worker could rewrite it, and a restart would load it. Neither a run nor a worker can reach this file, because no mount of the runner or of the app container holds it. **It only holds while workers have no Docker socket:** with one, anything mounted anywhere can be changed.

The runner reads it once, at start, so to change it a person edits the file and recreates the container (`docker compose up -d --force-recreate runner`). Compose's inline `configs: content:` would be simpler, but Compose refuses it for this service: `cannot create config in read-only service: file is the sole supported option`.

At start the runner also refuses a `playwright.bin` under `roots`, `worktreeRoots`, `resultsDir`, `scratchDir` or `sweepDirs` (log event `refused_to_start`, exit 1): those are places a run or a worker can write. It cannot tell whether its own config file is safe, so that rests on the mount above.

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
| `playwright.flags` | Allowed flags, chosen from `--workers --browser --grep --project --reporter --retries --output` (`-g` and `-j` are aliases). `--workers` takes 1 to 16, or 1% to 100%; `--retries` 0 to 10 | all |
| `scripts.dir` | `node <dir>/*.mjs` may run. Absent means scripts are off | off |
| `timeoutMs` | The one limit per run, from its start. A request cannot change it | 30 min |
| `killGraceMs` | SIGTERM to SIGKILL | 5 s |
| `maxQueue` | How many may wait behind the running one; past that, 429 | 8 |
| `keepRuns` | Run folders kept under `<resultsDir>/runner` | 20 |
| `scratchDir` | Where each run's throwaway `TMPDIR` and `HOME` are made | OS temp |
| `sweepDirs` | Folders emptied after every run. Only for a container that does nothing else | `[]` |
| `secretFiles` | File names looked for, in any letter case, directly in each root and worktree. If a run could read them, `/health` gives the count of distinct files and the startup log the paths | `.env`, `.dev.vars` |

Rules that are not config: arguments are an argv, never a shell. Paths are resolved through symlinks and must stay in the run's own root. A spec argument with a line break, an empty argument, an empty flag value, a spec whose normalized path starts with `-`, any value over 100 KB, a `--cwd` that is a file (`cwd_not_a_directory`) and arguments and env that come to more than 1.5 MB in total are refused. The final argv puts `--` before the specs. `--config` and custom reporters are refused. `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `HOME`, `LD_*` and `DYLD_*` can never be set; `PLAYWRIGHT_*`, `PW_*`, `PWTEST_*` and `PWDEBUG` only when the project lists the exact name. An env value that names a path is not checked: the read-only mount is what protects the repo.

`--output` must be strictly under `resultsDir` and cannot hold a line break. Because Playwright empties that folder when a run starts, it is also refused for the results folder itself, the runner's run folders (compared by device and inode, so another letter case of the name is refused on a case-insensitive share), and any non-empty folder without Playwright's `.last-run.json`. A run killed before it finishes leaves no `.last-run.json`, so that folder is refused until someone empties it. Without `--output`, each run gets its own folder, printed at the start.

### Calling it

The client is one file with no dependencies, and does not need the `debug` CLI. Download it from the runner, then run it:

```bash
curl -sf http://runner:3940/client.mjs -o /tmp/runner-client.mjs && node /tmp/runner-client.mjs --cwd /work -e BASE_URL=http://web:4321 playwright tests/a.spec.ts --workers=1
curl -sf http://runner:3940/client.mjs -o /tmp/runner-client.mjs && node /tmp/runner-client.mjs script scripts/shell/css-coverage.mjs --base http://web:4321 --out /work/.debug-harness/runs/x.json
```

**Do not pipe the client into node** (`curl … | node --input-type=module - …`). When the runner cannot be reached, node runs an empty script and the piped command exits 0 with nothing run, which reads as a pass.

- **Spec arguments must be file paths** (`tests/x.spec.ts`, optionally `:line` or `:line:col`) or folders. A bare name, which Playwright itself would match as a filter, is refused with `path_not_found`. Each selects exactly that path, in that letter case, as a literal, not a regular expression or a substring. Use `--grep` to filter. On the Mac share a wrong-case path exists, so it is accepted, then matches nothing.
- **A path that selects nothing is never a pass.** Alone, it ends with Playwright's "No tests found", exit 1. Beside one that does select something, Playwright would drop it and exit 0, so the runner checks the JSON report it always writes: it says `runner: error: <path> selected no test` and the run exits 1 (outcome `selected_nothing`). `--grep`, `--project` or a `test.only` elsewhere can cause this too. So can a run that exits 0 with no readable report. A spec can rewrite that report, as it can call `process.exit(0)`: this catches mistakes, not attacks.
- **A spec argument is only checked against the run's root, not against `testDir`.** It has to exist and stay inside the root. A folder with no specs is accepted and ends with "No tests found", exit 1. So do `playwright.config.ts`, `package.json` or any other file in the root that is not a spec: accepted, then no tests.
- **`--cwd` is needed when the caller's folder is not under `roots` or `worktreeRoots`.** The client sends its own folder by default, and outside those it is refused with `cwd_outside_root`.
- **`--output` is optional.** Without it the run gets its own folder under `<resultsDir>/runner`, printed at the start.

`DEBUG_RUNNER_URL` overrides the address for the client; the download names its own URL. A failed download stops the command with curl's own non-zero code (6 when the name does not resolve, 22 on an HTTP error), and the client never starts. Once the client is running, the exit code is the run's own; 1 if a path selected nothing; 128+n if a signal killed it; 124 at the time limit; 125 if it never ran, the result was lost, or the answer was not the runner's; 2 on bad usage. Killing the client kills the run.

Or plain HTTP. The reply is one JSON event per line, and the last line holds the exit code:

```bash
curl -sN http://runner:3940/run -H 'content-type: application/json' \
  -d '{"command":"playwright","args":["tests/a.spec.ts"],"cwd":"/work","env":{"BASE_URL":"http://web:4321"}}'
# {"type":"started",...} {"type":"output","stream":"stdout","data":"..."} {"type":"exit","code":0,"signal":null,"outcome":"exited",...}
```

`GET /health` shows the state, the Playwright version and `readableSecretFileCount`. It has no login, so it gives a count and never a file's name. The paths are in the startup log. With the SetAlarmClock block the root adds nothing to that count; what it counts is the worktrees.

### Running from a worktree

Everything except `resultsDir` is read-only, and the writable mount is at `/work/.debug-harness` only. A worktree's own `.debug-harness` is not that folder, and neither is the one under the repo's host path. A spec that uses a relative `.debug-harness/...` path therefore behaves differently from a worktree than from `--cwd /work`. Confirmed on SetAlarmClock:

- **A failure.** `countdown-builder-repeat-yearly` fails with `ENOENT ... open '.debug-harness/runs/round21-lock-...png'`.
- **A silent skip.** `theme-packages` needs the file `.debug-harness/theme-packages.e2e`, which a worktree cannot have, so it skips all its tests and **exits 0 having run nothing**. A green exit from a worktree does not prove a spec ran: read the skipped count.

When a run's output shows `EROFS`, or an `ENOENT` naming the results folder from outside it, the runner adds one `runner: note:` line on stderr before the exit. It cannot see a skip, and it changes no exit code. Run such a spec with `--cwd /work`, or have it write under `resultsDir`.


### What it does not protect against

**Specs are code.** A spec or script can do anything the runner container can, so the path, flag and env checks only stop mistakes and bad arguments. The protection is what the container lacks: the socket and write access to the repo. These are real gaps, and none of them is closed:

- **Other projects' published host ports are reachable.** `host.docker.internal` resolves in the container even without `extra_hosts`, and it reaches every port published on the host, including another project's and including ports bound to 127.0.0.1. Measured with a TCP connect only: Workhub's prod port and host SSH answered. Keeping the runner off other projects' networks only removes their service names, not this route.
- **Secret files in a mounted worktree are readable.** The SetAlarmClock block still mounts `.worktrees` and `.claude/worktrees`, so each worktree's `.env`, `.dev.vars` and anything else in it can be read by a spec, at both paths. File modes do not help: on the Mac file share (OrbStack) the file's owner shows as whichever uid is asking. The `/health` count only knows the names in `secretFiles`, directly in a root or worktree, so keys under other names or deeper folders are not counted. Closing this needs those copies out of the mounted tree, or worktrees out of the mounts.
- **A spec can read `/proc/1/environ`.** It runs as the same user as the runner, so whatever the compose service sets in `environment:` is readable. Put no secret there.
- **A spec can signal the runner.** Same user, and the pid is visible. Measured from a spec: SIGKILL ends the runner, the client exits 125, and `restart: unless-stopped` brings it back with an empty queue. SIGSTOP freezes it: the container still shows as running, `/health` stops answering, the restart policy does not help, and someone has to restart the container by hand. The guarantee that no request can stop the service covers requests, not the code a run executes.
- **A spec can write to the runner's own `runner/` folder,** like the rest of the results folder: earlier results, other runs' folders and anything else kept there can be changed or removed.
- **A detached process outlives its run.** One a spec deliberately starts outside its process tree stays after a normal exit, and goes on running beside later runs. It is only caught when the run is stopped by a drop or a timeout.
- **The project's own network is open.** A spec can reach every service on it, and anything on that network can call the runner: there is no login, so anyone there can queue runs up to `maxQueue`. Requests with an `Origin` header or without a JSON content type are refused, which stops a web page from calling it.
- **The internet is open** unless the project sets `internal: true`, so a spec can send out anything it can read.
- **Everything mounted is readable.** With the SetAlarmClock block that is the named folders and every worktree, each worktree's checkout entire. The repo's `.git` and the root's other files are not mounted.

Clean-up covers what a run leaves under its `TMPDIR` and `HOME` and in `sweepDirs`. With the `read_only` setup above there is nowhere else to write except the results folder.

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
