import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveToolsPackRoot(startDir: string): string {
  const maxDepth = 6;
  let current = startDir;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const raw = readFileSync(join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (parsed.name === "@open-design/tools-pack") {
        return current;
      }
    } catch {
      // Keep walking until we find the tools-pack package root.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`tools-pack: unable to resolve package root from ${startDir}`);
}

export const toolsPackRoot = resolveToolsPackRoot(dirname(fileURLToPath(import.meta.url)));
export const resourcesRoot = join(toolsPackRoot, "resources");

export const macResources = {
  entitlements: join(resourcesRoot, "mac", "entitlements.mac.plist"),
  entitlementsInherit: join(resourcesRoot, "mac", "entitlements.mac.inherit.plist"),
  icon: join(resourcesRoot, "mac", "icon.icns"),
  iconPng: join(resourcesRoot, "mac", "icon.png"),
  notarizeHook: join(resourcesRoot, "mac", "notarize.cjs"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const winResources = {
  icon: join(resourcesRoot, "win", "icon.ico"),
  sevenZipDll: join(resourcesRoot, "win", "7zip", "7z.dll"),
  sevenZipExe: join(resourcesRoot, "win", "7zip", "7z.exe"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const BUNDLED_RESOURCE_GROUPS = [
  { id: "skills", title: "Skills", trees: [{ from: "skills", to: "skills" }] },
  // After the skills/design-templates split (specs/current/skills-and-design-templates.md)
  // the rendering catalogue lives under its own root and the daemon
  // resolves it via DESIGN_TEMPLATES_DIR. Bundle it like any other
  // first-class resource so packaged builds carry the full template set.
  {
    id: "design-templates",
    title: "Design templates",
    trees: [{ from: "design-templates", to: "design-templates" }],
  },
  {
    id: "design-systems",
    title: "Design systems",
    trees: [{ from: "design-systems", to: "design-systems" }],
  },
  { id: "craft", title: "Craft knowledge", trees: [{ from: "craft", to: "craft" }] },
  {
    id: "plugins",
    title: "Plugin registry",
    trees: [
      { from: join("plugins", "_official"), to: join("plugins", "_official") },
      { from: join("plugins", "registry"), to: join("plugins", "registry") },
    ],
  },
  {
    id: "frames",
    title: "Artifact frames",
    trees: [{ from: join("assets", "frames"), to: "frames" }],
  },
  {
    id: "community-pets",
    title: "Community pets",
    trees: [{ from: join("assets", "community-pets"), to: "community-pets" }],
  },
  {
    id: "prompt-templates",
    title: "Prompt templates",
    trees: [{ from: "prompt-templates", to: "prompt-templates" }],
  },
  // Baked plugin-preview manifest. The gallery's pre-rendered hover-pan clips
  // live on R2; the daemon needs this checked-in manifest to map each plugin to
  // its clip (it serves clips from R2 when the files aren't on disk, which is the
  // packaged case). Without it the packaged daemon reads an empty manifest and the
  // gallery falls back to live, GPU-expensive iframes instead of the baked clips.
  {
    id: "plugin-previews",
    title: "Plugin preview index",
    trees: [{ from: join("data", "plugin-previews"), to: join("data", "plugin-previews") }],
  },
] as const;

export type BundledResourceGroupId = (typeof BUNDLED_RESOURCE_GROUPS)[number]["id"];

export async function copyBundledResourceGroup({
  id,
  workspaceRoot,
  resourceRoot,
}: {
  id: BundledResourceGroupId;
  workspaceRoot: string;
  resourceRoot: string;
}): Promise<void> {
  const group = BUNDLED_RESOURCE_GROUPS.find((candidate) => candidate.id === id);
  if (group == null) throw new Error(`unknown bundled resource group: ${id}`);
  for (const entry of group.trees) {
    await cp(join(workspaceRoot, entry.from), join(resourceRoot, entry.to), {
      recursive: true,
    });
  }
}

export async function copyBundledResourceTrees({
  workspaceRoot,
  resourceRoot,
}: {
  workspaceRoot: string;
  resourceRoot: string;
}): Promise<void> {
  for (const group of BUNDLED_RESOURCE_GROUPS) {
    await copyBundledResourceGroup({ id: group.id, resourceRoot, workspaceRoot });
  }
}
