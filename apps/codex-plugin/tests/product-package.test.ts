import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_ROOT, "..", "plugin", "open-design");

describe("Codex plugin product package", () => {
  it("presents Open Design as a creation product instead of a status shell", async () => {
    const manifest = JSON.parse(await readFile(
      join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
      "utf8",
    )) as {
      description?: string;
      interface?: {
        capabilities?: string[];
        composerIcon?: string;
        defaultPrompt?: string[];
        logo?: string;
        longDescription?: string;
        shortDescription?: string;
      };
    };

    expect(manifest.description).toContain("Create and refine");
    expect(manifest.interface?.shortDescription).toContain("Create");
    expect(manifest.interface?.longDescription).toContain("Codex");
    expect(manifest.interface?.capabilities).toEqual(["Interactive", "Write"]);
    expect(manifest.interface?.defaultPrompt).toHaveLength(3);
    expect(manifest.interface?.defaultPrompt).toEqual(expect.arrayContaining([
      expect.stringContaining("website"),
      expect.stringContaining("prototype"),
      expect.stringContaining("presentation"),
    ]));
    expect(manifest.interface?.composerIcon).toBe("./assets/icon.svg");
    expect(manifest.interface?.logo).toBe("./assets/icon.svg");
    expect((await stat(join(PLUGIN_ROOT, "assets", "icon.svg"))).isFile()).toBe(true);
  });

  it("ships the closure-adapted Open Design product workflow", async () => {
    const skillRoot = join(PLUGIN_ROOT, "skills", "open-design-mode");
    const [skill, openai] = await Promise.all([
      readFile(join(skillRoot, "SKILL.md"), "utf8"),
      readFile(join(skillRoot, "agents", "openai.yaml"), "utf8"),
    ]);

    expect(skill).toContain("name: open-design-mode");
    expect(skill).toContain("Open Design Cloud is the default mode");
    expect(skill).toContain("Local Codex");
    expect(skill).toContain("Call `collect_brief` exactly once");
    expect(skill).toContain("Do not send `externalPluginContext`");
    expect(skill).toContain("agent: \"amr\"");
    expect(skill).toContain("agent: \"codex\"");
    expect(skill).toMatch(/new\s+`pluginWorkflowId`/u);
    expect(skill).toContain("reuse the same project");
    expect(skill).not.toMatch(/artifact-card-v[0-7]/u);
    expect(skill).not.toContain("git_marketplace");
    expect(skill).not.toContain("list_byok_profiles");

    expect(openai).toContain('display_name: "Create with Open Design"');
    expect(openai).toContain("$open-design-mode");
  });

  it("keeps distribution status as a secondary diagnostic skill", async () => {
    await expect(readFile(
      join(PLUGIN_ROOT, "skills", "open-design-status", "SKILL.md"),
      "utf8",
    )).resolves.toContain("get_open_design_status");
  });
});
