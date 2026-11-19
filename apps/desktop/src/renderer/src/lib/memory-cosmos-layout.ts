import type { MemoryGraph, MemoryGraphNode } from "./memory-graph";

export type Point3 = { x: number; y: number; z: number };
export type CosmosNode = MemoryGraphNode & { position: Point3 };
export type CosmosRegion = { name: string; members: CosmosNode[]; center: Point3; radius: number };
export type CosmosLayout = { nodes: CosmosNode[]; regions: CosmosRegion[] };
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SPHERE_RADIUS = 2.75;
const length = (p: Point3) => Math.hypot(p.x, p.y, p.z);
const normalized = (p: Point3): Point3 => { const size = length(p) || 1; return { x: p.x / size, y: p.y / size, z: p.z / size }; };
const cross = (a: Point3, b: Point3): Point3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Stable equal-area spherical regions, with members packed into tangent caps.
 * The original concept biased files towards the front. Here rotation deliberately
 * reveals other real regions; no phantom category nodes or membership edges.
 */
export function cosmosLayout(graph: MemoryGraph): CosmosLayout {
  const names = [...new Set([...graph.groups, ...graph.nodes.map(n => n.group)])];
  const members = new Map(names.map(name => [name, graph.nodes.filter(n => n.group === name).sort((a, b) => a.id.localeCompare(b.id))]));
  const populated = names.filter(name => members.get(name)!.length > 0);
  // Category centres keep their whole-sphere spacing. Members occupy a tighter
  // cap inside each region, leaving deliberate breathing room BETWEEN regions.
  const cap = Math.min(.62, 1.12 / Math.sqrt(Math.max(1, populated.length)));
  const nodes: CosmosNode[] = [];
  const regions = populated.map((name, regionIndex) => {
    const z = populated.length === 1 ? 1 : 1 - 2 * (regionIndex + .5) / populated.length;
    const azimuth = Math.PI * .75 + regionIndex * GOLDEN_ANGLE;
    const radial = Math.sqrt(1 - z * z);
    const normal = { x: Math.cos(azimuth) * radial, y: Math.sin(azimuth) * radial, z };
    const tangent = normalized(cross(Math.abs(z) > .95 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 }, normal));
    const bitangent = cross(normal, tangent);
    const list = members.get(name)!;
    const regionNodes = list.map((node, index) => {
      const angle = index * GOLDEN_ANGLE + regionIndex * .31;
      const spread = list.length === 1 ? 0 : cap * .88 * Math.sqrt((index + .5) / list.length);
      const a = Math.sin(spread) * Math.cos(angle), b = Math.sin(spread) * Math.sin(angle), c = Math.cos(spread);
      return { ...node, position: { x: SPHERE_RADIUS * (normal.x * c + tangent.x * a + bitangent.x * b), y: SPHERE_RADIUS * (normal.y * c + tangent.y * a + bitangent.y * b), z: SPHERE_RADIUS * (normal.z * c + tangent.z * a + bitangent.z * b) } };
    });
    nodes.push(...regionNodes);
    const center = regionNodes.reduce((p, n) => ({ x: p.x + n.position.x / list.length, y: p.y + n.position.y / list.length, z: p.z + n.position.z / list.length }), { x: 0, y: 0, z: 0 });
    return { name, members: regionNodes, center, radius: SPHERE_RADIUS * Math.sin(cap) };
  });
  return { nodes, regions };
}

/** Great-circle geometry for a supplied real reference. Unlike a quadratic
 * whose control point is near the chord midpoint, this cannot cut through the
 * sphere. Antipodal endpoints choose a deterministic perpendicular plane.
 */
export function sphericalMemoryArc(start: Point3, end: Point3, segments = 48): Point3[] {
  const a = normalized(start), b = normalized(end);
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const angle = Math.acos(dot);
  const projected = { x: b.x - a.x * dot, y: b.y - a.y * dot, z: b.z - a.z * dot };
  const tangent = length(projected) > 1e-7 ? normalized(projected) : normalized(cross(a, Math.abs(a.y) < .9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }));
  const steps = Math.max(2, Math.min(96, Math.round(segments)));
  return Array.from({ length: steps + 1 }, (_, index) => {
    if (index === 0) return { ...start };
    if (index === steps) return { ...end };
    const t = index / steps;
    const radius = length(start) * (1 - t) + length(end) * t + .035 * Math.sin(Math.PI * t);
    const c = Math.cos(angle * t), s = Math.sin(angle * t);
    return { x: radius * (a.x * c + tangent.x * s), y: radius * (a.y * c + tangent.y * s), z: radius * (a.z * c + tangent.z * s) };
  });
}

/** Oblique selection framing keeps the file on the front hemisphere without
 * looking down its radial axis (which flattens every incident great circle).
 * Choose the tangent bearing least aligned with the actual reference planes.
 * This moves only the camera: file positions and surface paths remain unchanged. */
export function memorySelectionCamera(point: Point3, neighbors: readonly Point3[], aspect: number, fov = 42): Point3 {
  const normal = normalized(point);
  const tangent = normalized(cross(normal, Math.abs(normal.y) < .9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }));
  const bitangent = cross(normal, tangent);
  const planes = neighbors.map(p => cross(normal, normalized(p))).filter(p => length(p) > 1e-6).map(normalized);
  let best = normal, bestScore = -Infinity;
  for (let i = 0; i < 32; i++) {
    const angle = i * Math.PI / 16 + .35;
    const candidate = { x: normal.x * .76 + .65 * (tangent.x * Math.cos(angle) + bitangent.x * Math.sin(angle)), y: normal.y * .76 + .65 * (tangent.y * Math.cos(angle) + bitangent.y * Math.sin(angle)), z: normal.z * .76 + .65 * (tangent.z * Math.cos(angle) + bitangent.z * Math.sin(angle)) };
    const bends = planes.map(p => Math.abs(p.x * candidate.x + p.y * candidate.y + p.z * candidate.z));
    const score = bends.length ? Math.min(...bends) + bends.reduce((sum, value) => sum + value, 0) / bends.length : -i;
    if (score > bestScore) { best = normalized(candidate); bestScore = score; }
  }
  const halfFov = Math.atan(Math.tan(fov * Math.PI / 360) * Math.min(1, Math.max(.15, aspect)));
  const distance = 2.98 * 1.08 / Math.sin(halfFov);
  return { x: best.x * distance, y: best.y * distance, z: best.z * distance };
}

/** Shared by labels and pointer picking: hidden back-face files are not ghost targets.
 * Selected direct neighbours may remain readable through the transparent sphere.
 */
export function surfaceFacing(point: Point3, camera: Point3): number {
  const a = normalized(point), b = normalized(camera);
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function surfaceVisible(point: Point3, camera: Point3, protectedFile = false): boolean {
  return protectedFile || surfaceFacing(point, camera) > .12;
}
/** Screen-space energy limits preserve ordinary overview glows while bounding close zoom. */
export function boundedVisualScale(base: number, viewDepth: number, focalPixels: number, radiusFactor: number, maxRadiusPixels: number): number {
  if (!Number.isFinite(viewDepth) || viewDepth <= 0 || focalPixels <= 0) return 0;
  return Math.min(base, maxRadiusPixels * viewDepth / (focalPixels * radiusFactor));
}
export function glowEnergyGain(count: number, budget: number): number { return Math.min(1, budget / Math.max(1, count)); }
export function sampleCloudMembers(nodes: readonly { id: string }[], limit = 8): Set<string> {
  const count = Math.min(nodes.length, limit);
  return new Set(Array.from({ length: count }, (_, index) => nodes[count === 1 ? 0 : Math.round(index * (nodes.length - 1) / (count - 1))]!.id));
}

export function directMemoryNeighborhood(edges: readonly { source: string; target: string }[], selected: string | null): Set<string> {
  const ids = new Set<string>();
  if (selected === null) return ids;
  ids.add(selected);
  for (const edge of edges) { if (edge.source === selected) ids.add(edge.target); if (edge.target === selected) ids.add(edge.source); }
  return ids;
}
export function isSelectedMemoryLink(edge: { source: string; target: string }, selected: string | null): boolean {
  return selected !== null && (edge.source === selected || edge.target === selected);
}
export function memoryEdgeGradient(source: readonly number[], target: readonly number[], count: number): Float32Array {
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const t = count <= 1 ? 0 : index / (count - 1);
    for (let channel = 0; channel < 3; channel++) colors[index * 3 + channel] = source[channel]! * (1 - t) + target[channel]! * t;
  }
  return colors;
}
export function focusedMemoryVisible(id: string, selected: string | null, neighborhood: ReadonlySet<string>): boolean {
  return selected === null || neighborhood.has(id);
}

export function memoryLabelOpacity(distance: number, facing: number, protectedLabel = false, categoryFocused = false): number {
  if (protectedLabel) return 1;
  if (facing <= .12) return 0;
  const near = Math.max(0, Math.min(1, (7 - distance * (categoryFocused ? .65 : 1)) / 3));
  const front = Math.max(0, Math.min(1, (facing - .12) / .7));
  return near * near * front;
}

export type DensityBranch = { key: string; group: string; members: CosmosNode[]; center: Point3; radius: number; children: DensityBranch[] };
/** Deterministic world-space median hierarchy; no screen-grid jitter while orbiting. */
export function memoryDensityTree(nodes: CosmosNode[], group: string, key = JSON.stringify(group)): DensityBranch {
  nodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const center = nodes.reduce((p, n) => ({ x: p.x + n.position.x / nodes.length, y: p.y + n.position.y / nodes.length, z: p.z + n.position.z / nodes.length }), { x: 0, y: 0, z: 0 });
  const radius = Math.max(0, ...nodes.map(n => Math.hypot(n.position.x - center.x, n.position.y - center.y, n.position.z - center.z)));
  const branch: DensityBranch = { key, group, members: nodes, center, radius, children: [] };
  if (nodes.length <= 3) return branch;
  const axes = ["x", "y", "z"] as const;
  const axis = [...axes].sort((a, b) => (Math.max(...nodes.map(n => n.position[b])) - Math.min(...nodes.map(n => n.position[b]))) - (Math.max(...nodes.map(n => n.position[a])) - Math.min(...nodes.map(n => n.position[a]))))[0]!;
  const sorted = [...nodes].sort((a, b) => a.position[axis] - b.position[axis] || a.id.localeCompare(b.id));
  const mid = Math.floor(sorted.length / 2);
  branch.children = [memoryDensityTree(sorted.slice(0, mid), group, `${key}/0`), memoryDensityTree(sorted.slice(mid), group, `${key}/1`)];
  return branch;
}
export type DensityAggregate = { branch: DensityBranch; members: CosmosNode[] };
/** Counts are disjoint real member sets, excluding protected individual files.
 * A coarse overview cover is refined on approach. Budget pressure raises the
 * collapse scale and selects legitimate ancestors, never truncates a count list.
 */
export function memoryDensityAggregates(roots: DensityBranch[], visible: ReadonlySet<string>, protectedFiles: ReadonlySet<string>, projectedRadius: (branch: DensityBranch) => number, previous: ReadonlySet<string> = new Set(), options: { pixels?: number; maximum?: number; forced?: ReadonlySet<string> } = {}): DensityAggregate[] {
  // Sparse categories always retain their actual glowing, hoverable file dots.
  // Only genuinely dense roots participate, including during budget coarsening.
  const eligibleRoots = roots.filter(root => root.members.length >= 24);
  const counts = new Map<DensityBranch, number>();
  const countVisible = (branch: DensityBranch): number => {
    const count = branch.children.length ? branch.children.reduce((sum, child) => sum + countVisible(child), 0) : branch.members.reduce((sum, node) => sum + Number(visible.has(node.id) && !protectedFiles.has(node.id)), 0);
    counts.set(branch, count); return count;
  };
  eligibleRoots.forEach(countVisible);
  const radii = new Map<DensityBranch, number>();
  let result: DensityAggregate[] = [];
  let pixels = options.pixels ?? 75;
  const maximum = Math.max(options.maximum ?? 8, eligibleRoots.filter(root => counts.get(root)! >= 4).length);
  for (let pass = 0; pass < 16; pass++) {
    result = [];
    const visit = (branch: DensityBranch) => {
      if ((counts.get(branch) ?? 0) < 4) return;
      let radius = radii.get(branch);
      if (radius === undefined) { radius = projectedRadius(branch); radii.set(branch, radius); }
      if (options.forced?.has(branch.key) || radius <= pixels * (previous.has(branch.key) ? 1.35 : 1)) { result.push({ branch, members: branch.members.filter(n => visible.has(n.id) && !protectedFiles.has(n.id)) }); return; }
      branch.children.forEach(visit);
    };
    eligibleRoots.forEach(visit);
    if (result.length <= maximum) break;
    pixels *= 1.4;
  }
  return result;
}
export type LabelBox = { x: number; y: number; width: number; height: number };
export function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
/** Preserve existing hit targets during hover/focus-only redraws. New labels
 * may use free space, but must never evict the button currently under a pointer. */
export function retainLabelBoxes<K>(previous: ReadonlyMap<K, LabelBox>, blockers: readonly LabelBox[], width: number, height: number): Map<K, LabelBox> {
  const kept = new Map<K, LabelBox>();
  const occupied = [...blockers];
  for (const [key, box] of previous) {
    if (box.x < 12 || box.y < 12 || box.x + box.width > width - 12 || box.y + box.height > height - 12 || occupied.some(other => overlaps(box, other))) continue;
    kept.set(key, box); occupied.push(box);
  }
  return kept;
}
export function placeLabel(box: LabelBox, occupied: LabelBox[], width: number, height: number): LabelBox | null {
  for (const shift of [0, -36, 36, -72, 72]) {
    const candidate = { ...box, y: box.y + shift };
    if (candidate.x < 12 || candidate.x + candidate.width > width - 12 || candidate.y < 12 || candidate.y + candidate.height > height - 12) continue;
    if (!occupied.some(other => overlaps(candidate, other))) return candidate;
  }
  return null;
}
/** Count badges stay beside their actual luminous anchor, never in side gutters. */
export function placeClusterBadge(anchor: { x: number; y: number }, width: number, height: number, occupied: LabelBox[], viewportWidth: number, viewportHeight: number): LabelBox | null {
  for (const [dx, dy] of [[12, -height - 6], [-width - 12, -height - 6], [12, 8], [-width - 12, 8], [-width / 2, -height - 18], [-width / 2, 18]]) {
    const box = { x: anchor.x + dx!, y: anchor.y + dy!, width, height };
    if (box.x < 12 || box.x + width > viewportWidth - 12 || box.y < 12 || box.y + height > viewportHeight - 12 || occupied.some(other => overlaps(box, other))) continue;
    return box;
  }
  return null;
}
/** Region headings may use the quiet side gutters; file chips never move for them. */
export function placeRegionHeading(box: LabelBox, occupied: LabelBox[], width: number, height: number): LabelBox | null {
  const direct = placeLabel(box, occupied, width, height);
  if (direct) return direct;
  const candidates: LabelBox[] = [];
  const xs = [12, width - box.width - 12, Math.max(12, box.x - box.width * .6), Math.min(width - box.width - 12, box.x + box.width * .6)];
  for (const x of xs) for (let y = 12; y + box.height <= height - 12; y += 18) {
    const candidate = { ...box, x, y };
    if (x < 12 || x + box.width > width - 12 || occupied.some(other => overlaps(candidate, other))) continue;
    candidates.push(candidate);
  }
  candidates.sort((a, b) => Math.hypot((a.x - box.x) * .7, a.y - box.y) - Math.hypot((b.x - box.x) * .7, b.y - box.y));
  return candidates[0] ?? null;
}
export function focusDistance(radius: number, aspect: number, fov = 42): number {
  return Math.max(3.4, radius * 1.55 / Math.tan(fov * Math.PI / 360) / Math.min(1, Math.max(.15, aspect)));
}
export function isSkill(node: Pick<MemoryGraphNode, "id" | "kind">): boolean {
  return node.kind === "skill" || /^(?:system\/)?skills\//.test(node.id);
}
export function contextLabel(node: Pick<MemoryGraphNode, "id" | "kind">): string {
  return `${node.kind === "core" ? "Always in context" : "Retrieved when needed"}${isSkill(node) ? " · Skill" : ""}`;
}
export function isLightSurface(rgb: readonly number[]): boolean {
  const linear = rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722 > .35;
}
export function regionHue(accentHue: number, index: number): number {
  return (accentHue + index * .38196601125 + 1) % 1;
}
