import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.js";

describe("createSseParser", () => {
  it("yields the payload of a complete block", () => {
    const parse = createSseParser();
    expect(parse('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("holds a split block until the rest arrives", () => {
    // The reason this parser exists: network reads do not respect frame
    // boundaries. Half a payload, then the other half plus the terminator.
    const parse = createSseParser();
    expect(parse('data: {"a"')).toEqual([]);
    expect(parse(":1}\n\n")).toEqual(['{"a":1}']);
  });

  it("holds a block split exactly at the blank-line boundary", () => {
    // The nastiest split: the first \n of the \n\n terminator ends one read.
    const parse = createSseParser();
    expect(parse("data: one\n")).toEqual([]);
    expect(parse("\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  it("yields several blocks from one read", () => {
    const parse = createSseParser();
    expect(parse("data: a\n\ndata: b\n\ndata: c\n\n")).toEqual(["a", "b", "c"]);
  });

  it("skips heartbeat comments", () => {
    // The daemon sends `: ping` every 15s to keep proxies from cutting idle
    // streams; they are framing noise, not payload.
    const parse = createSseParser();
    expect(parse(": ping\n\ndata: real\n\n")).toEqual(["real"]);
  });

  it("accepts data: without the space", () => {
    const parse = createSseParser();
    expect(parse("data:tight\n\n")).toEqual(["tight"]);
  });

  it("passes the [DONE] sentinel through raw", () => {
    // Not JSON, not this layer's call — the stream reader decides what it means.
    const parse = createSseParser();
    expect(parse("data: [DONE]\n\n")).toEqual(["[DONE]"]);
  });

  it("keeps a trailing partial block buffered across many reads", () => {
    const parse = createSseParser();
    expect(parse("da")).toEqual([]);
    expect(parse("ta: slow")).toEqual([]);
    expect(parse("ly")).toEqual([]);
    expect(parse("\n\n")).toEqual(["slowly"]);
  });
});
