import { describe, expect, it, vi } from "vitest";

import { focusDesktopForDeeplink } from "../../src/main/deeplink-focus.js";

describe("focusDesktopForDeeplink", () => {
  // The runtime creates the desktop-pet window (hidden, `focusable: false`)
  // before the main window and packaged cold start puts the splash ahead of
  // both, so any bring-to-front that selects a window itself lands on the wrong
  // one and silently does nothing. Routing through the runtime's `show()` is
  // what makes the `workspace/open` hand-off actually surface the app.
  it("brings the client to the front through the runtime's own show()", () => {
    const show = vi.fn();

    focusDesktopForDeeplink({ show });

    expect(show).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the desktop runtime is absent", () => {
    expect(() => focusDesktopForDeeplink(null)).not.toThrow();
    expect(() => focusDesktopForDeeplink(undefined)).not.toThrow();
  });
});
