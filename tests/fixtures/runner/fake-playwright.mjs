#!/usr/bin/env node
// Stands in for the playwright binary in the runner tests. FAKE_MODE picks the
// behaviour; FAKE_OUT is where it records what it was started with.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_MODE ?? "dump";
const out = process.env.FAKE_OUT;

if (mode === "dump") {
  const seen = { argv: process.argv.slice(2), cwd: process.cwd(), env: process.env };
  if (out) writeFileSync(out, JSON.stringify(seen));
  process.stdout.write("fake stdout\n");
  process.stderr.write("fake stderr\n");
} else if (mode.startsWith("exit:")) {
  process.exit(Number(mode.slice(5)));
} else if (mode === "hang") {
  // One child in our process group, and one in its own session: real
  // Playwright starts browsers `detached`, so a kill of the group alone misses them.
  const inGroup = spawn("sleep", ["1000"], { stdio: "ignore" });
  const ownSession = spawn("sleep", ["1000"], { stdio: "ignore", detached: true });
  writeFileSync(out, JSON.stringify({ self: process.pid, inGroup: inGroup.pid, ownSession: ownSession.pid }));
  process.stdout.write("hanging\n");
  setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  writeFileSync(out, JSON.stringify({ self: process.pid }));
  process.stdout.write("hanging\n");
  setInterval(() => {}, 1000);
} else if (mode === "litter") {
  // What a browser run leaves behind: a profile under TMPDIR, a cache under HOME,
  // and a file at a fixed path that ignores both.
  mkdirSync(join(process.env.TMPDIR, "playwright_chromiumdev_profile-x"), { recursive: true });
  writeFileSync(join(process.env.TMPDIR, "playwright_chromiumdev_profile-x/Cookies"), "x");
  mkdirSync(join(process.env.HOME, ".npm/_cacache"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".npm/_cacache/x"), "x");
  if (process.env.FAKE_FIXED) writeFileSync(join(process.env.FAKE_FIXED, "fixed-path"), "x");
  writeFileSync(out, JSON.stringify({ tmp: process.env.TMPDIR, home: process.env.HOME }));
  if (process.env.FAKE_THEN_HANG) {
    process.stdout.write("hanging\n");
    setInterval(() => {}, 1000);
  }
} else if (mode === "kill-self") {
  process.kill(process.pid, "SIGKILL");
}
