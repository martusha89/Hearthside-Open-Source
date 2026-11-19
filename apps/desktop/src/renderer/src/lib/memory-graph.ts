import type { MemoryFile } from "../types";

// The memory web: memory files as nodes grouped by semantic category, with an
// edge wherever one file links to another with [[path]]. Pure data shaping;
// layout and drawing live in the MemoryWeb component.

export type MemoryNodeKind = "core" | "skill" | "external";

export interface MemoryGraphNode {
  id: string;
  label: string;
  /** Actual Markdown H1, when supplied by the file. */
  title?: string;
  group: string;
  kind: MemoryNodeKind;
  size: number;
  /** Number of links in or out. */
  degree: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  /** Category names, largest first; "" is uncategorized root memory. */
  groups: string[];
  /** Unambiguous physical folder indexes only; categories need not be folders. */
  indexes: Record<string, string>;
}

export function groupOf(path: string): string {
  // Runtime paths are POSIX, regardless of the operating system hosting the UI.
  const parts = path.split("/");
  if (/^(?:system\/)?companion-guidance-[a-z0-9-]+\.md$/i.test(path)) return "persona";
  if (parts[0] === "system" && parts.length > 1) {
    return parts.length > 2 ? parts[1]! : parts[1]!.replace(/\.md$/, "");
  }
  if (parts.length > 1) return parts[0] ?? "";
  const basename = path.replace(/\.md$/, "");
  return ["persona", "human", "relationship"].includes(basename) ? basename : "";
}

export function kindOf(file: Pick<MemoryFile, "path" | "system">): MemoryNodeKind {
  if (file.system) return "core";
  return file.path.startsWith("skills/") ? "skill" : "external";
}

function resolveReference(reference: string, paths: Set<string>): string | null {
  const cleaned = reference.trim().replace(/^\.?\/+/, "").replace(/\\/g, "/");
  if (paths.has(cleaned)) return cleaned;
  if (paths.has(`${cleaned}.md`)) return `${cleaned}.md`;
  return null;
}

/** Read only a real, unfenced H1; never turn descriptions into invented titles. */
export function memoryHeading(content: string | null | undefined): string | undefined {
  let fence: string | null = null;
  for (const line of (content ?? "").split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim();
    if (heading) return heading;
  }
  return undefined;
}

/** Fit a truthful name to its screen-space allowance, including an ellipsis. */
export function memoryLabel(node: Pick<MemoryGraphNode, "title" | "label" | "id">, availablePixels: number, fontPixels = 12): string {
  const parts = node.id.split("/");
  const fallback = /^SKILL\.md$/i.test(node.label) && parts.length > 1 ? parts.at(-2)! : node.label.replace(/\.md$/i, "");
  const name = node.title || fallback;
  const capacity = Math.max(1, Math.floor(availablePixels / (fontPixels * 0.62)));
  return name.length <= capacity ? name : `${name.slice(0, Math.max(0, capacity - 1))}…`;
}

export function buildMemoryGraph(allFiles: readonly MemoryFile[], options: { hideRootIndex?: boolean } = {}): MemoryGraph {
  // Keep visible indexes as actual nodes, including their real links. A category label
  // may open an index only when every member belongs to that physical folder.
  // In particular, system/MEMORY.md is not an index for persona or human.
  const indexes: Record<string, string> = Object.create(null);
  // A presentation-only filter: never remove the index from stored memory or
  // its context classification. Nested indexes and other root files stay visible.
  const files = options.hideRootIndex ? allFiles.filter((file) => file.path !== "MEMORY.md") : allFiles;
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.pop() !== "MEMORY.md") continue;
    const folder = parts.join("/");
    const categoryFolder = parts[0] === "system" ? parts.slice(1) : parts;
    if (folder === "system" || categoryFolder.length > 1) continue;
    const group = groupOf(file.path);
    if (files.some((member) => groupOf(member.path) === group && (
      folder ? !member.path.startsWith(`${folder}/`) : member.path.includes("/")
    ))) continue;
    indexes[group] = file.path;
  }
  const paths = new Set(files.map((file) => file.path));
  const seen = new Set<string>();
  const edges: MemoryGraphEdge[] = [];
  const degree = new Map<string, number>();
  for (const file of files) {
    for (const reference of file.references ?? []) {
      const target = resolveReference(reference, paths);
      if (!target || target === file.path) continue;
      const key = [file.path, target].sort().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: file.path, target });
      degree.set(file.path, (degree.get(file.path) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }

  const nodes = files.map((file) => ({
    id: file.path,
    label: file.path.split("/").pop() ?? file.path,
    title: memoryHeading(file.content),
    group: groupOf(file.path),
    kind: kindOf(file),
    size: file.size,
    degree: degree.get(file.path) ?? 0,
  }));

  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([group]) => group);

  return { nodes, edges, groups, indexes };
}

/** Node radius in px: grows with file size, gently (square root), within bounds. */
export function nodeRadius(size: number): number {
  return Math.max(7, Math.min(22, 6 + Math.sqrt(Math.max(0, size)) / 5));
}

export interface GroupCircle {
  x: number;
  y: number;
  r: number;
}

/** Radius a folder needs so its dots (with their spacing) fit inside. */
export function groupRadius(nodeRadii: readonly number[], gap: number): number {
  const area = nodeRadii.reduce((sum, r) => sum + (r + gap) * (r + gap), 0);
  // Generous: dots should have room to breathe and drift.
  return Math.sqrt(area) * 1.45 + 40;
}

/**
 * Place folder circles so none overlap: largest first at the centre, each
 * next one at the closest spot (to the centre) that touches no other.
 */
export function packGroups(groups: ReadonlyArray<{ name: string; radius: number }>, minGap = 80, aspectRatio = 1.15): Map<string, GroupCircle> {
  // Bigger neighbours get a wider gap, so the map reads as separate islands.
  const gapFor = (a: number, b: number) => Math.max(minGap, (a + b) * 0.3);
  const placed: Array<GroupCircle & { name: string }> = [];
  const sorted = [...groups].sort((a, b) => b.radius - a.radius);
  for (const group of sorted) {
    if (placed.length === 0) {
      placed.push({ name: group.name, x: 0, y: 0, r: group.radius });
      continue;
    }
    let best: GroupCircle | null = null;
    let bestDistance = Infinity;
    for (const anchor of placed) {
      const reach = anchor.r + group.radius + gapFor(anchor.r, group.radius);
      for (let step = 0; step < 48; step++) {
        const angle = (step / 48) * Math.PI * 2;
        // Slightly wider than tall suits most screens.
        const x = anchor.x + Math.cos(angle) * reach * 1.15;
        const y = anchor.y + Math.sin(angle) * reach;
        const clear = placed.every(
          (other) => Math.hypot(other.x - x, other.y - y) >= other.r + group.radius + gapFor(other.r, group.radius) - 0.5,
        );
        if (!clear) continue;
        const distance = Math.hypot(x / Math.max(0.5, aspectRatio), y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y, r: group.radius };
        }
      }
    }
    placed.push({ name: group.name, ...(best ?? { x: placed.length * 1000, y: 0, r: group.radius }) });
  }
  return new Map(placed.map(({ name, ...circle }) => [name, circle]));
}
