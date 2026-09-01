/**
 * Token estimation for prompt-budgeted blocks (the registry digest today, the
 * skills digest next). Deliberately not a real tokenizer — no vocabulary file,
 * no dependency, no initiator-model coupling — but calibrated for what these
 * blocks actually contain, which flat chars-per-token was not (issue #8).
 *
 * Digest lines are dense with model ids (`zai/glm-5.3`), prices (`$0.6/$2.2`),
 * and bracketed tag lists — content where BPE tokenizers emit roughly one token
 * per symbol and short tokens for digit runs. A flat 4 chars/token halves the
 * real count on such lines, and the two failure modes are not symmetric: an
 * estimate that runs LOW silently pushes the prompt-cache breakpoint and bills
 * every orchestration; one that runs HIGH drops models with an honest "(N
 * omitted)" note. So this estimator is built to err high.
 *
 * The segment model: letters compress like prose (~4 chars/token), digit runs
 * split short (~3 digits/token), and every symbol or punctuation character is
 * charged a full token. Whitespace is free — real tokenizers fold a leading
 * space into the following word token.
 */
const SEGMENTS = /[A-Za-z]+|[0-9]+|\s+|./gu;

const CHARS_PER_WORD_TOKEN = 4;
const DIGITS_PER_TOKEN = 3;

/** Estimate the token count of `text`, biased high for symbol-dense content. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const segment of text.match(SEGMENTS) ?? []) {
    const head = segment.charCodeAt(0);
    if (isLetter(head)) tokens += Math.ceil(segment.length / CHARS_PER_WORD_TOKEN);
    else if (isDigit(head)) tokens += Math.ceil(segment.length / DIGITS_PER_TOKEN);
    else if (!isWhitespace(segment)) tokens += segment.length;
  }
  return tokens;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isWhitespace(segment: string): boolean {
  return segment.trim() === "";
}
