import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { onRequest } from "../functions/contact-sales.ts";

type StoredValue = { value: string };

class MemoryKV {
  readonly values = new Map<string, StoredValue>();
  failWrites = false;

  async put(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error("KV unavailable");
    this.values.set(key, { value });
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key)?.value ?? null;
  }

  async list(options: { prefix?: string } = {}) {
    const prefix = options.prefix ?? "";
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

type CallOptions = {
  env?: Record<string, unknown>;
  headers?: Record<string, string>;
  kv?: MemoryKV | null;
  now?: number;
};

// Drive the Pages Function directly with a mock context. Valid calls get a
// durable in-memory KV by default because production acknowledgements are only
// allowed after the backup write has succeeded.
async function call(
  payload: unknown,
  origin = "https://open-design.ai",
  options: CallOptions = {},
): Promise<{
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string };
  kv: MemoryKV | null;
}> {
  const waited: Promise<unknown>[] = [];
  const kv = options.kv === undefined ? new MemoryKV() : options.kv;
  const request = new Request("https://open-design.ai/contact-sales", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...options.headers,
    },
    body: JSON.stringify(payload),
  });
  const res = await onRequest({
    request,
    env: {
      ...(kv ? { CONTACT_LEADS: kv } : {}),
      ...options.env,
    },
    waitUntil: (p: Promise<unknown>) => waited.push(p),
    now: options.now === undefined ? undefined : () => options.now,
    // deno-lint-ignore no-explicit-any
  } as unknown as Parameters<typeof onRequest>[0]);
  await Promise.allSettled(waited);
  return {
    status: res.status,
    body: (await res.json()) as {
      ok: boolean;
      duplicate?: boolean;
      error?: string;
    },
    kv,
  };
}

const ENTERPRISE_OK = {
  email: "ada@acme.com",
  source: "enterprise",
  company: "Acme",
  teamSize: "11-50",
  seats: "20-50",
  budget: "usd_50_200",
  useCases: ["design_system"],
  industry: "internet_software",
  location: "中国 (CN)",
};

// The /pricing "Request team access" modal renders the same shared lead form,
// so it submits the identical contract — only `source` differs.
const PRICING_TEAM_OK = { ...ENTERPRISE_OK, source: "pricing_team" };

describe("contact-sales validation", () => {
  it("rejects a missing or invalid email on every source", async () => {
    assert.equal((await call({ ...ENTERPRISE_OK, email: "" })).body.error, "invalid_email");
    assert.equal((await call({ ...ENTERPRISE_OK, email: "not-an-email" })).body.error, "invalid_email");
    assert.equal((await call({ name: "Ada", source: "pricing_team" })).body.error, "invalid_email");
  });

  it("rejects injection-scanner emails that are whitespace-free but not a real address (2026-07-11 incident)", async () => {
    // Real payloads captured from the 07-11 SQLi scan of this endpoint. All
    // passed the old loose regex (one @, a dot, no whitespace), landed in KV,
    // and broke the downstream Bitable sync for six days.
    const payloads = [
      "testing@example.com'||dbms_pipe.receive_message(chr(98)||chr(98)||chr(98),15)||'",
      'testing@example.com"&&sleep(27*1000)*nogzzf&&"',
      "testing@example.com0'xor(if(now()=sysdate(),sleep(15),0))xor'z",
      "testing@example.com&n964235=v916916",
      "testing@example.com9408701", // digits-only junk appended to the TLD
      "../testing@example.com",
      "testing@example.com'\"",
    ];
    for (const email of payloads) {
      const { status, body } = await call({ ...ENTERPRISE_OK, email });
      assert.equal(status, 400, `should reject ${email}`);
      assert.equal(body.error, "invalid_email", `should reject ${email}`);
    }
    // Legitimate shapes must keep passing, including an apostrophe local part.
    assert.equal((await call({ ...ENTERPRISE_OK, email: "o'brien@acme.ie" })).status, 200);
    assert.equal((await call({ ...ENTERPRISE_OK, email: "w.vince.0202@gmail.com" })).status, 200);
    assert.equal((await call({ ...ENTERPRISE_OK, email: "bingjunxiang.sd@chinatelecom.cn" })).status, 200);
    assert.equal((await call({ ...ENTERPRISE_OK, email: "rodrigo@linkflow.com.br" })).status, 200);
  });

  it("does not require a name on the shared lead-form sources; the in-app `client` source still does", async () => {
    // Neither web surface collects a name (email is the contact handle).
    assert.equal((await call(ENTERPRISE_OK)).status, 200);
    assert.equal((await call(PRICING_TEAM_OK)).status, 200);
    const { status, body } = await call({ ...ENTERPRISE_OK, source: "client" });
    assert.equal(status, 400);
    assert.equal(body.error, "missing_fields");
  });

  it("rejects an unrecognized or missing source (no silent relaxed write)", async () => {
    assert.equal((await call({ name: "Ada", email: "ada@acme.com", source: "bogus" })).body.error, "invalid_source");
    assert.equal((await call({ name: "Ada", email: "ada@acme.com" })).body.error, "invalid_source");
    // An unknown source must not sneak through the name+email-only path.
    const typo = await call({ name: "Ada", email: "ada@acme.com", source: "enterprisee" });
    assert.equal(typo.status, 400);
    assert.equal(typo.body.error, "invalid_source");
  });

  it("keeps the in-app `client` source strict (name + full enums)", async () => {
    assert.equal((await call({ name: "Ada", email: "ada@acme.com", source: "client" })).body.error, "missing_fields");
    // With a name and the full enum contract, client is accepted; industry and
    // location predate the field there and stay optional.
    const { industry: _industry, location: _location, ...clientContract } = ENTERPRISE_OK;
    assert.equal((await call({ ...clientContract, name: "Ada", source: "client" })).status, 200);
  });

  it("keeps the shared contract: known team-size/seat-range/budget enums + a use case are required", async () => {
    assert.equal((await call({ ...ENTERPRISE_OK, teamSize: "nonsense" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, seats: "" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, seats: "nonsense" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, budget: "nonsense" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, useCases: [] })).body.error, "missing_fields");
    // Company became optional when the form slimmed down.
    assert.equal((await call({ ...ENTERPRISE_OK, company: "" })).status, 200);
  });

  it("requires a known industry on both shared lead-form sources", async () => {
    assert.equal((await call({ ...ENTERPRISE_OK, industry: "" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, industry: "nonsense" })).body.error, "missing_fields");
    assert.equal((await call({ ...PRICING_TEAM_OK, industry: "" })).body.error, "missing_fields");
    assert.equal((await call({ ...PRICING_TEAM_OK, industry: "nonsense" })).body.error, "missing_fields");
    assert.equal((await call({ ...ENTERPRISE_OK, industry: "gaming" })).status, 200);
  });

  it("requires location on both shared lead-form sources", async () => {
    assert.equal((await call({ ...ENTERPRISE_OK, location: "" })).body.error, "missing_fields");
    assert.equal((await call({ ...PRICING_TEAM_OK, location: "" })).body.error, "missing_fields");
  });

  it("accepts a complete enterprise submission", async () => {
    const { status, body } = await call(ENTERPRISE_OK);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // The expanded use-case vocabulary is accepted.
    assert.equal((await call({ ...ENTERPRISE_OK, useCases: ["video_motion"] })).status, 200);
  });

  it("holds pricing_team to the same full contract (the old relaxed name+email path is gone)", async () => {
    // The full shared contract is accepted.
    const { status, body } = await call(PRICING_TEAM_OK);
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // Each relaxation the retired lightweight pricing modal relied on now fails
    // on its own — mutate exactly one rule per assertion from the otherwise
    // valid PRICING_TEAM_OK so no single check leans on another field also
    // being wrong.
    // Free-form numeric seats (the old modal sent e.g. "20", not a range code):
    assert.equal((await call({ ...PRICING_TEAM_OK, seats: "20" })).body.error, "missing_fields");
    // Legacy pricing-only budget buckets that are no longer in the enum:
    assert.equal((await call({ ...PRICING_TEAM_OK, budget: "lt_1k" })).body.error, "missing_fields");
    assert.equal((await call({ ...PRICING_TEAM_OK, budget: "usd_20k_plus" })).body.error, "missing_fields");
    // The old modal collected neither a use case nor an industry:
    assert.equal((await call({ ...PRICING_TEAM_OK, useCases: [] })).body.error, "missing_fields");
    assert.equal((await call({ ...PRICING_TEAM_OK, industry: "" })).body.error, "missing_fields");
  });
});

const VELA_TEAM_PLAN_OK = {
  eventId: "evt-vela-team-plan-1",
  source: "vela_team_plan",
  name: "Legacy Contact",
  email: "buyer@example.com",
  company: "Acme",
  teamSize: "11-50",
  seats: "20-50",
  budget: "usd_1k_5k",
  useCase: "design_system",
  industry: "internet_software",
  country: "US",
  role: "Head of Design",
  message: "We need a shared design system.",
  locale: "en-US",
  billingInterval: "yearly",
};

const SERVICE_SECRET = "landing-service-shared-secret";
const SERVICE_NOW = Date.parse("2026-07-29T08:00:00.000Z");

function velaServiceHeaders(
  payload: unknown,
  options: { eventId?: string; secret?: string; timestamp?: number } = {},
) {
  const eventId = options.eventId ?? VELA_TEAM_PLAN_OK.eventId;
  const timestamp = options.timestamp ?? SERVICE_NOW;
  const rawBody = JSON.stringify(payload);
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const signature = createHmac("sha256", options.secret ?? SERVICE_SECRET)
    .update(`${timestamp}\n${eventId}\n${digest}`)
    .digest("base64url");
  return {
    "x-od-service-event-id": eventId,
    "x-od-service-signature": signature,
    "x-od-service-timestamp": String(timestamp),
  };
}

describe("contact-sales durable delivery", () => {
  it("does not acknowledge a lead until the KV backup succeeds", async () => {
    const missing = await call(ENTERPRISE_OK, "https://open-design.ai", {
      kv: null,
    });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error, "lead_storage_unavailable");

    const kv = new MemoryKV();
    kv.failWrites = true;
    const failed = await call(ENTERPRISE_OK, "https://open-design.ai", { kv });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error, "lead_storage_failed");
  });

  it("rejects forged or stale Vela service submissions", async () => {
    const env = { CONTACT_SALES_SERVICE_SECRET: SERVICE_SECRET };
    const unsigned = await call(VELA_TEAM_PLAN_OK, "", {
      env,
      now: SERVICE_NOW,
    });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.error, "service_auth_required");

    const forged = await call(VELA_TEAM_PLAN_OK, "", {
      env,
      headers: velaServiceHeaders(VELA_TEAM_PLAN_OK, {
        secret: "wrong-secret",
      }),
      now: SERVICE_NOW,
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error, "service_auth_invalid");

    const stale = await call(VELA_TEAM_PLAN_OK, "", {
      env,
      headers: velaServiceHeaders(VELA_TEAM_PLAN_OK, {
        timestamp: SERVICE_NOW - 10 * 60 * 1000,
      }),
      now: SERVICE_NOW,
    });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, "service_auth_expired");
  });

  it("accepts a signed Vela lead and preserves the stable event id", async () => {
    const result = await call(VELA_TEAM_PLAN_OK, "", {
      env: { CONTACT_SALES_SERVICE_SECRET: SERVICE_SECRET },
      headers: velaServiceHeaders(VELA_TEAM_PLAN_OK),
      now: SERVICE_NOW,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    const delivery = result.kv?.values.get(
      `contact-delivery:${VELA_TEAM_PLAN_OK.eventId}`,
    );
    assert.ok(delivery);
    assert.equal(
      JSON.parse(delivery.value).lead.name,
      VELA_TEAM_PLAN_OK.name,
    );
    assert.equal(
      JSON.parse(delivery.value).lead.source,
      VELA_TEAM_PLAN_OK.source,
    );
  });

  it("does not notify Feishu twice when Vela retries the same event id", async () => {
    const originalFetch = globalThis.fetch;
    let feishuCalls = 0;
    globalThis.fetch = async () => {
      feishuCalls += 1;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    };
    try {
      const kv = new MemoryKV();
      const env = {
        CONTACT_SALES_SERVICE_SECRET: SERVICE_SECRET,
        FEISHU_CONTACT_WEBHOOK: "https://open.feishu.cn/test-webhook",
      };
      const headers = velaServiceHeaders(VELA_TEAM_PLAN_OK);
      const first = await call(VELA_TEAM_PLAN_OK, "", {
        env,
        headers,
        kv,
        now: SERVICE_NOW,
      });
      const duplicate = await call(VELA_TEAM_PLAN_OK, "", {
        env,
        headers,
        kv,
        now: SERVICE_NOW,
      });

      assert.equal(first.status, 200);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.duplicate, true);
      assert.equal(feishuCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a recoverable retry record when Feishu rejects an HTTP 200 body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 19021 }), { status: 200 });
    try {
      const result = await call(VELA_TEAM_PLAN_OK, "", {
        env: {
          CONTACT_SALES_SERVICE_SECRET: SERVICE_SECRET,
          FEISHU_CONTACT_WEBHOOK: "https://open.feishu.cn/test-webhook",
        },
        headers: velaServiceHeaders(VELA_TEAM_PLAN_OK),
        now: SERVICE_NOW,
      });

      assert.equal(result.status, 200);
      const delivery = result.kv?.values.get(
        `contact-delivery:${VELA_TEAM_PLAN_OK.eventId}`,
      );
      assert.ok(delivery);
      const stored = JSON.parse(delivery.value);
      assert.equal(stored.status, "retry");
      assert.equal(stored.attempt, 3);
      assert.equal(typeof stored.nextAttemptAt, "string");
      assert.equal(stored.lastError, "feishu_rejected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers a due retry record while accepting a later lead", async () => {
    const originalFetch = globalThis.fetch;
    let reject = true;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: reject ? 19021 : 0 }), {
        status: 200,
      });
    try {
      const kv = new MemoryKV();
      const env = {
        CONTACT_SALES_SERVICE_SECRET: SERVICE_SECRET,
        FEISHU_CONTACT_WEBHOOK: "https://open.feishu.cn/test-webhook",
      };
      await call(VELA_TEAM_PLAN_OK, "", {
        env,
        headers: velaServiceHeaders(VELA_TEAM_PLAN_OK),
        kv,
        now: SERVICE_NOW,
      });
      const firstKey = `contact-delivery:${VELA_TEAM_PLAN_OK.eventId}`;
      const first = JSON.parse(kv.values.get(firstKey)?.value ?? "{}");
      first.nextAttemptAt = new Date(SERVICE_NOW - 1).toISOString();
      kv.values.set(firstKey, { value: JSON.stringify(first) });

      reject = false;
      const laterLead = {
        ...VELA_TEAM_PLAN_OK,
        eventId: "evt-vela-team-plan-2",
        email: "second@example.com",
      };
      const later = await call(laterLead, "", {
        env,
        headers: velaServiceHeaders(laterLead, {
          eventId: laterLead.eventId,
        }),
        kv,
        now: SERVICE_NOW,
      });

      assert.equal(later.status, 200);
      assert.equal(
        JSON.parse(kv.values.get(firstKey)?.value ?? "{}").status,
        "delivered",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
