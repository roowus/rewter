import { describe, expect, it } from "vitest";
import { REWTER_VERSION } from "./index.js";

describe("shared package", () => {
  it("exports a version", () => {
    expect(REWTER_VERSION).toBe("0.1.0");
  });
});
