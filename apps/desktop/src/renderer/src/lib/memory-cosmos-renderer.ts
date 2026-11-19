import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CosmosSoftwareRenderer } from "./memory-cosmos-software";
import { memorySelectionCamera, directMemoryNeighborhood, isSelectedMemoryLink, memoryEdgeGradient, focusedMemoryVisible, boundedVisualScale, glowEnergyGain, sampleCloudMembers, contextLabel, cosmosLayout, focusDistance, isLightSurface, isSkill, memoryLabelOpacity, memoryDensityTree, memoryDensityAggregates, type DensityBranch, type DensityAggregate, retainLabelBoxes, placeLabel, placeClusterBadge, placeRegionHeading, regionHue, sphericalMemoryArc, surfaceFacing, surfaceVisible, type CosmosNode, type CosmosRegion, type LabelBox } from "./memory-cosmos-layout";
import { memoryLabel, type MemoryGraph } from "./memory-graph";

// Radial glow / spherical composition adapted from CosmoGraph; see memory-cosmos.LICENSE.
// Data layout, lifecycle, theme integration and navigation are Hearthside code.
type NodeVisual = { node: CosmosNode; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; glow: THREE.Sprite; cloud?: THREE.Sprite; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> };
type Label = { button: HTMLButtonElement; point: THREE.Vector3; node?: CosmosNode; region?: CosmosRegion };
type State = { selected: string | null; highlighted: ReadonlySet<string>; category: string | null; hoveredCategory: string | null };

/** Resize changes the projection, never the person's orbit/zoom or focus target. */
export function resizeCosmosCamera(camera: THREE.PerspectiveCamera, width: number, height: number): void {
  camera.aspect = Math.max(1, width) / Math.max(1, height);
  camera.updateProjectionMatrix();
}

export class MemoryCosmosRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, .1, 150);
  readonly layout;
  readonly controls: OrbitControls;
  private renderer: THREE.WebGLRenderer | CosmosSoftwareRenderer;
  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;
  private host: HTMLElement;
  private labelsHost: HTMLElement;
  private visuals: NodeVisual[] = [];
  private edges: { source: string; target: string; line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> }[] = [];
  private labels: Label[] = [];
  private labelSizes = new Map<HTMLButtonElement, { width: number; height: number }>();
  private projectedNodes = new Map<string, THREE.Vector3>();
  private previousLabelBoxes = new Map<HTMLButtonElement, LabelBox>();
  private labelCameraKey = "";
  private hoveredFile: string | null = null;
  private hoverClearTimer: ReturnType<typeof setTimeout> | undefined;
  private focusedFile: string | null = null;
  private densityRoots: DensityBranch[] = [];
  private collapsed = new Set<string>();
  private forcedDensity = new Set<string>();
  private densityParents = new Map<string, DensityBranch>();
  private aggregated = new Set<string>();
  private aggregates: DensityAggregate[] = [];
  private aggregateButtons = new Map<string, HTMLButtonElement>();
  private aggregateLights = new Map<string, { glow: THREE.Sprite; dot: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> }>();
  private browseCategory: (group: string) => void;
  private atmosphere = new THREE.Group();
  private texture: THREE.CanvasTexture;
  private width = 1;
  private height = 1;
  private frame = 0;
  private disposed = false;
  private ready?: () => void;
  private failed?: () => void;
  private visible = true;
  private still = window.matchMedia("(prefers-reduced-motion: reduce)");
  private state: State = { selected: null, highlighted: new Set(), category: null, hoveredCategory: null };
  private colors: THREE.Color[] = [];
  private accent = new THREE.Color();
  private ink = new THREE.Color();
  private light = false;
  private transition?: { start: number; from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; target: THREE.Vector3 };
  private cleanups: (() => void)[] = [];

  constructor(host: HTMLElement, labelsHost: HTMLElement, graph: MemoryGraph, callbacks: { select: (id: string) => void; category: (name: string) => void; browseCategory: (name: string) => void; hoverCategory: (name: string | null) => void; ready?: () => void; backend: (name: "webgl" | "software" | "unavailable") => void }) {
    this.host = host;
    this.labelsHost = labelsHost;
    this.ready = callbacks.ready;
    this.failed = () => callbacks.backend("unavailable");
    try {
    this.layout = cosmosLayout(graph);
    this.browseCategory = callbacks.browseCategory;
    this.densityRoots = this.layout.regions.map(region => memoryDensityTree(region.members, region.name));
    const rememberParents = (parent: DensityBranch) => { for (const child of parent.children) { this.densityParents.set(child.key, parent); rememberParents(child); } };
    this.densityRoots.forEach(rememberParents);
    let webgl: THREE.WebGLRenderer | undefined;
    try {
      webgl = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      this.renderer = webgl;
      this.composer = new EffectComposer(webgl);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), .65, .6, .25);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      callbacks.backend("webgl");
    } catch {
      this.composer?.dispose();
      this.composer = undefined;
      webgl?.dispose();
      this.renderer = new CosmosSoftwareRenderer();
      callbacks.backend(this.renderer.domElement.getContext("2d") ? "software" : "unavailable");
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.prepend(this.renderer.domElement);
    this.camera.position.set(0, 0, 11);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.enablePan = false;
    this.controls.autoRotate = false;
    this.controls.minDistance = .85;
    this.controls.maxDistance = 60;
    this.controls.rotateSpeed = .45;
    this.controls.addEventListener("change", this.request);
    const cancelTransition = () => { this.transition = undefined; this.hoveredFile = null; this.forcedDensity.clear(); };
    this.controls.addEventListener("start", cancelTransition);
    this.cleanups.push(() => this.controls.removeEventListener("start", cancelTransition));
    this.texture = this.glowTexture();
    this.buildAtmosphere();
    const byId = new Map(this.layout.nodes.map(n => [n.id, n]));
    const cloudMembers = new Set(this.layout.regions.flatMap(region => [...sampleCloudMembers(region.members)]));
    const regionsByName = new Map(this.layout.regions.map(region => [region.name, region]));
    this.layout.nodes.forEach(node => {
      const geometry = isSkill(node) ? new THREE.OctahedronGeometry(.047) : new THREE.SphereGeometry(node.kind === "core" ? .052 : .039, 10, 8);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true }));
      mesh.position.copy(node.position);
      this.scene.add(mesh);
      const glow = this.sprite(node.position, node.kind === "core" ? .36 : .25, .8);
      // Clouds are made from member positions, never phantom category orbs.
      const cloud = cloudMembers.has(node.id) ? this.sprite(node.position, regionsByName.get(node.group)!.radius * 1.7, .13) : undefined;
      if (cloud) cloud.userData.cloud = true;
      const ring = new THREE.Mesh(new THREE.RingGeometry(.085, .096, 32), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.copy(node.position);
      this.scene.add(ring);
      this.visuals.push({ node, mesh, glow, cloud, ring });
      const button = this.label(memoryLabel(node, 210, 13), "memory-cosmos-file");
      button.dataset.node = node.id;
      button.title = `${node.title || node.label}\n${node.id}\n${contextLabel(node)}`;
      button.setAttribute("aria-label", `${node.id}: ${contextLabel(node)}`);
      button.onclick = () => callbacks.select(node.id);
      button.onpointerenter = () => this.setHoveredFile(node.id);
      button.onpointerleave = () => this.setHoveredFile(null);
      button.onfocus = () => { this.focusedFile = node.id; this.request(); };
      button.onblur = () => { this.focusedFile = null; this.request(); };
      this.labels.push({ button, point: new THREE.Vector3().copy(node.position), node });
    });
    this.layout.regions.forEach(region => {
      const button = this.label(region.name || "Other memory", "memory-cosmos-region");
      const count = document.createElement("small");
      count.textContent = `${region.members.length} ${region.members.length === 1 ? "memory" : "memories"} · explore region`;
      button.append(count);
      button.dataset.category = region.name;
      button.onclick = () => callbacks.category(region.name);
      button.onpointerenter = button.onfocus = () => callbacks.hoverCategory(region.name);
      button.onpointerleave = button.onblur = () => callbacks.hoverCategory(null);
      this.labels.push({ button, point: new THREE.Vector3().copy(region.center), region });
    });
    for (const edge of graph.edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const points = sphericalMemoryArc(a.position, b.position).map(point => new THREE.Vector3().copy(point));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
      this.scene.add(line);
      this.edges.push({ ...edge, line });
    }
    let firstSize = true;
    const fontsChanged = () => { this.labelSizes.clear(); this.previousLabelBoxes.clear(); this.request(); };
    document.fonts?.addEventListener("loadingdone", fontsChanged);
    this.cleanups.push(() => document.fonts?.removeEventListener("loadingdone", fontsChanged));
    const resize = new ResizeObserver(() => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      this.width = Math.max(1, host.clientWidth); this.height = Math.max(1, host.clientHeight);
      this.labelSizes.clear();
      resizeCosmosCamera(this.camera, this.width, this.height);
      this.renderer.setSize(this.width, this.height); this.composer?.setSize(this.width, this.height);
      if (firstSize) { firstSize = false; this.focus(this.state.category, false); }
      else this.request();
    });
    resize.observe(host);
    this.cleanups.push(() => resize.disconnect());
    const intersection = new IntersectionObserver(entries => {
      this.visible = entries[0]?.isIntersecting ?? true;
      if (!this.visible) this.pause(); else this.request();
    });
    intersection.observe(host);
    this.cleanups.push(() => intersection.disconnect());
    const visibility = () => { if (document.hidden) this.pause(); else this.request(); };
    document.addEventListener("visibilitychange", visibility);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", visibility));
    const motion = () => { if (this.still.matches && this.transition) this.finishTransition(); this.request(); };
    this.still.addEventListener("change", motion);
    this.cleanups.push(() => this.still.removeEventListener("change", motion));
    // Observe only ancestor attributes; labels mutate on each frame and must not trigger this.
    const theme = new MutationObserver(() => this.updateTheme());
    for (let ancestor: HTMLElement | null = host; ancestor; ancestor = ancestor.parentElement) theme.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-themed", "data-mode"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => this.updateTheme();
    scheme.addEventListener("change", updateTheme);
    this.cleanups.push(() => { theme.disconnect(); scheme.removeEventListener("change", updateTheme); });
    let down: { x: number; y: number } | undefined;
    const pointerDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const pointerUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      down = undefined;
      const nearest = this.pickNode(e.clientX, e.clientY);
      if (nearest) callbacks.select(nearest.id);
      else {
        const rect = host.getBoundingClientRect();
        const hit = this.aggregates.find(a => { if (!this.aggregateLights.get(a.branch.key)?.dot.visible) return false; const p = this.project(new THREE.Vector3().copy(a.branch.center)); return Math.hypot(p.x - e.clientX + rect.left, p.y - e.clientY + rect.top) < 16; });
        if (hit) this.approachAggregate(hit.branch);
      }
    };
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const id = this.pickNode(e.clientX, e.clientY)?.id ?? null;
      this.setHoveredFile(id);
    };
    const pointerLeave = () => this.setHoveredFile(null);
    this.renderer.domElement.addEventListener("pointerdown", pointerDown);
    this.renderer.domElement.addEventListener("pointerup", pointerUp);
    this.renderer.domElement.addEventListener("pointermove", pointerMove);
    this.renderer.domElement.addEventListener("pointerleave", pointerLeave);
    const contextLost = (event: Event) => {
      event.preventDefault();
      // Replace a lost WebGL context with the same software-projected scene, not a blank graph.
      this.controls.disconnect();
      const old = this.renderer;
      this.renderer = new CosmosSoftwareRenderer();
      this.renderer.light = this.light;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(this.width, this.height);
      this.renderer.domElement.setAttribute("aria-hidden", "true");
      old.domElement.removeEventListener("pointerdown", pointerDown);
      old.domElement.removeEventListener("pointerup", pointerUp);
      old.domElement.removeEventListener("pointermove", pointerMove);
      old.domElement.removeEventListener("pointerleave", pointerLeave);
      old.domElement.removeEventListener("webglcontextlost", contextLost);
      old.domElement.replaceWith(this.renderer.domElement);
      this.renderer.domElement.addEventListener("pointerdown", pointerDown);
      this.renderer.domElement.addEventListener("pointerup", pointerUp);
    this.renderer.domElement.addEventListener("pointermove", pointerMove);
    this.renderer.domElement.addEventListener("pointerleave", pointerLeave);
      this.controls.connect(this.renderer.domElement);
      this.composer?.passes.forEach(pass => pass.dispose());
      this.composer?.dispose(); this.composer = undefined;
      old.dispose(); callbacks.backend(this.renderer.domElement.getContext("2d") ? "software" : "unavailable"); this.request();
    };
    this.renderer.domElement.addEventListener("webglcontextlost", contextLost);
    this.cleanups.push(() => {
      this.renderer.domElement.removeEventListener("pointerdown", pointerDown);
      this.renderer.domElement.removeEventListener("pointerup", pointerUp);
      this.renderer.domElement.removeEventListener("pointermove", pointerMove);
      this.renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      this.renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    });
    this.updateTheme();
    } catch (error) { this.dispose(); throw error; }
  }

  private label(text: string, className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = text; button.className = `memory-cosmos-label ${className}`;
    button.style.visibility = "hidden";
    this.labelsHost.append(button);
    return button;
  }
  private glowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) return new THREE.CanvasTexture(canvas);
    const gradient = context.createRadialGradient(48, 48, 0, 48, 48, 48);
    gradient.addColorStop(0, "rgba(255,255,255,1)"); gradient.addColorStop(.12, "rgba(255,255,255,.96)");
    gradient.addColorStop(.36, "rgba(255,255,255,.34)"); gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient; context.fillRect(0, 0, 96, 96);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false; texture.minFilter = texture.magFilter = THREE.LinearFilter;
    return texture;
  }
  private sprite(position: { x: number; y: number; z: number }, size: number, opacity: number): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, opacity, depthWrite: false }));
    sprite.position.copy(position); sprite.scale.setScalar(size); sprite.userData.baseSize = size; this.scene.add(sprite); return sprite;
  }
  private buildAtmosphere(): void {
    this.scene.add(this.atmosphere);
    // A real spherical Fresnel shell (software projects the same sphere) supplies
    // a broad volumetric body, not camera-facing concentric map rings.
    const shell = new THREE.Mesh(new THREE.SphereGeometry(2.96, 48, 32), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { bodyColor: { value: new THREE.Color() }, rimColor: { value: new THREE.Color() }, strength: { value: 1 } },
      vertexShader: "varying vec3 n; varying vec3 v; void main(){ vec4 p=modelViewMatrix*vec4(position,1.); n=normalize(normalMatrix*normal); v=normalize(-p.xyz); gl_Position=projectionMatrix*p; }",
      fragmentShader: "uniform vec3 bodyColor; uniform vec3 rimColor; uniform float strength; varying vec3 n; varying vec3 v; void main(){ float rim=pow(1.-abs(dot(normalize(n),normalize(v))),3.); float light=.55+.45*max(0.,dot(normalize(n),normalize(vec3(-.5,.65,1.)))); gl_FragColor=vec4(mix(bodyColor,rimColor,rim),(.025*light+rim*.28)*strength); }",
    }));
    shell.userData.shell = true; shell.userData.decoration = true;
    this.atmosphere.add(shell);
    let seed = 45;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // Bounded decorative geometry. These ribbons never enter graph.edges or selection.
    for (let j = 0; j < 92; j++) {
      const points: THREE.Vector3[] = [];
      const rotation = j < 70 ? new THREE.Euler(random() * Math.PI, random() * Math.PI * 2, j * .12) : new THREE.Euler(.2 + (j - 70) * .012, .35 + (j - 70) * .006, .3);
      for (let i = 0; i <= 144; i++) {
        const t = i / 144 * Math.PI * 2, radius = 2.96 + .016 * Math.sin(t * 11 + j * .2);
        points.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, .06 * Math.sin(t * 7 + j * .2)).applyEuler(rotation));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ transparent: true, opacity: .065, depthWrite: false }));
      line.userData.decoration = true; this.depthMaterial(line.material); this.atmosphere.add(line);
    }
    const positions: number[] = [];
    for (let i = 0; i < 4700; i++) {
      const y = random() * 2 - 1, angle = random() * Math.PI * 2, radius = 2.95 + (random() - .5) * .1;
      positions.push(Math.sqrt(1 - y * y) * Math.cos(angle) * radius, y * radius, Math.sqrt(1 - y * y) * Math.sin(angle) * radius);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const dust = new THREE.PointsMaterial({ size: .012, transparent: true, opacity: .5, depthWrite: false });
    this.depthMaterial(dust);
    this.atmosphere.add(new THREE.Points(geometry, dust));
  }
  private depthMaterial(material: THREE.LineBasicMaterial | THREE.PointsMaterial): void {
    material.onBeforeCompile = shader => {
      shader.vertexShader = "varying float cosmicFacing;\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\ncosmicFacing=dot(normalize(position),normalize(cameraPosition));");
      shader.fragmentShader = "varying float cosmicFacing;\n" + shader.fragmentShader.replace("#include <opaque_fragment>", "diffuseColor.a *= .2+.8*smoothstep(-.2,.65,cosmicFacing);\n#include <opaque_fragment>");
    };
    material.customProgramCacheKey = () => "cosmos-depth-v1";
  }
  private token(name: string): THREE.Color {
    // Resolve color-mix()/oklch and inherited per-companion overrides through the browser.
    const probe = document.createElement("span"); probe.style.color = `var(${name})`; probe.hidden = true; this.host.append(probe);
    const color = getComputedStyle(probe).color; probe.remove();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return new THREE.Color().setStyle(color);
    context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(data[0]! / 255, data[1]! / 255, data[2]! / 255, THREE.SRGBColorSpace);
  }
  private updateTheme(): void {
    if (this.disposed) return;
    const surface = this.token("--color-surface").clone().convertLinearToSRGB();
    this.light = isLightSurface([surface.r, surface.g, surface.b]);
    this.accent = this.token("--color-accent"); this.ink = this.token("--color-ink-700");
    const hsl = this.accent.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
    this.colors = this.layout.regions.map((_, i) => new THREE.Color().setHSL(regionHue(hsl.h, i), this.light ? .48 : .62, this.light ? .37 : .73, THREE.SRGBColorSpace));
    if (this.renderer instanceof CosmosSoftwareRenderer) this.renderer.light = this.light;
    if (this.bloom) this.bloom.strength = this.light ? .08 : .65;
    const bodyColor = new THREE.Color().setHSL(hsl.h, .58, this.light ? .4 : .64, THREE.SRGBColorSpace);
    const rimColor = new THREE.Color().setHSL((hsl.h + .12) % 1, .62, this.light ? .35 : .76, THREE.SRGBColorSpace);
    this.atmosphere.children.forEach((object, index) => {
      if (object.userData.shell) {
        object.userData.bodyColor = bodyColor; object.userData.rimColor = rimColor;
        const material = (object as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>).material;
        material.uniforms.bodyColor!.value = bodyColor; material.uniforms.rimColor!.value = rimColor;
        material.uniforms.strength!.value = this.light ? .45 : 1;
        material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
        material.needsUpdate = true;
        return;
      }
      const material = (object as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>).material;
      // Cohesive accent-adjacent atmosphere, not a rainbow of category wires.
      material.color.copy(index % 3 === 0 ? bodyColor : rimColor);
      material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
      material.opacity = object instanceof THREE.Points ? (this.light ? .42 : .7) : (this.light ? .13 : .14);
      material.userData.baseOpacity = material.opacity;
      material.needsUpdate = true;
    });
    this.update(this.state);
  }
  update(state: State): void {
    this.labelSizes.clear();
    if (state.selected !== this.state.selected || state.category !== this.state.category) { this.previousLabelBoxes.clear(); this.hoveredFile = null; this.focusedFile = null; }
    this.state = state;
    const neighbours = this.neighbours();
    const category = state.selected === null ? state.hoveredCategory ?? state.category : null;
    for (const visual of this.visuals) {
      const member = category === null || visual.node.group === category;
      const linked = state.selected === null || neighbours.has(visual.node.id);
      const active = member && linked;
      const color = this.colors[this.layout.regions.findIndex(r => r.name === visual.node.group)] ?? this.accent;
      visual.mesh.material.color.copy(color); visual.mesh.material.opacity = active ? 1 : .22;
      visual.mesh.userData.baseScale = visual.node.id === state.selected ? 1.65 : category !== null && member ? 1.2 : 1;
      visual.mesh.scale.setScalar(visual.mesh.userData.baseScale);
      visual.glow.userData.selected = visual.node.id === state.selected;
      visual.glow.material.color.copy(color); visual.glow.material.opacity = active ? (this.light ? .35 : .85) : .08;
      visual.glow.material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
      visual.glow.material.needsUpdate = true;
      if (visual.cloud) {
        visual.cloud.material.color.copy(color);
        visual.cloud.material.opacity = active ? (category !== null ? .23 : .13) : .025;
        visual.cloud.material.blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
        visual.cloud.material.needsUpdate = true;
      }
      visual.mesh.userData.baseOpacity = visual.mesh.material.opacity;
      visual.glow.userData.baseOpacity = visual.glow.material.opacity;
      if (visual.cloud) visual.cloud.userData.baseOpacity = visual.cloud.material.opacity;
      visual.ring.visible = focusedMemoryVisible(visual.node.id, state.selected, neighbours) && (state.highlighted.has(visual.node.id) || state.selected === visual.node.id);
      visual.ring.material.color.copy(this.accent); visual.ring.material.opacity = 1;
    }
    const groupsById = new Map(this.layout.nodes.map(node => [node.id, node.group]));
    const colorsByGroup = new Map(this.layout.regions.map((region, index) => [region.name, this.colors[index] ?? this.accent]));
    for (const edge of this.edges) {
      const active = isSelectedMemoryLink(edge, state.selected);
      edge.line.userData.active = active;
      if (edge.line.material.vertexColors !== active) { edge.line.material.vertexColors = active; edge.line.material.needsUpdate = true; }
      if (active) {
        const source = colorsByGroup.get(groupsById.get(edge.source)!) ?? this.accent;
        const target = colorsByGroup.get(groupsById.get(edge.target)!) ?? this.accent;
        const colorData = memoryEdgeGradient(source.toArray(), target.toArray(), edge.line.geometry.getAttribute("position").count);
        const attribute = edge.line.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
        if (attribute) { attribute.copyArray(colorData); attribute.needsUpdate = true; }
        else edge.line.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colorData, 3));
        edge.line.material.color.set(0xffffff);
      } else edge.line.material.color.copy(this.ink);
      edge.line.material.opacity = state.selected ? active ? .95 : .035 : this.light ? .24 : .23;
      edge.line.userData.baseOpacity = edge.line.material.opacity;
    }
    for (const label of this.labels) {
      const group = label.node?.group ?? label.region!.name;
      const color = this.colors[this.layout.regions.findIndex(r => r.name === group)] ?? this.accent;
      label.button.style.setProperty("--region", `#${color.getHexString()}`);
      label.button.classList.toggle("is-member", category !== null && category === group);
      label.button.classList.toggle("is-selected", label.node?.id === state.selected);
      label.button.classList.toggle("is-neighbor", !!label.node && neighbours.has(label.node.id));
      label.button.classList.toggle("is-changed", !!label.node && state.highlighted.has(label.node.id));
      label.button.classList.toggle("is-core", label.node?.kind === "core");
      label.button.classList.toggle("is-skill", !!label.node && isSkill(label.node));
      if (label.node) label.button.setAttribute("aria-pressed", String(label.node.id === state.selected));
    }
    this.request();
  }
  private neighbours(): Set<string> { return directMemoryNeighborhood(this.edges, this.state.selected); }
  focus(category: string | null, animate = true): void {
    this.forcedDensity.clear();
    const region = this.layout.regions.find(r => r.name === category);
    const target = region ? new THREE.Vector3().copy(region.center) : new THREE.Vector3();
    const distance = region ? focusDistance(region.radius + .25, this.camera.aspect) : 8.7 / Math.min(1, Math.max(.25, this.camera.aspect));
    // A rear region is approached from its own outward normal, never through
    // the front of the globe. OrbitControls keeps this actual 3D target.
    const direction = region ? target.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const to = target.clone().addScaledVector(direction, distance);
    if (animate && !this.still.matches) this.transition = { start: performance.now(), from: this.camera.position.clone(), to, fromTarget: this.controls.target.clone(), target };
    else { this.transition = undefined; this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); }
    this.request();
  }
  /** Explicit file selection can reveal a rear file; theme/hover updates cannot. */
  revealSelection(id: string): void {
    const node = this.layout.nodes.find(member => member.id === id);
    if (!node) return;
    const neighborhood = directMemoryNeighborhood(this.edges, id);
    const neighbors = this.layout.nodes.filter(member => member.id !== id && neighborhood.has(member.id)).map(member => member.position);
    const target = new THREE.Vector3();
    const to = new THREE.Vector3().copy(memorySelectionCamera(node.position, neighbors, this.camera.aspect, this.camera.fov));
    if (!this.still.matches) this.transition = { start: performance.now(), from: this.camera.position.clone(), to, fromTarget: this.controls.target.clone(), target };
    else { this.transition = undefined; this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); }
    this.request();
  }
  zoom(factor: number): void {
    this.forcedDensity.clear();
    this.transition = undefined;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); this.request();
  }
  orbit(dx: number, dy: number): void {
    this.forcedDensity.clear();
    this.transition = undefined;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += dx; spherical.phi = THREE.MathUtils.clamp(spherical.phi + dy, .1, Math.PI - .1);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); this.controls.update(); this.request();
  }
  private setHoveredFile(id: string | null): void {
    if (id !== null) {
      clearTimeout(this.hoverClearTimer); this.hoverClearTimer = undefined;
      if (this.hoveredFile !== id) { this.hoveredFile = id; this.request(); }
    } else if (this.hoveredFile !== null && this.hoverClearTimer === undefined) {
      // Bridge the small gap from a glowing point to its emergent file chip.
      this.hoverClearTimer = setTimeout(() => { this.hoverClearTimer = undefined; this.hoveredFile = null; this.request(); }, 160);
    }
  }
  private protectedFiles(): Set<string> {
    const ids = this.neighbours();
    if (this.state.selected !== null) return ids;
    this.state.highlighted.forEach(id => ids.add(id));
    if (this.hoveredFile) ids.add(this.hoveredFile);
    if (this.focusedFile) ids.add(this.focusedFile);
    return ids;
  }
  private pickNode(clientX: number, clientY: number): CosmosNode | null {
    const rect = this.host.getBoundingClientRect(), protectedFiles = this.protectedFiles();
    let nearest: CosmosNode | null = null, distance = 15;
    for (const node of this.layout.nodes) {
      if (!focusedMemoryVisible(node.id, this.state.selected, protectedFiles) || this.aggregated.has(node.id) || !surfaceVisible(node.position, this.camera.position, protectedFiles.has(node.id))) continue;
      const point = this.project(new THREE.Vector3().copy(node.position));
      if (point.z < -1 || point.z > 1) continue;
      const d = Math.hypot(point.x - clientX + rect.left, point.y - clientY + rect.top);
      if (d < distance) { distance = d; nearest = node; }
    }
    return nearest;
  }
  private updateDensity(): void {
    this.projectedNodes.clear();
    const visible = new Set(this.layout.nodes.filter(node => {
      const p = this.project(new THREE.Vector3().copy(node.position));
      this.projectedNodes.set(node.id, p);
      if (this.state.selected !== null || (this.state.category !== null && node.group !== this.state.category)) return false;
      return surfaceVisible(node.position, this.camera.position) && p.z >= -1 && p.z <= 1 && p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= this.height;
    }).map(node => node.id));
    const focal = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const maximum = this.camera.position.distanceTo(this.controls.target) > 6 ? 6 : 16;
    let pixels = 75;
    for (let pass = 0; pass < 8; pass++) {
      this.aggregates = memoryDensityAggregates(this.densityRoots, visible, this.protectedFiles(), branch => branch.radius * focal / Math.max(.1, this.camera.position.distanceTo(new THREE.Vector3().copy(branch.center))), this.collapsed, { pixels, maximum, forced: this.forcedDensity });
      const points = this.aggregates.map(a => this.project(new THREE.Vector3().copy(a.branch.center)));
      const collision = points.some((a, i) => points.some((b, j) => j > i && Math.hypot(a.x - b.x, a.y - b.y) < 52));
      if (!collision) break;
      pixels *= 1.45; // Coarsen to real ancestors instead of displacing counts into gutters.
    }
    this.collapsed = new Set(this.aggregates.map(a => a.branch.key));
    this.aggregated = new Set(this.aggregates.flatMap(a => a.members.map(n => n.id)));
    for (const [key, button] of this.aggregateButtons) if (!this.collapsed.has(key)) {
      button.remove(); this.aggregateButtons.delete(key); this.labelSizes.delete(button);
      const light = this.aggregateLights.get(key);
      if (light) { this.scene.remove(light.glow, light.dot); light.glow.material.dispose(); light.dot.material.dispose(); light.dot.geometry.dispose(); this.aggregateLights.delete(key); }
    }
    for (const aggregate of this.aggregates) {
      const { branch, members } = aggregate;
      let button = this.aggregateButtons.get(branch.key);
      if (!button) {
        button = this.label("", "memory-cosmos-cluster");
        button.dataset.cluster = branch.key;
        button.onclick = () => { this.host.focus({ preventScroll: true }); this.approachAggregate(branch); };
        button.onkeydown = event => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); this.browseCategory(branch.group); } };
        this.aggregateButtons.set(branch.key, button);
      }
      const countText = String(members.length);
      if (button.textContent !== countText) { button.textContent = countText; this.labelSizes.delete(button); }
      button.dataset.count = String(members.length);
      button.setAttribute("aria-label", `Explore ${members.length} files in ${branch.group || "Other memory"}. Navigation cluster, not a memory file. Shift Enter opens the searchable category list.`);
      button.title = "Approach to reveal individual files. At maximum detail, open the category's searchable file list.";
      const index = this.layout.regions.findIndex(r => r.name === branch.group);
      const color = this.colors[index] ?? this.accent;
      button.style.setProperty("--region", `#${color.getHexString()}`);
      let light = this.aggregateLights.get(branch.key);
      if (!light) {
        const glow = this.sprite(branch.center, .6, .8);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(.055, 10, 8), new THREE.MeshBasicMaterial({ transparent: true }));
        dot.position.copy(branch.center); this.scene.add(dot);
        glow.userData.navigationAggregate = dot.userData.navigationAggregate = true;
        light = { glow, dot }; this.aggregateLights.set(branch.key, light);
      }
      light.glow.material.color.copy(color); light.dot.material.color.copy(color);
      light.glow.material.opacity = this.light ? .4 : .85;
      const blending = this.light ? THREE.NormalBlending : THREE.AdditiveBlending;
      if (light.glow.material.blending !== blending) { light.glow.material.blending = blending; light.glow.material.needsUpdate = true; }
      light.glow.userData.baseSize = Math.min(.75, .35 + Math.log2(members.length) * .035);
    }
  }
  private approachAggregate(branch: DensityBranch): void {
    this.forcedDensity.clear();
    const target = new THREE.Vector3().copy(branch.center);
    const currentDistance = this.camera.position.distanceTo(target);
    const distance = Math.max(.9, Math.min(currentDistance * .48, branch.radius * 3.5));
    if (currentDistance < 1.1 || branch.radius < .012) { this.browseCategory(branch.group); return; }
    const to = target.clone().addScaledVector(target.clone().normalize(), distance);
    if (!this.still.matches) this.transition = { start: performance.now(), from: this.camera.position.clone(), to, fromTarget: this.controls.target.clone(), target };
    else { this.transition = undefined; this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); }
    this.request();
  }
  private project(point: THREE.Vector3): THREE.Vector3 {
    const projected = point.clone().project(this.camera);
    return new THREE.Vector3((projected.x * .5 + .5) * this.width, (-projected.y * .5 + .5) * this.height, projected.z);
  }
  private updateLabels(): void {
    const occupied: LabelBox[] = [];
    // Batch all dimension reads BEFORE any label writes. Former per-label
    // opacity/position writes followed by offsetWidth forced repeated layouts.
    for (const button of [...this.labels.map(label => label.button), ...this.aggregateButtons.values()]) {
      if (!this.labelSizes.has(button)) this.labelSizes.set(button, { width: button.offsetWidth || 160, height: button.offsetHeight || 32 });
    }
    const stageBounds = this.host.getBoundingClientRect();
    for (const control of this.host.parentElement?.querySelectorAll(".memory-cosmos-toolbar > *, .memory-cosmos-footnote > *") ?? []) {
      const rect = control.getBoundingClientRect();
      occupied.push({ x: rect.left - stageBounds.left - 5, y: rect.top - stageBounds.top - 5, width: rect.width + 10, height: rect.height + 10 });
    }
    const cameraKey = [...this.camera.position.toArray(), ...this.camera.quaternion.toArray(), this.width, this.height].join(":");
    if (cameraKey !== this.labelCameraKey) { this.previousLabelBoxes.clear(); this.labelCameraKey = cameraKey; }
    const stableBoxes = retainLabelBoxes(this.previousLabelBoxes, occupied, this.width, this.height);
    const nextBoxes = new Map<HTMLButtonElement, LabelBox>();
    for (const box of stableBoxes.values()) occupied.push({ x: box.x - 5, y: box.y - 4, width: box.width + 10, height: box.height + 8 });
    const neighbours = this.neighbours();
    const protectedIds = this.protectedFiles();
    const category = this.state.selected === null ? this.state.category : null;
    const priority = (label: Label) => label.node && (label.node.id === this.focusedFile || label.node.id === this.hoveredFile) ? 130 : label.node?.id === this.state.selected ? 120 : label.node && neighbours.has(label.node.id) ? 110 : label.node && this.state.highlighted.has(label.node.id) ? 105 : label.region ? 60 : label.node?.kind === "core" ? 80 : 70;
    const ordered = [...this.labels].sort((a, b) => priority(b) - priority(a));
    let count = 0;
    let candidates = 0;
    const placeFileOrRegion = (label: Label) => {
      const p = label.node ? this.projectedNodes.get(label.node.id)! : this.project(label.point);
      if (label.node) { label.button.dataset.pointX = String(p.x); label.button.dataset.pointY = String(p.y); }
      const protectedFile = !!label.node && protectedIds.has(label.node.id);
      const facing = surfaceFacing(label.point, this.camera.position);
      const opacity = label.region ? 1 : memoryLabelOpacity(this.camera.position.distanceTo(label.point), facing, protectedFile, category === label.node?.group);
      const foreground = label.region ? label.region.members.some(member => surfaceVisible(member.position, this.camera.position)) : surfaceVisible(label.point, this.camera.position, protectedFile);
      let visible = foreground && opacity >= .12 && (!label.node || !this.aggregated.has(label.node.id)) && p.z >= -1 && p.z <= 1 && p.x > -90 && p.x < this.width + 90 && p.y > -60 && p.y < this.height + 60 && count < 100;
      if (category !== null) visible &&= !!label.node && label.node.group === category;
      if (this.state.selected !== null) visible &&= !!label.node && neighbours.has(label.node.id);
      if (!visible || candidates++ >= 240) { if (label.button.style.visibility !== "hidden") label.button.style.visibility = "hidden"; return; }
      label.button.style.opacity = String(opacity);
      const measured = this.labelSizes.get(label.button)!;
      const width = Math.min(measured.width, this.width - 24), height = measured.height;
      let x = p.x - width / 2, y = p.y + 16;
      if (label.region) {
        // Headings live outside their member cap, not over the region centre.
        const origin = this.project(new THREE.Vector3());
        const outward = new THREE.Vector2(p.x - origin.x, p.y - origin.y);
        if (outward.length() < 4) outward.set(0, -1); else outward.normalize();
        const focal = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
        const reach = label.region.radius * focal / this.camera.position.distanceTo(label.point) * .9 + 32;
        x = THREE.MathUtils.clamp(p.x + outward.x * reach - width / 2, 12, Math.max(12, this.width - width - 12));
        y = THREE.MathUtils.clamp(p.y + outward.y * reach - height / 2, 12, Math.max(12, this.height - height - 12));
      }
      const box = stableBoxes.get(label.button) ?? (label.region || protectedFile ? placeRegionHeading : placeLabel)({ x, y, width, height }, occupied, this.width, this.height);
      label.button.style.visibility = box ? "visible" : "hidden";
      if (box) {
        label.button.style.left = `${box.x}px`; label.button.style.top = `${box.y}px`;
        nextBoxes.set(label.button, box);
        if (!stableBoxes.has(label.button)) occupied.push({ x: box.x - 5, y: box.y - 4, width: box.width + 10, height: box.height + 8 });
        count++;
      }
    };
    ordered.filter(label => label.node && protectedIds.has(label.node.id)).forEach(placeFileOrRegion);
    // Count markers take precedence over unprotected titles, but never selected,
    // hovered or keyboard-focused file chips. No collision restores dense dots.
    for (const aggregate of this.aggregates) {
      const button = this.aggregateButtons.get(aggregate.branch.key)!;
      const point = this.project(new THREE.Vector3().copy(aggregate.branch.center));
      button.dataset.pointX = String(point.x); button.dataset.pointY = String(point.y);
      const { width, height } = this.labelSizes.get(button)!;
      const box = placeClusterBadge(point, width, height, occupied, this.width, this.height);
      button.style.visibility = box ? "visible" : "hidden";
      const light = this.aggregateLights.get(aggregate.branch.key)!;
      light.glow.visible = light.dot.visible = true;
      if (box) { button.style.left = `${box.x}px`; button.style.top = `${box.y}px`; occupied.push({ x: box.x - 3, y: box.y - 3, width: width + 6, height: height + 6 }); }
      else {
        const parent = this.densityParents.get(aggregate.branch.key);
        if (parent && !this.forcedDensity.has(parent.key)) { this.forcedDensity.add(parent.key); this.request(); }
      }
    }
    ordered.filter(label => !label.node || !protectedIds.has(label.node.id)).forEach(placeFileOrRegion);
    this.previousLabelBoxes = nextBoxes;
  }
  private finishTransition(): void {
    if (!this.transition) return;
    this.camera.position.copy(this.transition.to); this.controls.target.copy(this.transition.target); this.transition = undefined; this.controls.update();
  }
  private pause(): void { cancelAnimationFrame(this.frame); this.frame = 0; }
  private request = (): void => {
    if (this.disposed || this.frame || document.hidden || !this.visible) return;
    this.frame = requestAnimationFrame(this.draw);
  };
  private draw = (): void => {
    this.frame = 0;
    if (this.disposed || document.hidden || !this.visible || this.width <= 1 || this.height <= 1) return;
    try {
    if (this.transition) {
      const t = Math.min(1, (performance.now() - this.transition.start) / 650), ease = t * t * (3 - 2 * t);
      const fromOffset = this.transition.from.clone().sub(this.transition.fromTarget), toOffset = this.transition.to.clone().sub(this.transition.target);
      const rotation = new THREE.Quaternion().setFromUnitVectors(fromOffset.clone().normalize(), toOffset.clone().normalize());
      const direction = fromOffset.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(rotation, ease));
      this.controls.target.lerpVectors(this.transition.fromTarget, this.transition.target, ease);
      this.camera.position.copy(this.controls.target).addScaledVector(direction, THREE.MathUtils.lerp(fromOffset.length(), toOffset.length(), ease));
      this.camera.lookAt(this.controls.target);
      if (t === 1) { this.transition = undefined; this.controls.update(); }
    }
    this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld();
    this.updateDensity();
    this.updateLabels();
    const direction = this.camera.position.clone().normalize();
    const protectedFiles = this.neighbours();
    const focal = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const inverse = this.camera.matrixWorldInverse.elements;
    const viewDepth = (p: THREE.Vector3) => -(inverse[2]! * p.x + inverse[6]! * p.y + inverse[10]! * p.z + inverse[14]!);
    const counts = new Map<string, { glows: number; clouds: number }>();
    for (const visual of this.visuals) {
      const p = this.projectedNodes.get(visual.node.id)!;
      const individual = focusedMemoryVisible(visual.node.id, this.state.selected, protectedFiles) && !this.aggregated.has(visual.node.id);
      const inView = (margin: number) => p.z >= -1 && p.z <= 1 && p.x > -margin && p.x < this.width + margin && p.y > -margin && p.y < this.height + margin;
      visual.mesh.visible = individual; visual.glow.visible = individual && inView(32);
      if (visual.cloud) visual.cloud.visible = individual && inView(160);
      const count = counts.get(visual.node.group) ?? { glows: 0, clouds: 0 };
      if (visual.glow.visible) count.glows++;
      if (visual.cloud?.visible) count.clouds++;
      counts.set(visual.node.group, count);
    }
    for (const visual of this.visuals) {
      const count = counts.get(visual.node.group)!;
      const distance = viewDepth(visual.mesh.position);
      const selected = visual.node.id === this.state.selected;
      visual.mesh.scale.setScalar(boundedVisualScale(visual.mesh.userData.baseScale ?? 1, distance, focal, isSkill(visual.node) ? .047 : visual.node.kind === "core" ? .052 : .039, selected ? 8 : 6));
      visual.ring.scale.setScalar(boundedVisualScale(1, distance, focal, .096, 14));
      visual.glow.scale.setScalar(boundedVisualScale(visual.glow.userData.baseSize, distance, focal, .8, selected ? 32 : 28));
      if (visual.cloud) visual.cloud.scale.setScalar(boundedVisualScale(visual.cloud.userData.baseSize, distance, focal, .8, 160));
      visual.ring.quaternion.copy(this.camera.quaternion);
      const facing = visual.mesh.position.clone().normalize().dot(direction);
      const depth = this.state.category === visual.node.group || protectedFiles.has(visual.node.id) || this.state.highlighted.has(visual.node.id) ? 1 : .1 + .9 * THREE.MathUtils.smoothstep(facing, -.1, .65);
      visual.mesh.material.opacity = (visual.mesh.userData.baseOpacity ?? 1) * depth;
      visual.glow.material.opacity = (visual.glow.userData.baseOpacity ?? .8) * depth * (selected ? 1 : glowEnergyGain(count.glows, 16));
      if (visual.cloud) visual.cloud.material.opacity = (visual.cloud.userData.baseOpacity ?? .13) * depth * glowEnergyGain(count.clouds, 4);
    }
    for (const light of this.aggregateLights.values()) {
      const distance = viewDepth(light.dot.position);
      light.dot.scale.setScalar(boundedVisualScale(1, distance, focal, .055, 6));
      light.glow.scale.setScalar(boundedVisualScale(light.glow.userData.baseSize, distance, focal, .8, 32));
    }
    // Near-surface navigation must not stack the entire globe's filaments into
    // a white band. Selection retains the shell, dust and woven filaments:
    // removing unrelated files must not remove the globe's visual structure.
    // Normal overview/category-focus atmosphere is unchanged.
    const atmosphereGain = THREE.MathUtils.clamp((this.camera.position.length() - 2.96) / 3.5, .16, 1) * (this.state.selected === null ? 1 : .85);
    for (const object of this.atmosphere.children) {
      if (object.userData.shell) {
        object.userData.atmosphereGain = atmosphereGain;
        (object as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>).material.uniforms.strength!.value = (this.light ? .45 : 1) * atmosphereGain;
      } else {
        const material = (object as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>).material;
        material.opacity = (material.userData.baseOpacity ?? .14) * atmosphereGain;
      }
    }
    const onScreen = (id: string) => { const p = this.projectedNodes.get(id); return !!p && p.z >= -1 && p.z <= 1 && p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= this.height; };
    let ordinaryEdges = 0;
    for (const edge of this.edges) {
      edge.line.visible = this.state.selected !== null ? !!edge.line.userData.active : (!this.aggregated.has(edge.source) && !this.aggregated.has(edge.target) && onScreen(edge.source) && onScreen(edge.target));
      if (edge.line.visible && !edge.line.userData.active) ordinaryEdges++;
    }
    for (const edge of this.edges) edge.line.material.opacity = (edge.line.userData.baseOpacity ?? .23) * (edge.line.userData.active ? 1 : glowEnergyGain(ordinaryEdges, 24));
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    const ready = this.ready; this.ready = undefined; ready?.();
    if (this.transition) this.request();
    } catch { this.failed?.(); this.dispose(); }
  };
  dispose(): void {
    if (this.disposed) return;
    this.ready = undefined;
    this.disposed = true; clearTimeout(this.hoverClearTimer); this.pause(); this.cleanups.forEach(cleanup => cleanup());
    this.controls?.removeEventListener("change", this.request); this.controls?.dispose();
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : [];
      materials.forEach(material => material.dispose());
    });
    this.texture?.dispose();
    this.composer?.passes.forEach(pass => pass.dispose()); this.composer?.dispose();
    this.renderer?.dispose(); this.renderer?.domElement.remove();
    this.labels.forEach(label => label.button.remove());
    this.aggregateButtons.forEach(button => button.remove()); this.aggregateButtons.clear(); this.aggregateLights.clear();
    this.labelSizes.clear(); this.projectedNodes.clear(); this.previousLabelBoxes.clear();
  }
}
