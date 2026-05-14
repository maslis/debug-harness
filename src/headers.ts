// Parsing helper shared between the CLI (`debug capture --header "X: 1"`)
// and unit tests. Kept here rather than inside bin/debug.ts so importing
// it from a test does not execute the CLI entry point.

export class HeaderParseError extends Error {
  constructor(message: string, readonly input: string) {
    super(message);
    this.name = "HeaderParseError";
  }
}

// Parse a single `Name: Value` argument from the CLI. Splits on the first
// colon so values can themselves contain `:` (e.g. URLs, IPv6, "Bearer
// foo:bar"). Trims whitespace on both sides. Rejects missing colon and
// empty name. An empty value is allowed — some headers carry no value
// intentionally.
export function parseHeaderArg(input: string): [string, string] {
  const idx = input.indexOf(":");
  if (idx === -1) {
    throw new HeaderParseError(`missing ':' in --header value`, input);
  }
  const name = input.slice(0, idx).trim();
  const value = input.slice(idx + 1).trim();
  if (name === "") {
    throw new HeaderParseError(`empty header name in --header value`, input);
  }
  return [name, value];
}

// Collect repeated --header flags into a single map. Later occurrences of
// the same name overwrite earlier ones, matching how curl/wget behave.
export function collectHeaders(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const [name, value] = parseHeaderArg(a);
    out[name] = value;
  }
  return out;
}
