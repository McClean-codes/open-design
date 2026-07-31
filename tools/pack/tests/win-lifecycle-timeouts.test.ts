import { describe, expect, it } from "vitest";

import { WIN_DESKTOP_EVAL_TIMEOUT_MS } from "../src/win/lifecycle.js";

describe("Windows packaged lifecycle timeout contracts", () => {
  it("keeps desktop eval at the release smoke budget of exactly 60 seconds", () => {
    expect(WIN_DESKTOP_EVAL_TIMEOUT_MS).toBe(60_000);
  });
});
