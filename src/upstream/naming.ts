import { createHash } from "node:crypto";

/** Most clients cap tool names at 64 chars ([a-zA-Z0-9_-]); exposed names must always fit. */
export const MAX_TOOL_NAME_LENGTH = 64;

export function sanitizeNamePart(part: string): string {
  const cleaned = part.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "x";
}

/**
 * Computes the client-facing name for an upstream tool: `<upstream>_<tool>`,
 * length-capped and collision-free against `taken`. Deterministic for a given
 * (upstream, tool) pair — the fallback suffix is a hash of the pair, so the
 * same tool always maps to the same exposed name regardless of what else exists.
 */
export function exposedToolName(upstreamName: string, toolName: string, taken: ReadonlySet<string>): string {
  const base = `${sanitizeNamePart(upstreamName)}_${sanitizeNamePart(toolName)}`;
  let candidate = base;
  if (base.length > MAX_TOOL_NAME_LENGTH || taken.has(candidate)) {
    const hash = createHash("sha256").update(`${upstreamName}:${toolName}`).digest("hex").slice(0, 8);
    candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
  }
  let final = candidate;
  for (let i = 2; taken.has(final); i++) {
    const suffix = `_${i}`;
    final = candidate.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
  }
  return final;
}
