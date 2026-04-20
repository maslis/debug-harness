import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "artifacts");

export interface RunDirs {
  runId: string;
  absDir: string;
  relDir: string;
}

export async function createRunDir(runId: string, subpath?: string): Promise<RunDirs> {
  const rel = subpath ? join("artifacts", runId, subpath) : join("artifacts", runId);
  const abs = resolve(process.cwd(), rel);
  await mkdir(abs, { recursive: true });
  return { runId, absDir: abs, relDir: rel };
}

export async function writeText(dir: string, name: string, body: string): Promise<string> {
  await writeFile(join(dir, name), body, "utf8");
  return name;
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  await writeFile(join(dir, name), JSON.stringify(value, null, 2), "utf8");
  return name;
}

export async function writeBinary(
  dir: string,
  name: string,
  bytes: Uint8Array | Buffer,
): Promise<string> {
  await writeFile(join(dir, name), bytes);
  return name;
}

export function buildRunId(label?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return label ? `${stamp}-${label}` : stamp;
}

export { ROOT as ARTIFACTS_ROOT };
