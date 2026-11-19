import * as THREE from "three";

type Drawable = THREE.Line | THREE.Points | THREE.Mesh | THREE.Sprite;
type ColoredMaterial = THREE.Material & { color?: THREE.Color; size?: number; sizeAttenuation?: boolean; vertexColors?: boolean };

/** Same world geometry/camera as WebGL, with bounded atmosphere and edge work.
 * Semantic node drawing never shares the line budget (dense links cannot erase files).
 */
export class CosmosSoftwareRenderer {
  readonly domElement = document.createElement("canvas");
  light = false;
  private readonly ctx = this.domElement.getContext("2d");
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private disposed = false;
  setPixelRatio(ratio: number): void {
    this.pixelRatio = Number.isFinite(ratio) ? THREE.MathUtils.clamp(ratio, .5, 1.5) : 1;
    this.setSize(this.width, this.height);
  }
  setSize(width: number, height: number): void {
    this.width = Number.isFinite(width) ? Math.max(1, width) : 1;
    this.height = Number.isFinite(height) ? Math.max(1, height) : 1;
    this.domElement.width = Math.round(this.width * this.pixelRatio);
    this.domElement.height = Math.round(this.height * this.pixelRatio);
    this.domElement.style.width = `${this.width}px`; this.domElement.style.height = `${this.height}px`;
  }
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    const w = this.width, h = this.height;
    scene.updateMatrixWorld(); camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const direction = camera.position.clone().normalize();
    const focal = h * Math.abs(camera.projectionMatrix.elements[5]) / 2;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = this.light ? "source-over" : "screen"; ctx.globalAlpha = 1;
    const color = (input: THREE.Color, opacity: number): string => {
      const c = input.clone().convertLinearToSRGB();
      if (this.light) { const hsl = c.getHSL({ h: 0, s: 0, l: 0 }); c.setHSL(hsl.h, Math.max(.35, hsl.s), Math.min(.42, hsl.l)); }
      const channel = (value: number) => Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
      return `rgba(${channel(c.r)},${channel(c.g)},${channel(c.b)},${THREE.MathUtils.clamp(opacity, 0, 1)})`;
    };
    const clip = (world: THREE.Vector3) => new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(matrix);
    const valid = (p: THREE.Vector4) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(p.w);
    const inside = (p: THREE.Vector4) => valid(p) && p.w > 0 && Math.abs(p.x) <= p.w && Math.abs(p.y) <= p.w && Math.abs(p.z) <= p.w;
    const screen = (p: THREE.Vector4): [number, number] => [(.5 + p.x / p.w * .5) * w, (.5 - p.y / p.w * .5) * h];
    const objects: Drawable[] = [];
    scene.traverseVisible(object => {
      const o = object as Drawable;
      if (object.layers.test(camera.layers) && ("isLine" in o || "isPoints" in o || "isMesh" in o || "isSprite" in o)) objects.push(o);
    });
    const edgeVertices = objects.reduce((sum, o) => sum + (o instanceof THREE.Line && !o.userData.decoration ? o.geometry.getAttribute("position")?.count ?? 0 : 0), 0);
    const edgeStride = Math.max(1, Math.ceil(edgeVertices / 16000));
    const inverse = camera.matrixWorldInverse.elements;
    const depths = new Map(objects.map(object => { const e = object.matrixWorld.elements; return [object, inverse[2]! * e[12]! + inverse[6]! * e[13]! + inverse[10]! * e[14]! + inverse[14]!] as const; }));
    objects.sort((a, b) => {
      // Shell first; selected links receive their independent edge budget first.
      if (!!a.userData.shell !== !!b.userData.shell) return a.userData.shell ? -1 : 1;
      if (!!a.userData.active !== !!b.userData.active) return a.userData.active ? -1 : 1;
      return depths.get(a)! - depths.get(b)!;
    });
    let decorationBudget = 22000, edgeBudget = 18000;
    for (const object of objects) {
      const material = (Array.isArray(object.material) ? object.material[0] : object.material) as ColoredMaterial | undefined;
      if (!material?.visible || !Number.isFinite(material.opacity) || material.opacity <= 0) continue;
      const tint = material.color ?? new THREE.Color(0xffffff), opacity = material.opacity;
      if (object instanceof THREE.Line || object instanceof THREE.Points) {
        const decoration = object.userData.decoration === true || object instanceof THREE.Points;
        let remaining = decoration ? decorationBudget : edgeBudget;
        if (remaining <= 0) continue; // Never skip later file meshes because lines exhausted their budget.
        const geometry = object.geometry, position = geometry.getAttribute("position"), index = geometry.index;
        if (!position) continue;
        const start = Math.max(0, geometry.drawRange.start), end = Math.min(index?.count ?? position.count, start + geometry.drawRange.count);
        const world = (i: number) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(object.matrixWorld);
        if (object instanceof THREE.Points) {
          const colors = material.vertexColors ? geometry.getAttribute("color") : undefined;
          const frontColor = color(tint, opacity * .85), backColor = color(tint, opacity * .22);
          const wp = new THREE.Vector3(), p = new THREE.Vector4();
          for (let i = start; i < end && remaining-- > 0; i++) {
            wp.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(object.matrixWorld);
            p.set(wp.x, wp.y, wp.z, 1).applyMatrix4(matrix);
            if (!inside(p)) continue;
            const [x, y] = screen(p), front = wp.dot(direction) > 0;
            const co = colors ? new THREE.Color().fromBufferAttribute(colors, index ? index.getX(i) : i).multiply(tint) : tint;
            const size = THREE.MathUtils.clamp((material.size ?? 1) * (material.sizeAttenuation === false ? 1 : focal / p.w), front ? .8 : .45, 6);
            ctx.fillStyle = colors ? color(co, opacity * (front ? .85 : .22)) : front ? frontColor : backColor; ctx.fillRect(x - size / 2, y - size / 2, size, size);
          }
        } else {
          const paths: number[][] = [[], []];
          const segment = (a: THREE.Vector4, b: THREE.Vector4, front: boolean): void => {
            if (!valid(a) || !valid(b)) return;
            const path = paths[front ? 1 : 0]!;
            if (inside(a) && inside(b)) { path.push((.5 + a.x / a.w * .5) * w, (.5 - a.y / a.w * .5) * h, (.5 + b.x / b.w * .5) * w, (.5 - b.y / b.w * .5) * h); return; }
            let lo = 0, hi = 1;
            const planes = (p: THREE.Vector4) => [p.w + p.x, p.w - p.x, p.w + p.y, p.w - p.y, p.w + p.z, p.w - p.z];
            const aa = planes(a), bb = planes(b);
            for (let j = 0; j < 6; j++) {
              const first = aa[j]!, last = bb[j]!;
              if (first < 0 && last < 0) return;
              if (first < 0) lo = Math.max(lo, first / (first - last));
              if (last < 0) hi = Math.min(hi, first / (first - last));
            }
            if (lo > hi) return;
            const first = a.clone().lerp(b, lo), last = a.clone().lerp(b, hi);
            if (first.w <= 0 || last.w <= 0) return;
            path.push(...screen(first), ...screen(last));
          };
          const stride = object instanceof THREE.LineSegments ? 2 : decoration || object.userData.active ? 1 : edgeStride;
          let prior: { index: number; world: THREE.Vector3; clip: THREE.Vector4 } | undefined;
          for (let i = start; i + 1 < end && remaining-- > 0; i += stride) {
            const a = prior?.index === i ? prior.world : world(i), ac = prior?.index === i ? prior.clip : clip(a);
            const next = Math.min(end - 1, i + (object instanceof THREE.LineSegments ? 1 : stride));
            const b = world(next), bc = clip(b);
            segment(ac, bc, (a.x + b.x) * direction.x + (a.y + b.y) * direction.y + (a.z + b.z) * direction.z >= 0);
            prior = { index: next, world: b, clip: bc };
          }
          if (object instanceof THREE.LineLoop && end - start > 2 && remaining-- > 0) segment(clip(world(end - 1)), clip(world(start)), true);
          // Continuous globe filaments with depth attenuation, not dashed map circles.
          // Actual knowledge links remain heavier and much more opaque.
          ctx.setLineDash([]);
          const colors = material.vertexColors ? geometry.getAttribute("color") : undefined;
          const first = clip(world(start)), last = clip(world(Math.max(start, end - 1)));
          const gradientReady = colors && valid(first) && valid(last) && first.w > 0 && last.w > 0;
          paths.forEach((path, front) => {
            if (!path.length) return;
            const alpha = opacity * (decoration ? front ? 1 : .2 : front ? 1 : .45);
            ctx.lineWidth = decoration ? front ? .65 : .42 : object.userData.active ? 2.4 : 1.15;
            ctx.strokeStyle = color(tint, alpha);
            if (gradientReady) {
              const source = new THREE.Color().fromBufferAttribute(colors, index ? index.getX(start) : start);
              const target = new THREE.Color().fromBufferAttribute(colors, index ? index.getX(end - 1) : end - 1);
              const gradient = ctx.createLinearGradient(...screen(first), ...screen(last));
              gradient.addColorStop(0, color(source, alpha)); gradient.addColorStop(1, color(target, alpha));
              ctx.strokeStyle = gradient;
              ctx.shadowBlur = object.userData.active ? 7 : 0;
              ctx.shadowColor = color(source.clone().lerp(target, .5), alpha * .45);
            }
            ctx.beginPath(); for (let i = 0; i < path.length; i += 4) { ctx.moveTo(path[i]!, path[i + 1]!); ctx.lineTo(path[i + 2]!, path[i + 3]!); } ctx.stroke();
            ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
          });
        }
        if (decoration) decorationBudget = remaining; else edgeBudget = remaining;
        continue;
      }
      const world = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld), p = clip(world);
      if (!valid(p) || p.w <= 0 || Math.abs(p.z) > p.w) continue;
      const [x, y] = screen(p), scale = new THREE.Vector3().setFromMatrixScale(object.matrixWorld);
      const projectedScale = focal / p.w * Math.max(Math.abs(scale.x), Math.abs(scale.y));
      let worldRadius = .5;
      if (object instanceof THREE.Mesh) { if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere(); worldRadius = object.geometry.boundingSphere?.radius ?? 0; }
      const sprite = object instanceof THREE.Sprite;
      const limit = object.userData.shell ? Infinity : sprite ? object.userData.cloud ? 160 : object.userData.navigationAggregate || object.userData.selected ? 32 : 28 : object instanceof THREE.Mesh && object.geometry.type === "RingGeometry" ? 14 : 8;
      const radius = Math.min(limit, (sprite ? .8 : worldRadius) * projectedScale);
      if (!Number.isFinite(radius) || radius <= 0 || radius > Math.max(w, h) * 4 || x + radius * 1.2 < 0 || x - radius * 1.2 > w || y + radius * 1.2 < 0 || y - radius * 1.2 > h) continue;
      if (object.userData.shell) {
        // Analytic projection of the Fresnel sphere, using live theme colors.
        // The broad falloff existed in the accepted software concept and carries volume.
        const body: THREE.Color = object.userData.bodyColor ?? tint;
        const rim: THREE.Color = object.userData.rimColor ?? tint;
        const strength = (this.light ? .42 : 1) * (object.userData.atmosphereGain ?? 1);
        const gradient = ctx.createRadialGradient(x - radius * .08, y - radius * .12, radius * .1, x, y, radius * 1.2);
        gradient.addColorStop(0, color(body, .025 * strength));
        gradient.addColorStop(.55, color(body, .05 * strength));
        gradient.addColorStop(.72, color(rim, .16 * strength));
        gradient.addColorStop(.80, color(rim, .30 * strength));
        gradient.addColorStop(.86, color(body, .15 * strength));
        gradient.addColorStop(1, color(body, 0));
        ctx.fillStyle = gradient; ctx.fillRect(x - radius * 1.25, y - radius * 1.25, radius * 2.5, radius * 2.5);
      } else if (sprite) {
        const cloud = object.userData.cloud === true;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, color(tint, opacity * (cloud ? .5 : .9)));
        gradient.addColorStop(cloud ? .45 : .12, color(tint, opacity * (cloud ? .3 : .6)));
        if (!cloud) gradient.addColorStop(.4, color(tint, opacity * .16));
        gradient.addColorStop(1, color(tint, 0)); ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      } else if (object instanceof THREE.Mesh) {
        ctx.beginPath();
        if (object.geometry.type === "OctahedronGeometry") { ctx.moveTo(x, y - radius); ctx.lineTo(x + radius, y); ctx.lineTo(x, y + radius); ctx.lineTo(x - radius, y); ctx.closePath(); }
        else ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color(tint, opacity); ctx.strokeStyle = color(tint, opacity * .65); ctx.lineWidth = .7;
        if (object.geometry.type === "RingGeometry") ctx.stroke(); else ctx.fill();
      }
    }
    ctx.setLineDash([]); ctx.globalCompositeOperation = "source-over";
  }
  dispose(): void { this.disposed = true; this.domElement.width = 0; this.domElement.height = 0; }
}
