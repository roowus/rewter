/**
 * Reading LLM replies: the three operations every "ask a model, parse the
 * answer" feature repeats. Cards (`registry/cards.ts`) and skill distillation
 * (`skills/distill.ts`) both face the same unreliable narrator — a model that
 * wraps JSON in prose, fences it, pads a clause into a paragraph — and both
 * must degrade rather than fail. What degrading *means* is feature policy and
 * stays in the feature; the mechanics live here so they cannot drift apart.
 */

/**
 * Find the JSON object in a reply that may be fenced, prefaced, or both.
 * Braces are counted rather than matched to the last `}` in the string, so
 * trailing prose containing a brace does not swallow the parse.
 */
export function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  return undefined;
}

/** One-line normalization: digests and summaries break on an embedded newline. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate at a word boundary when one is near enough, and say so with `…`. */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
