/*
 * /contact-sales — Workspace-for-Teams lead intake.
 *
 * The /enterprise/ page and the /pricing/ "Request team access" modal (both
 * rendering the shared lead form) POST a lead here; Vela also relays signed
 * Team-plan leads server-to-server. We validate each lead, synchronously persist
 * it to KV, and fan it out to a Feishu (Lark) custom-bot webhook. Failed Feishu
 * deliveries remain retryable in KV so an outage never silently drops a lead.
 * Mirrors the safety posture of `subscribe.ts` (CORS allowlist, no PII in
 * provider logs, idempotent KV keys, notification delivery on `waitUntil`).
 *
 * Config (Cloudflare Pages env):
 * - FEISHU_CONTACT_WEBHOOK  custom-bot incoming webhook URL (required to notify)
 * - FEISHU_CONTACT_SECRET   optional bot signing secret (set if the bot enforces
 *                           signature verification)
 * - CONTACT_SALES_SERVICE_SECRET
 *                           HMAC secret shared only with trusted Vela callers
 * - CONTACT_LEADS           required KV namespace for durable acknowledgement
 *                           and retry state
 */
type KVNamespace = {
  get(key: string): Promise<string | null>;
  list?(options?: {
    cursor?: string;
    limit?: number;
    prefix?: string;
  }): Promise<{
    cursor?: string;
    keys: Array<{ name: string }>;
    list_complete: boolean;
  }>;
  put(key: string, value: string): Promise<void>;
};

type PagesFunctionContext<Env> = {
  request: Request & { cf?: Record<string, unknown> };
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  /** Test seam; Cloudflare does not provide this field. */
  now?: () => number;
};

type PagesFunction<Env> = (context: PagesFunctionContext<Env>) => Response | Promise<Response>;

interface Env {
  CONTACT_SALES_SERVICE_SECRET?: string;
  CONTACT_LEADS?: KVNamespace;
  FEISHU_CONTACT_WEBHOOK?: string;
  FEISHU_CONTACT_SECRET?: string;
}

type ContactLead = {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  budget: string;
  useCases: string[];
  /** Canonical industry enum code (see ALLOWED_INDUSTRIES). */
  industry: string;
  role: string;
  /** User-entered country / region (distinct from the Cloudflare geo below). */
  location: string;
  /** Expected seat count (free text, e.g. "20"). */
  seats: string;
  message: string;
  source: string;
  locale: string;
  pageUrl: string;
  submittedAt: string;
  referer: string | null;
  billingInterval?: "monthly" | "yearly";
  country?: string;
  region?: string;
};

type ContactDeliveryStatus =
  | "dead_letter"
  | "delivered"
  | "pending"
  | "retry";

type ContactDeliveryRecord = {
  eventId: string;
  lead: ContactLead;
  status: ContactDeliveryStatus;
  attempt: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

const ALLOWED_ORIGINS = [
  "https://open-design.ai",
  "https://www.open-design.ai",
  "https://staging.open-design.ai",
  "od://app",
  "tauri://localhost",
  "http://localhost",
  "http://127.0.0.1",
];

// Strict shape, not the loose "no whitespace, one @, a dot" check: the 07-11
// SQLi scan submitted payloads like `testing@example.com'||dbms_pipe...` that
// the loose regex accepted into KV and which then broke the downstream Bitable
// sync (its email column rejects them, and the batch insert is atomic).
// Local part: common atom charset incl. apostrophe (o'brien@…). Domain:
// hyphenated alphanumeric labels with a letters-only TLD — no quotes, pipes,
// parens, or `&`/`=` can survive this.
const EMAIL_RE =
  /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_SHORT = 200;
const MAX_MESSAGE = 4000;
// `enterprise` = the /enterprise page and `pricing_team` = the /pricing
// "Request team access" modal — both render the same shared lead form
// (app/_components/enterprise-lead-form.astro) and submit the same strict
// contract; only the source differs for attribution. `client` = in-app
// (reserved; keeps the pre-industry contract with a required name).
const VELA_TEAM_PLAN_SOURCE = "vela_team_plan";
const ALLOWED_SOURCES = new Set([
  "enterprise",
  "pricing_team",
  "client",
  VELA_TEAM_PLAN_SOURCE,
]);
const SHARED_LEAD_FORM_SOURCES = new Set([
  "enterprise",
  "pricing_team",
  VELA_TEAM_PLAN_SOURCE,
]);
const CONTACT_DELIVERY_PREFIX = "contact-delivery:";
const SERVICE_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DELIVERY_ATTEMPTS_PER_INVOCATION = 3;
const DELIVERY_MAX_ATTEMPTS = 9;
const DELIVERY_RETRY_DELAY_MS = 60 * 1000;
const ALLOWED_TEAM_SIZES = new Set(["1-10", "11-50", "51-200", "200+"]);
const ALLOWED_BUDGETS = new Set([
  "lt_50",
  "usd_50_200",
  "usd_200_1k",
  "usd_1k_5k",
  "usd_5k_plus",
  "unsure",
]);
// Both surfaces submit the same canonical budget enum codes; the card maps a
// known code to a readable label and otherwise shows the raw value.
const BUDGET_LABELS: Record<string, string> = {
  lt_50: "每月 $50 以下",
  usd_50_200: "每月 $50 – $200",
  usd_200_1k: "每月 $200 – $1,000",
  usd_1k_5k: "每月 $1,000 – $5,000",
  usd_5k_plus: "每月 $5,000 以上",
  unsure: "还不确定",
};
// Canonical team-size enum → readable label (shared by both surfaces).
const TEAM_SIZE_LABELS: Record<string, string> = {
  "1-10": "1–10 人",
  "11-50": "11–50 人",
  "51-200": "51–200 人",
  "200+": "200 人以上",
};
// /enterprise submits expected seats as one of these range codes; the pricing
// modal still sends free numeric text, so the card falls back to the raw value.
const ALLOWED_SEATS = new Set([
  "1-5",
  "5-10",
  "10-20",
  "20-50",
  "50-100",
  "100-200",
  "200-500",
  "500+",
]);
const SEAT_LABELS: Record<string, string> = {
  "1-5": "1–5 个",
  "5-10": "5–10 个",
  "10-20": "10–20 个",
  "20-50": "20–50 个",
  "50-100": "50–100 个",
  "100-200": "100–200 个",
  "200-500": "200–500 个",
  "500+": "500 个以上",
};
const ALLOWED_USE_CASES = new Set([
  "product_design",
  "design_system",
  "prototype",
  "marketing",
  "brand",
  "social_media",
  "poster_print",
  "deck",
  "video_motion",
  "illustration",
  "dashboards",
  "education",
  "game_assets",
  "other",
]);
// Canonical industry enum (required on the shared lead form) → readable card
// label. Keep in lockstep with `industryOptions` in
// app/_lib/enterprise-lead-copy.ts.
const ALLOWED_INDUSTRIES = new Set([
  "internet_software",
  "ecommerce_retail",
  "advertising_marketing",
  "finance",
  "education",
  "gaming",
  "media_entertainment",
  "manufacturing",
  "healthcare",
  "government_nonprofit",
  "other",
]);
const INDUSTRY_LABELS: Record<string, string> = {
  internet_software: "互联网 / 软件",
  ecommerce_retail: "电商 / 零售",
  advertising_marketing: "广告 / 营销服务",
  finance: "金融",
  education: "教育培训",
  gaming: "游戏",
  media_entertainment: "文化传媒 / 娱乐",
  manufacturing: "制造业 / 硬件",
  healthcare: "医疗健康",
  government_nonprofit: "政府 / 非营利",
  other: "其他",
};
const USE_CASE_LABELS: Record<string, string> = {
  product_design: "产品与应用设计",
  design_system: "设计系统",
  prototype: "原型 / 应用 UI",
  marketing: "营销与落地页",
  brand: "品牌视觉 / VI",
  social_media: "社媒内容 / 电商素材",
  poster_print: "海报 / 印刷物料",
  deck: "演示文稿 / Deck",
  video_motion: "视频 / 动效",
  illustration: "插画 / 图像生成",
  dashboards: "仪表盘 / 内部工具",
  education: "教学 / 课件",
  game_assets: "游戏素材",
  other: "其他",
};

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin &&
    ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(`${o}:`))
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifyServiceSignature(options: {
  eventId: string;
  nowMs: number;
  rawBody: string;
  request: Request;
  secret: string;
}): Promise<
  | "service_auth_expired"
  | "service_auth_invalid"
  | "service_auth_required"
  | null
> {
  const timestampValue = options.request.headers.get("x-od-service-timestamp");
  const headerEventId = options.request.headers.get("x-od-service-event-id");
  const signatureValue = options.request.headers.get("x-od-service-signature");
  if (!timestampValue || !headerEventId || !signatureValue) {
    return "service_auth_required";
  }
  if (
    headerEventId !== options.eventId ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(headerEventId) ||
    !/^\d{13}$/u.test(timestampValue)
  ) {
    return "service_auth_invalid";
  }
  const timestamp = Number(timestampValue);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(options.nowMs - timestamp) > SERVICE_SIGNATURE_MAX_AGE_MS
  ) {
    return "service_auth_expired";
  }

  const signature = base64UrlToBytes(signatureValue);
  if (!signature) return "service_auth_invalid";
  const bodyDigest = await sha256Hex(options.rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature).buffer,
    new TextEncoder().encode(
      `${timestampValue}\n${headerEventId}\n${bodyDigest}`,
    ),
  );
  return valid ? null : "service_auth_invalid";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Accept a multi-select use-case array; keep only known, de-duplicated values.
function readUseCases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && ALLOWED_USE_CASES.has(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

// Feishu custom-bot signature: base64(HmacSHA256(key = `${timestamp}\n${secret}`, data = "")).
async function feishuSignature(secret: string, timestamp: number): Promise<string> {
  const keyBytes = new TextEncoder().encode(`${timestamp}\n${secret}`);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new Uint8Array(0));
  return bytesToBase64(new Uint8Array(sig));
}

function buildFeishuCard(lead: ContactLead): Record<string, unknown> {
  const fieldRow = (label: string, value: string) => ({
    is_short: true,
    text: { tag: "lark_md", content: `**${label}**\n${value || "—"}` },
  });
  const geo = [lead.country, lead.region].filter(Boolean).join(" / ");
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "🚀 新的「团队版」留资线索" },
    },
    elements: [
      {
        tag: "div",
        fields: [
          fieldRow("姓名", lead.name),
          fieldRow("企业邮箱", lead.email),
          fieldRow("公司", lead.company),
          fieldRow("团队规模", TEAM_SIZE_LABELS[lead.teamSize] ?? lead.teamSize),
          fieldRow("国家 / 地区", lead.location),
          fieldRow("预计席位数", SEAT_LABELS[lead.seats] ?? lead.seats),
          fieldRow("预算", BUDGET_LABELS[lead.budget] ?? lead.budget),
          fieldRow("所属行业", INDUSTRY_LABELS[lead.industry] ?? lead.industry),
          fieldRow("使用场景", lead.useCases.map((v) => USE_CASE_LABELS[v] ?? v).join("、")),
          fieldRow("职位", lead.role),
          fieldRow("语言", lead.locale),
        ],
      },
      ...(lead.message
        ? [
            { tag: "hr" },
            {
              tag: "div",
              text: { tag: "lark_md", content: `**留言**\n${lead.message}` },
            },
          ]
        : []),
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `来源：${lead.source}${geo ? ` · ${geo}` : ""} · ${lead.submittedAt}`,
          },
        ],
      },
    ],
  };
}

type DeliveryErrorCode =
  | "feishu_http_failed"
  | "feishu_rejected"
  | "feishu_request_failed"
  | "feishu_unconfigured";

type DeliveryAttemptResult =
  | { ok: true }
  | {
      error: DeliveryErrorCode;
      ok: false;
    };

async function notifyFeishu(
  env: Env,
  lead: ContactLead,
): Promise<DeliveryAttemptResult> {
  const webhook = env.FEISHU_CONTACT_WEBHOOK?.trim();
  if (!webhook) {
    console.warn("contact_sales_feishu_unset: FEISHU_CONTACT_WEBHOOK missing; KV only");
    return { ok: false, error: "feishu_unconfigured" };
  }

  const body: Record<string, unknown> = {
    msg_type: "interactive",
    card: buildFeishuCard(lead),
  };

  const secret = env.FEISHU_CONTACT_SECRET?.trim();
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = await feishuSignature(secret, timestamp);
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("contact_sales_feishu_failed", JSON.stringify({ status: res.status }));
      return { ok: false, error: "feishu_http_failed" };
    }
    // Feishu returns 200 with a JSON body even on logical failure (e.g. bad sign).
    const data = (await res.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    if (!data || data.code !== 0) {
      console.warn(
        "contact_sales_feishu_rejected",
        JSON.stringify({
          code: typeof data?.code === "number" ? data.code : "invalid",
        }),
      );
      return { ok: false, error: "feishu_rejected" };
    }
    return { ok: true };
  } catch {
    console.warn("contact_sales_feishu_request_failed");
    return { ok: false, error: "feishu_request_failed" };
  }
}

class ContactSalesPersistenceError extends Error {
  readonly code: "lead_storage_failed" | "lead_storage_unavailable";

  constructor(code: "lead_storage_failed" | "lead_storage_unavailable") {
    super(code);
    this.name = "ContactSalesPersistenceError";
    this.code = code;
  }
}

function deliveryKey(eventId: string): string {
  return `${CONTACT_DELIVERY_PREFIX}${eventId}`;
}

function parseDeliveryRecord(value: string | null): ContactDeliveryRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ContactDeliveryRecord>;
    if (
      typeof parsed.eventId !== "string" ||
      typeof parsed.attempt !== "number" ||
      typeof parsed.status !== "string" ||
      !parsed.lead
    ) {
      return null;
    }
    return parsed as ContactDeliveryRecord;
  } catch {
    return null;
  }
}

async function persistLead(
  env: Env,
  lead: ContactLead,
  eventId: string,
  nowMs: number,
): Promise<{
  duplicate: boolean;
  key: string;
  record: ContactDeliveryRecord;
}> {
  const kv = env.CONTACT_LEADS;
  if (!kv) {
    console.warn(
      "contact_sales_kv_unbound: CONTACT_LEADS binding missing; lead not persisted",
      JSON.stringify({ source: lead.source, country: lead.country }),
    );
    throw new ContactSalesPersistenceError("lead_storage_unavailable");
  }

  const key = deliveryKey(eventId);
  try {
    const existing = parseDeliveryRecord(await kv.get(key));
    if (existing?.eventId === eventId) {
      return { duplicate: true, key, record: existing };
    }

    const nowIso = new Date(nowMs).toISOString();
    const record: ContactDeliveryRecord = {
      eventId,
      lead,
      status: "pending",
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: nowIso,
    };
    // Latest submission per email remains the operational backup. The
    // event-scoped record is the durable delivery state and idempotency key.
    const leadKey = `lead:${await sha256Hex(lead.email)}`;
    await Promise.all([
      kv.put(leadKey, JSON.stringify(lead)),
      kv.put(key, JSON.stringify(record)),
    ]);
    return { duplicate: false, key, record };
  } catch (error) {
    if (error instanceof ContactSalesPersistenceError) throw error;
    console.warn("contact_sales_kv_write_failed");
    throw new ContactSalesPersistenceError("lead_storage_failed");
  }
}

function retryIsDue(record: ContactDeliveryRecord, nowMs: number): boolean {
  if (record.status === "pending") return true;
  if (record.status !== "retry" || !record.nextAttemptAt) return false;
  const nextAttemptAt = Date.parse(record.nextAttemptAt);
  return Number.isFinite(nextAttemptAt) && nextAttemptAt <= nowMs;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function deliverRecord(
  env: Env,
  kv: KVNamespace,
  record: ContactDeliveryRecord,
  nowMs: number,
): Promise<void> {
  if (
    record.status === "delivered" ||
    record.status === "dead_letter" ||
    !retryIsDue(record, nowMs)
  ) {
    return;
  }

  let attempt = record.attempt;
  let lastError: DeliveryErrorCode = "feishu_request_failed";
  for (
    let invocationAttempt = 0;
    invocationAttempt < DELIVERY_ATTEMPTS_PER_INVOCATION &&
    attempt < DELIVERY_MAX_ATTEMPTS;
    invocationAttempt += 1
  ) {
    attempt += 1;
    const result = await notifyFeishu(env, record.lead);
    if (result.ok) {
      await kv.put(
        deliveryKey(record.eventId),
        JSON.stringify({
          ...record,
          status: "delivered",
          attempt,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: new Date(nowMs).toISOString(),
        } satisfies ContactDeliveryRecord),
      );
      return;
    }
    if (!("error" in result)) continue;
    lastError = result.error;
    // Missing configuration cannot recover within this invocation. Persist it
    // immediately so operations can repair the binding without losing the lead.
    if (result.error === "feishu_unconfigured") break;
    if (
      invocationAttempt + 1 < DELIVERY_ATTEMPTS_PER_INVOCATION &&
      attempt < DELIVERY_MAX_ATTEMPTS
    ) {
      await wait(invocationAttempt === 0 ? 250 : 1_000);
    }
  }

  const exhausted = attempt >= DELIVERY_MAX_ATTEMPTS;
  await kv.put(
    deliveryKey(record.eventId),
    JSON.stringify({
      ...record,
      status: exhausted ? "dead_letter" : "retry",
      attempt,
      nextAttemptAt: exhausted
        ? null
        : new Date(nowMs + DELIVERY_RETRY_DELAY_MS).toISOString(),
      lastError,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies ContactDeliveryRecord),
  );
  console.warn(
    exhausted
      ? "contact_sales_delivery_dead_lettered"
      : "contact_sales_delivery_retry_scheduled",
    JSON.stringify({ attempt, error: lastError, eventId: record.eventId }),
  );
}

async function drainDueDeliveries(
  env: Env,
  nowMs: number,
  excludedKey: string,
): Promise<void> {
  const kv = env.CONTACT_LEADS;
  if (!kv?.list) return;
  try {
    const result = await kv.list({
      limit: 10,
      prefix: CONTACT_DELIVERY_PREFIX,
    });
    for (const item of result.keys) {
      if (item.name === excludedKey) continue;
      const record = parseDeliveryRecord(await kv.get(item.name));
      if (record && retryIsDue(record, nowMs)) {
        await deliverRecord(env, kv, record, nowMs);
      }
    }
  } catch {
    console.warn("contact_sales_retry_drain_failed");
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const request = context.request;
  const origin = request.headers.get("origin");
  const nowMs = context.now?.() ?? Date.now();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, origin);
  }

  let rawBody: string;
  let payload: Record<string, unknown>;
  try {
    rawBody = await request.text();
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid JSON object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, origin);
  }

  const email = readString(payload.email, MAX_EMAIL_LENGTH).toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400, origin);
  }

  // Reject unrecognized sources up front. This is a public write endpoint, so a
  // typoed/unknown source must return 400 rather than silently falling through
  // to the relaxed path and persisting arbitrary leads.
  const source =
    typeof payload.source === "string" && ALLOWED_SOURCES.has(payload.source)
      ? payload.source
      : null;
  if (!source) {
    return json({ ok: false, error: "invalid_source" }, 400, origin);
  }

  let serviceEventId: string | null = null;
  if (source === VELA_TEAM_PLAN_SOURCE) {
    serviceEventId = readString(payload.eventId, 200);
    const serviceSecret = context.env.CONTACT_SALES_SERVICE_SECRET?.trim();
    if (!serviceSecret) {
      console.warn(
        "contact_sales_service_auth_unconfigured: CONTACT_SALES_SERVICE_SECRET missing",
      );
      return json(
        { ok: false, error: "service_auth_unavailable" },
        503,
        origin,
      );
    }
    const authError = await verifyServiceSignature({
      eventId: serviceEventId,
      nowMs,
      rawBody,
      request,
      secret: serviceSecret,
    });
    if (authError) {
      return json({ ok: false, error: authError }, 401, origin);
    }
  }

  // The shared lead form (enterprise + pricing_team) no longer asks for a
  // name (email is the contact handle); every other source still requires one.
  const isSharedLeadForm = SHARED_LEAD_FORM_SOURCES.has(source);
  const name = readString(payload.name, MAX_SHORT);
  if (!name && !isSharedLeadForm) {
    return json({ ok: false, error: "missing_fields" }, 400, origin);
  }

  const company = readString(payload.company, MAX_SHORT);
  const teamSize = readString(payload.teamSize, MAX_SHORT);
  const budget = readString(payload.budget, MAX_SHORT);
  const seats = readString(payload.seats, MAX_SHORT);
  const location =
    readString(payload.location, MAX_SHORT) ||
    (source === VELA_TEAM_PLAN_SOURCE
      ? readString(payload.country, MAX_SHORT)
      : "");
  const useCases =
    source === VELA_TEAM_PLAN_SOURCE
      ? readUseCases([payload.useCase])
      : readUseCases(payload.useCases);
  // Unknown industry codes are dropped rather than persisted; the shared lead
  // form requires a known one below.
  const industryRaw = readString(payload.industry, MAX_SHORT);
  const industry = ALLOWED_INDUSTRIES.has(industryRaw) ? industryRaw : "";

  // Every allowlisted source submits the full contact-form contract: known
  // team-size/seat-range/budget enums + a use case (company is optional).
  // Since the /pricing modal now renders the same shared form as /enterprise,
  // its old relaxed name+email-only path is gone.
  if (
    !ALLOWED_TEAM_SIZES.has(teamSize) ||
    !ALLOWED_SEATS.has(seats) ||
    !ALLOWED_BUDGETS.has(budget) ||
    (isSharedLeadForm && !location) ||
    useCases.length === 0
  ) {
    return json({ ok: false, error: "missing_fields" }, 400, origin);
  }

  // Industry is a required pick on the shared lead form; the reserved in-app
  // `client` source predates the field and may omit it.
  if (isSharedLeadForm && !industry) {
    return json({ ok: false, error: "missing_fields" }, 400, origin);
  }

  const cf = request.cf || {};
  const billingInterval =
    payload.billingInterval === "monthly" ||
    payload.billingInterval === "yearly"
      ? payload.billingInterval
      : undefined;
  const lead: ContactLead = {
    name,
    email,
    company,
    teamSize,
    budget,
    useCases,
    industry,
    role: readString(payload.role, MAX_SHORT),
    location,
    seats,
    message: readString(payload.message, MAX_MESSAGE),
    source,
    locale: readString(payload.locale, 16) || "en",
    pageUrl: readString(payload.pageUrl, 512),
    submittedAt: new Date(nowMs).toISOString(),
    referer: request.headers.get("referer"),
    billingInterval,
    country: typeof cf.country === "string" ? cf.country : undefined,
    region: typeof cf.region === "string" ? cf.region : undefined,
  };

  const eventId =
    serviceEventId ||
    (await sha256Hex(
      `${lead.source}:${lead.email}:${lead.submittedAt}:${rawBody}`,
    ));
  let persisted: Awaited<ReturnType<typeof persistLead>>;
  try {
    persisted = await persistLead(context.env, lead, eventId, nowMs);
  } catch (error) {
    const code =
      error instanceof ContactSalesPersistenceError
        ? error.code
        : "lead_storage_failed";
    return json({ ok: false, error: code }, 503, origin);
  }

  const kv = context.env.CONTACT_LEADS;
  if (!kv) {
    // persistLead fails closed when unbound. This guard only keeps the type
    // refinement explicit for the background delivery task.
    return json(
      { ok: false, error: "lead_storage_unavailable" },
      503,
      origin,
    );
  }
  context.waitUntil(
    Promise.all([
      retryIsDue(persisted.record, nowMs)
        ? deliverRecord(context.env, kv, persisted.record, nowMs)
        : Promise.resolve(),
      drainDueDeliveries(context.env, nowMs, persisted.key),
    ]),
  );

  return json(
    {
      ok: true,
      ...(persisted.duplicate ? { duplicate: true } : {}),
    },
    200,
    origin,
  );
};

export const __contactSalesTest = {
  corsHeaders,
  buildFeishuCard,
  feishuSignature,
  verifyServiceSignature,
};
