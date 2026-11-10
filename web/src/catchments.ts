// Catchments: where the rain on any piece of ground ends up.
//
// flow.png (pipeline/catchments.py) holds, on the region's grid, each cell's D8 flow direction,
// the area draining through it, and the first NYC reservoir its water reaches. The shaders use
// it to tint each reservoir's catchment (once the reservoir exists; before that, its ground
// belongs to the next reservoir downstream), to outline the catchments, and to draw the streams.
// Tapping the ground traces everything upstream of that point and shows how much rain falls on it.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Bounds, mx, my } from "./geo";

export interface CatchInfo { [id: string]: { next: number; area_km2: number } }

const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
const RAIN_M_PER_YEAR = 1.15;   // average precipitation over the watersheds, roughly
const M3_PER_MG = 3785.41;

export function catchGLSL() {
  return /* glsl */ `
    uniform sampler2D flow; uniform vec2 flowTexel; uniform sampler2D catchLut; uniform float catchOn;
    uniform sampler2D traced; uniform float tracedOn;
    // the reservoir this cell's water reaches first among those that exist, resolved on the CPU
    // each year into a 64-entry table: rgb its system's colour, a its id (0: none)
    vec4 catchOf(vec2 uv) {
      float raw = floor(texture2D(flow, uv).b * 255.0 + 0.5);
      return texture2D(catchLut, vec2((raw + 0.5) / 64.0, 0.5));
    }
    vec3 applyCatch(vec3 c, vec3 w) {
      if (!inRegion(w)) return c;
      vec2 uv = regionUv(w);
      // streams: cells draining more than ~5 km2, stronger downstream
      float acc = texture2D(flow, uv).g * 255.0;
      c = mix(c, vec3(0.20, 0.42, 0.62), 0.55 * smoothstep(74.0, 120.0, acc));
      if (catchOn > 0.5) {
        // the four cells around this point, weighted as in bilinear filtering; the catchment
        // here is the one with the most weight, and its divide runs where that weight falls to
        // a half, a line that cuts smoothly across the cells instead of stepping around them
        vec2 g = uv / flowTexel - 0.5, f = fract(g), b = (floor(g) + 0.5) * flowTexel;
        vec4 q[4];
        q[0] = catchOf(b); q[1] = catchOf(b + vec2(flowTexel.x, 0.0));
        q[2] = catchOf(b + vec2(0.0, flowTexel.y)); q[3] = catchOf(b + flowTexel);
        float w[4];
        w[0] = (1.0 - f.x) * (1.0 - f.y); w[1] = f.x * (1.0 - f.y); w[2] = (1.0 - f.x) * f.y; w[3] = f.x * f.y;
        vec4 k = q[0]; float best = -1.0;
        for (int i = 0; i < 4; i++) {
          float s = 0.0;
          for (int j = 0; j < 4; j++) s += abs(q[j].a - q[i].a) < 0.001 ? w[j] : 0.0;
          if (s > best) { best = s; k = q[i]; }
        }
        if (k.a > 0.0) {
          c = mix(c, k.rgb, 0.3);
          // the divide: about two pixels wide on screen, whatever the zoom
          float e = best - 0.5, fw = max(fwidth(best), 1e-4);
          c = mix(c, k.rgb * 1.2, 0.95 * (1.0 - smoothstep(fw * 0.8, fw * 1.8, e)));
        }
      }
      if (tracedOn > 0.5) {
        float t = texture2D(traced, uv).r;
        c = mix(c, vec3(1.0, 0.86, 0.35), 0.45 * t);
        float e = abs(texture2D(traced, uv + vec2(flowTexel.x, 0.0)).r - t) + abs(texture2D(traced, uv + vec2(0.0, flowTexel.y)).r - t);
        c = mix(c, vec3(1.0, 0.75, 0.1), clamp(e * 2.0, 0.0, 1.0));
      }
      return c;
    }`;
}

export class Catchments {
  readonly W: number; readonly H: number;
  readonly dir: Uint8Array;
  readonly acc: Uint8Array;
  readonly first: Uint8Array;
  private mask: Uint8Array;
  readonly tracedTex: THREE.DataTexture;
  readonly uniforms: Record<string, { value: unknown }>;
  private next = new Int32Array(64);   // each reservoir's next one downstream
  private sys: THREE.Color[] = [];
  private lut = new Uint8Array(64 * 4);
  private lutTex: THREE.DataTexture;
  private lutKey = "";
  label: CSS2DObject; private labelDiv: HTMLDivElement;
  private panel: HTMLElement; private panelText: HTMLElement;

  constructor(img: HTMLImageElement, info: CatchInfo, private bounds: Bounds, sysColorOf: (id: number) => THREE.Color) {
    this.W = img.width; this.H = img.height;
    const c = document.createElement("canvas"); c.width = this.W; c.height = this.H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, this.W, this.H).data;
    this.dir = new Uint8Array(this.W * this.H);
    this.acc = new Uint8Array(this.W * this.H);
    this.first = new Uint8Array(this.W * this.H);
    for (let i = 0; i < this.dir.length; i++) { this.dir[i] = px[i * 4]; this.acc[i] = px[i * 4 + 1]; this.first[i] = px[i * 4 + 2]; }
    this.mask = new Uint8Array(this.W * this.H);
    this.tracedTex = new THREE.DataTexture(this.mask, this.W, this.H, THREE.RedFormat, THREE.UnsignedByteType);
    this.tracedTex.magFilter = THREE.LinearFilter; this.tracedTex.needsUpdate = true;
    const flowTex = new THREE.Texture(img);
    flowTex.magFilter = THREE.NearestFilter; flowTex.minFilter = THREE.NearestFilter; flowTex.generateMipmaps = false;
    flowTex.needsUpdate = true;
    for (let k = 0; k < 64; k++) { this.next[k] = info[k]?.next ?? 0; this.sys[k] = sysColorOf(k); }
    this.lutTex = new THREE.DataTexture(this.lut, 64, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.lutTex.needsUpdate = true;
    this.uniforms = {
      flow: { value: flowTex }, flowTexel: { value: new THREE.Vector2(1 / this.W, 1 / this.H) }, catchLut: { value: this.lutTex },
      catchOn: { value: 1 }, traced: { value: this.tracedTex }, tracedOn: { value: 0 },
    };
    // the tapped spot gets a small open ring, so the ground there stays visible; the figures go
    // in a panel fixed above the time bar
    this.labelDiv = document.createElement("div");
    this.labelDiv.className = "tap-ring";
    this.label = new CSS2DObject(this.labelDiv);
    this.label.visible = false;
    this.panel = document.getElementById("traceInfo")!;
    this.panelText = document.getElementById("traceText")!;
  }

  private cell(lon: number, lat: number): [number, number] | null {
    const b = this.bounds;
    const u = (mx(lon) - mx(b.west)) / (mx(b.east) - mx(b.west));
    const v = (my(b.north) - my(lat)) / (my(b.north) - my(b.south));
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return [Math.floor(u * this.W), Math.floor(v * this.H)];
  }

  /** Everything upstream of the point (lon, lat), or of the whole reservoir `resId` when the point
   *  is on one; returns the area in km^2, or null off the grid. */
  trace(lon: number, lat: number, cellKm2: number, resId = 0): number | null {
    const c0 = this.cell(lon, lat);
    if (!c0) return null;
    const { W, H, dir } = this;
    if (resId > 0) {
      // all ground whose water reaches this reservoir, through any reservoirs above it
      const into = new Uint8Array(64);
      for (let r = 1; r < 64; r++) { let k = r, n = 0; while (k > 0 && k !== resId && n++ < 10) k = this.next[k]; into[r] = k === resId ? 1 : 0; }
      const seen = new Uint8Array(W * H);
      let n = 0;
      for (let i = 0; i < seen.length; i++) if (into[this.first[i]]) { seen[i] = 1; n++; }
      this.setMask(seen);
      return n * cellKm2;
    }
    // the tapped cell, moved onto the strongest flow line within two cells (a tap rarely lands
    // exactly on a stream)
    let start = c0[1] * W + c0[0];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = c0[0] + dx, y = c0[1] + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && this.acc[y * W + x] > this.acc[start]) start = y * W + x;
      }
    const seen = new Uint8Array(W * H);
    const stack = [start];
    seen[start] = 1;
    // reverse D8: a cell drains into `i` if its direction points at `i`
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!; n++;
      const x = i % W, y = (i - x) / W;
      for (let k = 0; k < 8; k++) {
        const nx = x - DX[k], ny = y - DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!seen[j] && dir[j] === k + 1) { seen[j] = 1; stack.push(j); }
      }
    }
    this.setMask(seen);
    return n * cellKm2;
  }

  private setMask(seen: Uint8Array) {
    const { W, H } = this;
    // the texture's first row is the south edge (v = 0), the grid's is the north
    for (let y = 0; y < H; y++) this.mask.set(seen.subarray(y * W, (y + 1) * W).map((s) => s * 255), (H - 1 - y) * W);
    this.tracedTex.needsUpdate = true;
    this.uniforms.tracedOn.value = 1;
  }

  show(pos: THREE.Vector3, areaKm2: number, cityMgd: number, name?: string, extra = "") {
    const rainMgd = (areaKm2 * 1e6 * RAIN_M_PER_YEAR) / 365 / M3_PER_MG;
    const pct = (rainMgd / cityMgd) * 100;
    const share = cityMgd > 0 ? ` — ${pct < 1 ? "under 1" : Math.round(pct)}% of what the city uses` : "";
    const a = areaKm2 < 10 ? areaKm2.toFixed(1) : Math.round(areaKm2).toLocaleString();
    this.panelText.innerHTML = `<b>${a} km² drains ${name ? "into " + name : "to the marked spot"}</b><br>rain on it ≈ ${Math.round(rainMgd).toLocaleString()} million gal a day on average${share}` +
      (extra ? `<br><span class="displaced">${extra}</span>` : "") +
      `<br><span class="hint">tap elsewhere to trace again, or the same spot to clear</span>`;
    this.panel.hidden = false;
    this.label.position.copy(pos);
    this.label.visible = true;
  }

  /** Which reservoirs exist (`exists(id)`), so ground drains to the first existing one downstream. */
  update(exists: (id: number) => boolean) {
    const ids: number[] = [];
    for (let raw = 0; raw < 64; raw++) {
      let id = raw, n = 0;
      while (id > 0 && !exists(id) && n++ < 10) id = this.next[id];
      ids.push(id > 0 && exists(id) ? id : 0);
    }
    const key = ids.join(",");
    if (key === this.lutKey) return;
    this.lutKey = key;
    ids.forEach((id, raw) => {
      const c = this.sys[id] ?? new THREE.Color(0);
      this.lut.set([c.r * 255, c.g * 255, c.b * 255, id], raw * 4);
    });
    this.lutTex.needsUpdate = true;
  }

  clear() {
    this.uniforms.tracedOn.value = 0;
    this.label.visible = false;
    this.panel.hidden = true;
  }
}
