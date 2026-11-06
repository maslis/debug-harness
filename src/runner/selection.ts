import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isInside, type SpecTarget } from "./validate.ts";

/** A report this large is not one a real run wrote, and parsing it would stall every other request. */
const MAX_REPORT_BYTES = 64_000_000;

interface Place {
  line?: number;
  column?: number;
}
interface ReportSpec extends Place {
  file: string;
}
interface ReportSuite extends Place {
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}
interface SelectedTest {
  file: string;
  /** The test's own position and each enclosing describe's: `:line` selects by any of them. */
  places: Place[];
}

function selectedTests(report: { config: { rootDir: string }; suites: ReportSuite[] }): SelectedTest[] {
  const found: SelectedTest[] = [];
  const walk = (suite: ReportSuite, outer: Place[]): void => {
    const places = [...outer, suite];
    for (const spec of suite.specs ?? []) {
      const file = resolve(report.config.rootDir, spec.file);
      let real = file;
      try {
        real = realpathSync(file);
      } catch {
        // Removed since it ran: its reported path is all there is.
      }
      found.push({ file: real, places: [...places, spec] });
    }
    for (const inner of suite.suites ?? []) walk(inner, places);
  };
  for (const suite of report.suites) walk(suite, []);
  return found;
}

/** Line 0 selects the whole file, as it does in Playwright. */
function selects(target: SpecTarget, test: SelectedTest): boolean {
  if (target.isDirectory ? !isInside(target.real, test.file) : test.file !== target.real) return false;
  if (!target.line) return true;
  return test.places.some((p) => p.line === target.line && (!target.column || p.column === target.column));
}

/**
 * Playwright drops a filter that matches nothing as long as another one matches,
 * so it exits 0 for a path it never ran. Returns what to tell the client, or null if all is well.
 * A spec can rewrite this report, as it can exit 0 by itself: this catches a mistake, not an attack.
 */
export function selectionProblem(reportPath: string, targets: SpecTarget[]): string | null {
  let tests: SelectedTest[];
  try {
    if (statSync(reportPath).size > MAX_REPORT_BYTES) throw new Error("too large");
    tests = selectedTests(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    return "this run exited 0 but left no readable JSON report, so what it ran is unknown and it is not a pass";
  }
  const missed = targets.filter((t) => !tests.some((test) => selects(t, test))).map((t) => t.shown);
  if (missed.length === 0) return null;
  return `${missed.join(", ")} selected no test, so this run is not a pass. Other reasons than a wrong path: --grep, --project, or test.only in another file`;
}
