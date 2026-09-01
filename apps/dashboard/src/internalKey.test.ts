/**
 * The `?key=` bootstrap. What only this can prove: the key lands in the
 * daemon's cookie (name from `shared` — the server checks the same constant),
 * the URL is scrubbed of the secret and nothing else, and a keyless visit —
 * every visit in the recommended `tailscale serve` mode — touches neither.
 */
import { INTERNAL_KEY_COOKIE } from "@rewter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapInternalKey } from "./internalKey.js";

function fakeWindow(url: string): {
  win: Pick<Window, "location" | "history">;
  replaced: () => string | null;
} {
  const u = new URL(url);
  let replacedWith: string | null = null;
  const win = {
    location: { search: u.search, pathname: u.pathname, hash: u.hash } as Location,
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, next: string) => {
        replacedWith = next;
      }),
    } as unknown as History,
  };
  return { win, replaced: () => replacedWith };
}

const clearCookie = () => {
  document.cookie = `${INTERNAL_KEY_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};

afterEach(clearCookie);

describe("bootstrapInternalKey", () => {
  it("moves ?key= into the cookie and scrubs it from the URL", () => {
    const { win, replaced } = fakeWindow("http://ts.example:20130/?key=ik-secret");
    bootstrapInternalKey(win);
    expect(document.cookie).toContain(`${INTERNAL_KEY_COOKIE}=ik-secret`);
    expect(replaced()).toBe("/");
  });

  it("scrubs only the key, keeping other params and the hash", () => {
    const { win, replaced } = fakeWindow("http://ts.example:20130/?tab=costs&key=ik-secret#w1");
    bootstrapInternalKey(win);
    expect(replaced()).toBe("/?tab=costs#w1");
  });

  it("encodes a key the cookie grammar would otherwise mangle", () => {
    const { win } = fakeWindow("http://ts.example:20130/?key=a%3Bb%3Dc");
    bootstrapInternalKey(win);
    // `;` and `=` inside a raw cookie value would splice into the next pair —
    // the server decodes, so the round trip must go through encodeURIComponent.
    expect(document.cookie).toContain(`${INTERNAL_KEY_COOKIE}=${encodeURIComponent("a;b=c")}`);
  });

  it("does nothing without a key — the tailscale-serve everyday path", () => {
    const { win, replaced } = fakeWindow("http://127.0.0.1:20130/?tab=costs");
    bootstrapInternalKey(win);
    expect(document.cookie).not.toContain(INTERNAL_KEY_COOKIE);
    expect(replaced()).toBeNull();
  });
});
