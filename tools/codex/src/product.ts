import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  ToolCodexError,
  writeToolCodexReport,
  type ToolCodexPaths,
} from "./state.js";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CORRELATION_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/iu;
const LOCAL_CODEX_BOUNDARY =
  "This run is already the selected Local Codex execution inside Open Design.";
const CLOUD_LOGIN_TOOLS = new Set(["get_vela_login_status", "start_vela_login"]);
const DISTRIBUTION_DIAGNOSTIC_TOOLS = new Set([
  "ensure_open_design_runtime",
  "get_open_design_status",
]);

type JsonRecord = Record<string, unknown>;

type ProductToolCall = {
  arguments: JsonRecord;
  ok: boolean;
  pluginId: string | null;
  result: JsonRecord | null;
  tool: string;
};

export type ToolCodexProductMode = "local-codex";

export type ToolCodexProductTraceSignals = {
  briefStartedExactlyOnce: boolean;
  briefResolved: boolean;
  cloudLoginAbsent: boolean;
  codexAgentAvailable: boolean;
  correlationIdsValid: boolean;
  deliverableValid: boolean;
  deliveryUrlPresent: boolean;
  diagnosticToolsAbsent: boolean;
  externalContextCallerAbsent: boolean;
  localCodexBoundaryPresent: boolean;
  onePluginIdentity: boolean;
  oneWorkflow: boolean;
  pollingObserved: boolean;
  projectConsistent: boolean;
  projectResolved: boolean;
  startRunExactlyOnce: boolean;
  terminalSuccess: boolean;
  toolCallsSucceeded: boolean;
};

export type ToolCodexProductTraceReport = {
  calls: Record<string, number>;
  failures: string[];
  generatedAt: string;
  lifecycle: {
    deliveryUrl: string | null;
    pluginId: string | null;
    pluginWorkflowId: string | null;
    projectId: string | null;
    requestId: string | null;
    runId: string | null;
  };
  mode: ToolCodexProductMode;
  rollout: {
    path: string;
    sha256: string;
    size: number;
  };
  schemaVersion: 1;
  sessionId: string;
  signals: ToolCodexProductTraceSignals;
  status: "PASS" | "FAIL";
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJsonObject(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseToolResult(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const structured = value.structuredContent ?? value.structured_content;
  if (isRecord(structured)) return structured;
  if (!Array.isArray(value.content)) return null;
  for (const item of value.content) {
    if (!isRecord(item) || item.type !== "text") continue;
    const parsed = parseJsonObject(item.text);
    if (parsed != null) return parsed;
  }
  return null;
}

function parseProductToolCall(value: unknown): ProductToolCall | null {
  if (!isRecord(value)
    || value.type !== "event_msg"
    || !isRecord(value.payload)
    || value.payload.type !== "mcp_tool_call_end"
    || !isRecord(value.payload.invocation)
    || value.payload.invocation.server !== "open-design"
    || typeof value.payload.invocation.tool !== "string") {
    return null;
  }
  const rawResult = value.payload.result;
  const ok = isRecord(rawResult) && Object.prototype.hasOwnProperty.call(rawResult, "Ok");
  return {
    arguments: isRecord(value.payload.invocation.arguments)
      ? value.payload.invocation.arguments
      : {},
    ok,
    pluginId: nonEmptyString(value.payload.plugin_id),
    result: ok && isRecord(rawResult)
      ? parseToolResult(rawResult.Ok)
      : null,
    tool: value.payload.invocation.tool,
  };
}

async function walkRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await walkRegularFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function assertWithinRoot(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return;
  }
  throw new ToolCodexError(
    "PRODUCT_SESSION_PATH_INVALID",
    `Codex product rollout escapes the managed sessions root: ${path}`,
  );
}

async function resolveSessionRollout(
  paths: ToolCodexPaths,
  sessionId: string,
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ToolCodexError(
      "PRODUCT_SESSION_ID_INVALID",
      "--session-id must be a canonical lowercase UUID",
    );
  }
  const sessionsRoot = resolve(paths.codexHome, "sessions");
  const rootInfo = await lstat(sessionsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootInfo == null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ToolCodexError(
      "PRODUCT_SESSIONS_UNAVAILABLE",
      `managed Codex sessions directory is unavailable: ${sessionsRoot}`,
    );
  }
  const canonicalRoot = await realpath(sessionsRoot);
  const candidates = (await walkRegularFiles(sessionsRoot)).filter((path) =>
    path.endsWith(".jsonl") && path.includes(sessionId)
  );
  const matches: string[] = [];
  for (const candidate of candidates) {
    const canonical = await realpath(candidate);
    assertWithinRoot(canonicalRoot, canonical);
    const body = await readFile(canonical, "utf8");
    const hasSession = body.split("\n").some((line) => {
      if (line.length === 0) return false;
      try {
        const event = JSON.parse(line) as unknown;
        return isRecord(event)
          && event.type === "session_meta"
          && isRecord(event.payload)
          && event.payload.id === sessionId;
      } catch {
        return false;
      }
    });
    if (hasSession) matches.push(canonical);
  }
  if (matches.length !== 1) {
    throw new ToolCodexError(
      matches.length === 0
        ? "PRODUCT_SESSION_NOT_FOUND"
        : "PRODUCT_SESSION_AMBIGUOUS",
      matches.length === 0
        ? `managed Codex session was not found: ${sessionId}`
        : `multiple managed Codex rollouts matched session: ${sessionId}`,
    );
  }
  return matches[0]!;
}

function valuesForKey(calls: ProductToolCall[], key: string): string[] {
  return calls.flatMap((call) => {
    const argument = nonEmptyString(call.arguments[key]);
    const result = nonEmptyString(call.result?.[key]);
    return [argument, result].filter((value): value is string => value != null);
  });
}

function oneValue(values: string[]): string | null {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0]! : null;
}

function callCounts(calls: ProductToolCall[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) counts[call.tool] = (counts[call.tool] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function findDeliveryUrl(result: JsonRecord | null): string | null {
  for (const key of ["studioUrl", "previewUrl"]) {
    const value = nonEmptyString(result?.[key]);
    if (value == null) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return value;
    } catch {
      // Keep evaluating the remaining delivery fields.
    }
  }
  return null;
}

function agentAvailable(result: JsonRecord | null, id: string): boolean {
  return Array.isArray(result?.agents) && result.agents.some((agent) =>
    isRecord(agent) && agent.id === id && agent.available !== false
  );
}

export async function auditToolCodexProductSession(options: {
  mode: ToolCodexProductMode;
  outputPath?: string;
  paths: ToolCodexPaths;
  sessionId: string;
}): Promise<ToolCodexProductTraceReport> {
  const rolloutPath = await resolveSessionRollout(options.paths, options.sessionId);
  const rolloutBytes = await readFile(rolloutPath);
  const rolloutText = rolloutBytes.toString("utf8");
  const calls = rolloutText.split("\n").flatMap((line) => {
    if (line.length === 0) return [];
    try {
      const call = parseProductToolCall(JSON.parse(line) as unknown);
      return call == null ? [] : [call];
    } catch {
      return [];
    }
  });
  if (calls.length === 0) {
    throw new ToolCodexError(
      "PRODUCT_TRACE_UNAVAILABLE",
      "the managed Codex session contains no completed Open Design product tool calls",
    );
  }

  const byTool = (tool: string) => calls.filter((call) => call.tool === tool);
  const collectCalls = byTool("collect_brief");
  const confirmCalls = byTool("confirm_brief");
  const listAgentCalls = byTool("list_agents");
  const createProjectCalls = byTool("create_project");
  const startCalls = byTool("start_run");
  const pollCalls = byTool("get_run");
  const terminalResult = [...pollCalls].reverse().find((call) =>
    ["succeeded", "failed", "canceled"].includes(String(call.result?.status))
  )?.result ?? null;
  const collectSkipped = collectCalls[0]?.arguments.skip === true;

  const workflowValues = valuesForKey(calls, "pluginWorkflowId");
  const requestValues = valuesForKey(startCalls, "requestId");
  const runValues = [
    ...valuesForKey(startCalls, "runId"),
    ...valuesForKey(pollCalls, "runId"),
    ...valuesForKey(pollCalls, "id"),
  ];
  const projectValues = [
    ...valuesForKey(startCalls, "project"),
    ...valuesForKey(startCalls, "projectId"),
    ...valuesForKey(pollCalls, "projectId"),
    ...createProjectCalls.flatMap((call) => {
      const project = isRecord(call.result?.project) ? call.result.project : null;
      const id = nonEmptyString(project?.id);
      return id == null ? [] : [id];
    }),
  ];
  const pluginIds = calls.map((call) => call.pluginId).filter(
    (value): value is string => value != null,
  );
  const pluginWorkflowId = oneValue(workflowValues);
  const requestId = oneValue(requestValues);
  const runId = oneValue(runValues);
  const projectId = oneValue(projectValues);
  const pluginId = oneValue(pluginIds);
  const deliveryUrl = findDeliveryUrl(terminalResult);
  const startPrompt = nonEmptyString(startCalls[0]?.arguments.prompt);
  const allCallsShareWorkflow = pluginWorkflowId != null && calls.every((call) =>
    valuesForKey([call], "pluginWorkflowId").includes(pluginWorkflowId)
  );

  const signals: ToolCodexProductTraceSignals = {
    briefStartedExactlyOnce: collectCalls.length === 1,
    briefResolved: collectCalls.length === 1
      && (collectSkipped ? confirmCalls.length <= 1 : confirmCalls.length === 1),
    cloudLoginAbsent: calls.every((call) => !CLOUD_LOGIN_TOOLS.has(call.tool)),
    codexAgentAvailable: listAgentCalls.some((call) => agentAvailable(call.result, "codex")),
    correlationIdsValid: pluginWorkflowId != null
      && requestId != null
      && runId != null
      && CORRELATION_ID_PATTERN.test(pluginWorkflowId)
      && CORRELATION_ID_PATTERN.test(requestId)
      && CORRELATION_ID_PATTERN.test(runId),
    deliverableValid: terminalResult?.deliverableValid === true,
    deliveryUrlPresent: deliveryUrl != null,
    diagnosticToolsAbsent: calls.every((call) =>
      !DISTRIBUTION_DIAGNOSTIC_TOOLS.has(call.tool)
    ),
    externalContextCallerAbsent: collectCalls.length === 1
      && collectCalls[0]?.arguments.externalPluginContext === undefined,
    localCodexBoundaryPresent: startPrompt?.includes(LOCAL_CODEX_BOUNDARY) === true,
    onePluginIdentity: pluginId != null
      && pluginIds.length === calls.length
      && pluginId.startsWith("open-design@"),
    oneWorkflow: allCallsShareWorkflow,
    pollingObserved: pollCalls.length >= 1,
    projectConsistent: projectId != null,
    projectResolved: projectId != null
      && (createProjectCalls.length === 1 || byTool("list_projects").length >= 1),
    startRunExactlyOnce: startCalls.length === 1
      && startCalls[0]?.arguments.agent === "codex",
    terminalSuccess: terminalResult?.status === "succeeded",
    toolCallsSucceeded: calls.every((call) => call.ok),
  };
  const failures = Object.entries(signals)
    .filter(([, passed]) => !passed)
    .map(([signal]) => signal);
  const report: ToolCodexProductTraceReport = {
    calls: callCounts(calls),
    failures,
    generatedAt: new Date().toISOString(),
    lifecycle: {
      deliveryUrl,
      pluginId,
      pluginWorkflowId,
      projectId,
      requestId,
      runId,
    },
    mode: options.mode,
    rollout: {
      path: rolloutPath,
      sha256: `sha256:${createHash("sha256").update(rolloutBytes).digest("hex")}`,
      size: (await stat(rolloutPath)).size,
    },
    schemaVersion: 1,
    sessionId: options.sessionId,
    signals,
    status: failures.length === 0 ? "PASS" : "FAIL",
  };
  await writeToolCodexReport(
    options.paths,
    options.outputPath ?? options.paths.productTraceReportPath,
    report,
  );
  return report;
}
