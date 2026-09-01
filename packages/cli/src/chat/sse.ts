/**
 * Incremental SSE decoding, byte-boundary honest.
 *
 * The daemon frames its stream as `data: <json>` blocks separated by blank
 * lines, with `: ping` comments to keep idle proxies from cutting the socket —
 * see `server/http/sse.ts`. Nothing guarantees a network read ends on a block
 * boundary, so this parser owns the buffer: feed it whatever arrived, get back
 * only the complete `data:` payloads, and the half-block stays inside until its
 * other half shows up.
 *
 * It returns raw payload strings rather than parsed JSON because one of them is
 * the literal `[DONE]` sentinel, which is not JSON and not this layer's call.
 */

/** One parser per stream — it closes over the split-block buffer. */
export function createSseParser(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const out: string[] = [];
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        // Comment lines (`: ping`) and empty lines fall through untouched.
        if (line.startsWith("data: ")) out.push(line.slice(6));
        else if (line.startsWith("data:")) out.push(line.slice(5));
      }
      boundary = buffer.indexOf("\n\n");
    }
    return out;
  };
}
