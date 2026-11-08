// Dams built from their crest lines (OpenStreetMap) and their type and height (NID).
//
// The cross-section follows the kind of dam: masonry and concrete dams are gravity walls with a
// near-vertical upstream face and a battered downstream face; earth dams are wide embankments
// with stone riprap on the water side and grass on the downstream side. The structure runs from
// the crest elevation down to the old valley floor, so it is tallest over the river and dies out
// into the abutments, as a real dam does.
import * as THREE from "three";
import { Frame, yOf } from "./geo";

export interface DamData {
  name: string; lon: number; lat: number; year: number; height_ft: number | null; length_ft: number | null;
  type: string | null; retired?: number | null;
  crests: [number, number][][]; upstream: number[]; crest_elev_m: number | null;
}

const STONE = new THREE.Color(0.8, 0.77, 0.7);
const STONE_DARK = new THREE.Color(0.66, 0.63, 0.57);
const RIPRAP = new THREE.Color(0.55, 0.55, 0.52);
const GRASS = new THREE.Color(0.42, 0.52, 0.32);
const ROAD = new THREE.Color(0.62, 0.6, 0.56);
const M_PER_DEG = 111_200;

/** A dam mesh, with its geometry relative to its lowest point so `scale.y` raises it from the
 *  bottom during construction. `ground` is the ground without the dam (pre-dam where known). */
export function buildDam(d: DamData, frame: Frame, ground: (lon: number, lat: number) => number): THREE.Mesh | null {
  const masonry = /masonry|concrete|gravity/i.test(d.type ?? "");
  const H = (d.height_ft ?? 50) * 0.3048;
  let crests = d.crests;
  if (!crests.length) crests = [guessCrest(d, ground)];
  const pos: number[] = [], col: number[] = [];
  let base = Infinity;
  const quads: [number[], number[], number[], number[], THREE.Color][] = [];

  crests.forEach((crest, ci) => {
    // densify to ~15 m
    const pts: [number, number][] = [];
    for (let i = 0; i < crest.length - 1; i++) {
      const [a, b] = [crest[i], crest[i + 1]];
      const k = Math.cos((a[1] * Math.PI) / 180);
      const n = Math.max(1, Math.ceil((Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG) / 15));
      for (let j = 0; j < n; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
    }
    pts.push(crest[crest.length - 1]);
    if (pts.length < 2) return;
    const k = Math.cos((pts[0][1] * Math.PI) / 180);
    // which side is the water: from the data, else the side whose ground stands higher
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) || 1e-9;
    let leftE = -(b[1] - a[1]) / L, leftN = ((b[0] - a[0]) * k) / L;   // unit vector, east/north
    let up = d.upstream[ci] ?? 0;
    const mid = pts[pts.length >> 1];
    const off = (p: [number, number], e: number, n: number, m: number): [number, number] =>
      [p[0] + (e * m) / (M_PER_DEG * k), p[1] + (n * m) / M_PER_DEG];
    if (!up) up = ground(...off(mid, leftE, leftN, 250)) >= ground(...off(mid, leftE, leftN, -250)) ? 1 : -1;
    leftE *= up; leftN *= up;   // now points upstream

    const crestM = d.crest_elev_m ?? Math.min(...pts.map((p) => ground(...p))) + H;
    // heights in the scene are exaggerated 3x; widen the cross-section too (less for the already
    // broad earth dams) so a dam reads as a dam and not as a knife edge
    const WX = masonry ? 3 : 1.5;
    const top = (masonry ? 6 : 10) * WX;
    const rows = pts.map((p) => {
      // the old ground under the crest: the lowest of the crest line and just downstream of it,
      // because modern terrain already contains the dam
      const g = Math.min(ground(...p), ground(...off(p, leftE, leftN, -60)), ground(...off(p, leftE, leftN, -120))) - 3;
      const h = Math.max(0, crestM - g);
      base = Math.min(base, g);
      const prof: [number, number][] = masonry
        ? [[top / 2 + 0.05 * h * WX, g], [top / 2, crestM], [-top / 2, crestM], [-top / 2 - 0.75 * h * WX, g]]
        : [[top / 2 + 2.8 * h * WX, g], [top / 2, crestM], [-top / 2, crestM], [-top / 2 - 2.2 * h * WX, g]];
      return prof.map(([s, e]) => {
        const [lo, la] = off(p, leftE, leftN, s);
        const [x, z] = frame.xz(lo, la);
        return [x, e, z];
      });
    });
    for (let i = 0; i < rows.length - 1; i++) {
      const r0 = rows[i], r1 = rows[i + 1];
      quads.push([r0[0], r0[1], r1[1], r1[0], masonry ? STONE : RIPRAP]);   // upstream face
      quads.push([r0[1], r0[2], r1[2], r1[1], masonry ? STONE_DARK : ROAD]); // crest
      quads.push([r0[2], r0[3], r1[3], r1[2], masonry ? STONE : GRASS]);     // downstream face
    }
    // end walls, so a dam that stops short of its abutment isn't hollow
    for (const r of [rows[0], rows[rows.length - 1]]) {
      quads.push([r[0], r[1], r[2], r[3], masonry ? STONE_DARK : GRASS]);
    }
  });
  if (!quads.length) return null;
  const yb = yOf(base);
  for (const [p0, p1, p2, p3, c] of quads) {
    for (const p of [p0, p1, p2, p0, p2, p3]) {
      pos.push(p[0], yOf(p[1]) - yb, p[2]);
      col.push(c.r * 0.55, c.g * 0.55, c.b * 0.55);   // the scene's lights are bright: tone down
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.position.y = yb;
  return mesh;
}

/** No mapped crest: a straight line of the dam's length through its point, turned to the angle
 *  whose two ends stand highest (the line across the valley rather than along it). */
function guessCrest(d: DamData, ground: (lon: number, lat: number) => number): [number, number][] {
  const half = Math.max(60, ((d.length_ft ?? 600) * 0.3048) / 2);
  const k = Math.cos((d.lat * Math.PI) / 180);
  let best: [number, number][] = [], bestH = -Infinity;
  for (let deg = 0; deg < 180; deg += 10) {
    const e = Math.cos((deg * Math.PI) / 180), n = Math.sin((deg * Math.PI) / 180);
    const a: [number, number] = [d.lon - (e * half) / (M_PER_DEG * k), d.lat - (n * half) / M_PER_DEG];
    const b: [number, number] = [d.lon + (e * half) / (M_PER_DEG * k), d.lat + (n * half) / M_PER_DEG];
    const h = Math.min(ground(...a), ground(...b));
    if (h > bestH) { bestH = h; best = [a, b]; }
  }
  return best;
}
