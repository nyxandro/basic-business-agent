// {{field}} in an address, a header or an environment variable of an MCP server: the place of a value the
// admin described — a key of each employee or the shared key (docs/specs/[20.11.2026]-mcp-connections.md).
export const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

// One pass: a value that itself holds «{{…}}» stays a part of the value and is never filled again.
export function fillTemplate(template: string, valueOf: (key: string) => string): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => valueOf(key));
}
