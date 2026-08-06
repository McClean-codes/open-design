import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { onRequest } from "../functions/share/[eventId].ts";

describe("share click redirect", () => {
  it("returns a 302 with Cache-Control: no-store (Pages Functions ignore _headers)", async () => {
    const response = await onRequest({
      request: new Request("https://open-design.ai/share/evt-1", {
        headers: { "user-agent": "test-agent" },
      }),
      params: { eventId: "evt-1" },
      env: {},
      waitUntil() {},
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(
      response.headers.get("Location") ?? "",
      /^https:\/\/github\.com\/nexu-io\/open-design/,
    );
  });
});
