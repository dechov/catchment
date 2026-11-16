// What if: reservoirs that were planned and never built, flooded over today's landscape.
//
// The first is the Stormville Reservoir on Fishkill Creek, from the 1904 report of the Commission
// on Additional Water Supply (see pipeline/whatif_fishkill.py). It sits outside the real timeline:
// its view shows the water rising over today's ground and the dam and dikes it would need, and
// everything else about it is in its card and the tap panel, not on the map.
import * as THREE from "three";
import { Frame, Bounds, yOf, loadImage } from "./geo";
import { buildDam, DamData } from "./dams";

export interface WhatIfDoc {
  name: string; level_m: number; level_ft: number; crest_m: number;
  mask: { file: string; bounds: Bounds };
  dam_at: [number, number];
  walls: { dam: boolean; crest: [number, number][]; low_m: number }[];
  stats: { acres: number; area_km2: number; drainage_sq_mi: number; volume_bn_gal: number; max_depth_ft: number; dam_height_ft: number };
  report: { acres: number; level_ft: number; drainage_sq_mi: number; storage_mgal: number; year: number; source: string; url: string };
  roads_km: number; rail_km: number; roads: { name: string; km: number }[];
}

const RISE_S = 6;   // seconds for the water to rise from the creek to high water

export class WhatIf {
  readonly group = new THREE.Group();
  active = false;
  private level = 0;        // 0..1 of the way from the creek bed to high water
  private bed: number;
  private water: THREE.Mesh;
  private dams: THREE.Mesh[] = [];
  private maskPx: Uint8ClampedArray; private mw: number; private mh: number;

  static async load(url: string, frame: Frame, ground: (lon: number, lat: number) => number) {
    const doc: WhatIfDoc = await (await fetch(url)).json();
    const img = await loadImage(url.replace(/[^/]*$/, "") + doc.mask.file);
    return new WhatIf(doc, img, frame, ground);
  }

  constructor(readonly doc: WhatIfDoc, img: HTMLImageElement, private frame: Frame, ground: (lon: number, lat: number) => number) {
    const b = doc.mask.bounds;
    const [x0, z0] = frame.xz(b.west, b.north), [x1, z1] = frame.xz(b.east, b.south);
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0); geo.rotateX(-Math.PI / 2);
    const tex = new THREE.Texture(img); tex.needsUpdate = true;
    this.water = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { mask: { value: tex }, alpha: { value: 0 } }, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      // the same water as the real reservoirs, a touch lighter, so the ground shows faintly through
      fragmentShader: /* glsl */ `
        uniform sampler2D mask; uniform float alpha; varying vec2 vUv;
        void main(){ float m = smoothstep(0.35, 0.65, texture2D(mask, vUv).r); if (m < 0.01) discard;
          gl_FragColor = vec4(0.17, 0.4, 0.6, 0.78 * m * alpha); }`,
    }));
    this.water.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.water.renderOrder = 2;
    this.group.add(this.water);
    this.bed = Math.min(...doc.walls.map((w) => w.low_m));
    // the dam across the creek, and earth dikes where the rim dips below high water
    doc.walls.forEach((w, k) => {
      const d: DamData = {
        name: k === 0 ? "Stormville Dam" : "dike", lon: w.crest[0][0], lat: w.crest[0][1], year: 0,
        height_ft: (doc.crest_m - w.low_m) / 0.3048, length_ft: null, type: "Earth",
        crests: [w.crest], upstream: [], crest_elev_m: doc.crest_m,
      };
      const m = buildDam(d, frame, ground);
      if (m) { this.dams.push(m); this.group.add(m); }
    });
    // the mask, for "is this point on the water"
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0);
    this.maskPx = ctx.getImageData(0, 0, c.width, c.height).data; this.mw = c.width; this.mh = c.height;
    this.group.visible = false;
  }

  /** Is (lon, lat) under the what-if water? (web-mercator bounds, so linear in lon; lat close enough) */
  contains(lon: number, lat: number) {
    const b = this.doc.mask.bounds;
    const u = (lon - b.west) / (b.east - b.west), v = (b.north - lat) / (b.north - b.south);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    return this.maskPx[(Math.floor(v * this.mh) * this.mw + Math.floor(u * this.mw)) * 4] > 127;
  }

  /** Switch the what-if on (the water rises from the creek) or off (it drains away quickly). */
  setActive(on: boolean) { this.active = on; if (on) this.group.visible = true; }
  /** Fill it at once (for links and screenshots). */
  fillNow() { this.level = 1; }

  update(dt: number) {
    if (!this.group.visible) return;
    this.level = this.active ? Math.min(1, this.level + dt / RISE_S) : Math.max(0, this.level - dt / 1.5);
    const e = this.level < 0.5 ? 2 * this.level * this.level : 1 - Math.pow(-2 * this.level + 2, 2) / 2;
    // the dam is there first; the water climbs behind it
    const damP = Math.min(1, this.level * 4);
    for (const m of this.dams) m.scale.y = Math.max(0.001, damP);
    const wl = this.bed + (this.doc.level_m - this.bed) * e;
    this.water.position.y = yOf(wl) + 0.002;
    (this.water.material as THREE.ShaderMaterial).uniforms.alpha.value = this.level > 0.02 ? 1 : 0;
    if (!this.active && this.level === 0) this.group.visible = false;
  }

  /** One line on what it would cover today, for the card and the tap panel. */
  drowned() {
    const r = this.doc.roads;
    const routes = r.filter((x) => /Route/.test(x.name)).slice(0, 2).map((x) => `${x.km.toFixed(1)} km of ${x.name}`);
    const long = (n: string) => n.replace(/ Dr$/, " Drive").replace(/ Ln$/, " Lane").replace(/ Rd$/, " Road");
    const streets = r.filter((x) => !/Route/.test(x.name) && x.km >= 0.5).slice(0, 2).map((x) => long(x.name));
    return `About ${Math.round(this.doc.roads_km)} km of today's roads, among them ${routes.join(" and ")} ` +
      `and long stretches of local streets such as ${streets.join(" and ")}, and ${this.doc.rail_km.toFixed(1)} km of the old Beacon rail line.`;
  }
}
