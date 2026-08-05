import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { auditToolCodexProductSession } from "../src/product.js";
import {
  initializeToolCodexEnvironment,
  resolveToolCodexPaths,
  type ToolCodexPaths,
} from "../src/state.js";

const SESSION_ID = "019fd1fa-75ee-75b2-b291-f986f200866e";
const WORKFLOW_ID = "deea1101-c18d-4c2d-ad35-7a7f65d88275";
const REQUEST_ID = "2b6ca3b5-e12e-49f1-8b4a-226bfee53d17";
const RUN_ID = "0128049b-b45d-4b6c-8ab7-7e139965e560";
const PROJECT_ID = "the-corner-cup-neighborhood-coffee-shop-b6fe";
const PLUGIN_ID = "open-design@open-design-release-beta-product-darwin-arm64";
const roots: string[] = [];

type JsonRecord = Record<string, unknown>;

function completedCall(
  tool: string,
  args: JsonRecord,
  result: JsonRecord,
): JsonRecord {
  return {
    timestamp: "2026-08-05T12:51:46.437Z",
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      invocation: {
        server: "open-design",
        tool,
        arguments: args,
      },
      plugin_id: PLUGIN_ID,
      result: {
        Ok: {
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      },
    },
  };
}

function validProductEvents(): JsonRecord[] {
  const boundary =
    "This run is already the selected Local Codex execution inside Open Design.";
  return [
    { type: "session_meta", payload: { id: SESSION_ID } },
    completedCall("collect_brief", {
      artifactType: "website",
      skip: true,
    }, {
      pluginWorkflowId: WORKFLOW_ID,
    }),
    completedCall("confirm_brief", {}, {
      pluginWorkflowId: WORKFLOW_ID,
    }),
    completedCall("list_projects", { pluginWorkflowId: WORKFLOW_ID }, {
      projects: [],
    }),
    completedCall("list_agents", { pluginWorkflowId: WORKFLOW_ID }, {
      agents: [{ id: "codex", available: true }],
    }),
    completedCall("create_project", { pluginWorkflowId: WORKFLOW_ID }, {
      project: { id: PROJECT_ID },
    }),
    completedCall("start_run", {
      agent: "codex",
      pluginWorkflowId: WORKFLOW_ID,
      project: PROJECT_ID,
      prompt: `Build the artifact. ${boundary} Do not route this request again.`,
      requestId: REQUEST_ID,
    }, {
      pluginWorkflowId: WORKFLOW_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      runId: RUN_ID,
    }),
    completedCall("get_run", {
      pluginWorkflowId: WORKFLOW_ID,
      runId: RUN_ID,
    }, {
      id: RUN_ID,
      projectId: PROJECT_ID,
      status: "running",
    }),
    completedCall("get_run", {
      pluginWorkflowId: WORKFLOW_ID,
      runId: RUN_ID,
    }, {
      deliverableValid: true,
      id: RUN_ID,
      previewUrl: `http://127.0.0.1:61484/api/projects/${PROJECT_ID}/raw/index.html`,
      projectId: PROJECT_ID,
      status: "succeeded",
    }),
  ];
}

async function createManagedRollout(events: JsonRecord[]): Promise<ToolCodexPaths> {
  const root = await mkdtemp(join(tmpdir(), "open-design-product-trace-"));
  roots.push(root);
  const paths = resolveToolCodexPaths({
    namespace: "desktop-smoke",
    stateRoot: join(root, "tools-codex"),
  });
  await initializeToolCodexEnvironment(paths);
  const sessionDir = join(paths.codexHome, "sessions", "2026", "08", "05");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `rollout-${SESSION_ID}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return paths;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("tools-codex product trace audit", () => {
  it("accepts one complete Local Codex product lifecycle and persists a minimal report", async () => {
    const paths = await createManagedRollout(validProductEvents());

    const report = await auditToolCodexProductSession({
      mode: "local-codex",
      paths,
      sessionId: SESSION_ID,
    });

    expect(report.status).toBe("PASS");
    expect(report.failures).toEqual([]);
    expect(report.calls).toMatchObject({ start_run: 1, get_run: 2 });
    expect(report.lifecycle).toMatchObject({
      pluginWorkflowId: WORKFLOW_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      runId: RUN_ID,
    });
    expect(JSON.parse(await readFile(paths.productTraceReportPath, "utf8"))).toMatchObject({
      sessionId: SESSION_ID,
      status: "PASS",
    });
    expect(await readFile(paths.productTraceReportPath, "utf8")).not.toContain(
      "Build the artifact",
    );
  });

  it("accepts an available agent returned by the default filtered listing", async () => {
    const events = validProductEvents();
    const listAgents = events.find((event) =>
      (event.payload as JsonRecord | undefined)?.type === "mcp_tool_call_end"
      && ((event.payload as JsonRecord).invocation as JsonRecord).tool === "list_agents"
    )!;
    const result = (listAgents.payload as JsonRecord).result as JsonRecord;
    const ok = result.Ok as JsonRecord;
    const content = ok.content as JsonRecord[];
    content[0]!.text = JSON.stringify({ agents: [{ id: "codex" }] });
    const paths = await createManagedRollout(events);

    const report = await auditToolCodexProductSession({
      mode: "local-codex",
      paths,
      sessionId: SESSION_ID,
    });

    expect(report.status).toBe("PASS");
    expect(report.signals.codexAgentAvailable).toBe(true);
  });

  it("fails closed when Local Codex is started more than once", async () => {
    const events = validProductEvents();
    events.push(events.find((event) =>
      (event.payload as JsonRecord | undefined)?.type === "mcp_tool_call_end"
      && ((event.payload as JsonRecord).invocation as JsonRecord).tool === "start_run"
    )!);
    const paths = await createManagedRollout(events);

    const report = await auditToolCodexProductSession({
      mode: "local-codex",
      paths,
      sessionId: SESSION_ID,
    });

    expect(report.status).toBe("FAIL");
    expect(report.failures).toContain("startRunExactlyOnce");
  });

  it("rejects a non-canonical managed session id", async () => {
    const paths = await createManagedRollout(validProductEvents());

    await expect(auditToolCodexProductSession({
      mode: "local-codex",
      paths,
      sessionId: "../../foreign",
    })).rejects.toMatchObject({ code: "PRODUCT_SESSION_ID_INVALID" });
  });
});
