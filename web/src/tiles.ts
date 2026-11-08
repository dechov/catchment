// Streaming terrain: the ground as a quadtree of web-mercator tiles from the AWS Terrain Tiles
// (Terrarium PNGs, the same source as the region and valley heightmaps). Tiles near the camera
// split into finer ones, far ones stay coarse, and the land runs on to the horizon instead of
// stopping at the region's edge. The rebuilt valley patches are still drawn by their own meshes;
// the tile material cuts holes for them as the region mesh did.
import * as THREE from "three";
import { Frame, yOf } from "./geo";

// ?tilesrc=<base> serves the same tiles from elsewhere (a local mirror for offline checks)
const BASE = new URLSearchParams(location.search).get("tilesrc") ?? "https://elevation-tiles-prod.s3.amazonaws.com/terrarium";
const tileUrl = (z: number, x: number, y: number) => `${BASE}/${z}/${x}/${y}.png`;
const R = 6378137, WORLD = 2 * Math.PI * R;

interface Node {
  z: number; x: number; y: number;
  mesh: THREE.Mesh | null; state: "idle" | "loading" | "ready" | "failed";
  kids: Node[] | null;
  center: THREE.Vector3; size: number;   // scene units (km)
}

export class TileTerrain {
  group = new THREE.Group();
  private roots: Node[] = [];
  private inflight = 0;
  private queue: Node[] = [];
  /** tiles being fetched or waiting to be; for screenshots */
  get pending() { return this.inflight + this.queue.length; }

  constructor(
    private frame: Frame, private material: THREE.Material,
    centerLon: number, centerLat: number,
    private opts = { rootZ: 5, rootSpan: 2, maxZ: 13, segs: 32, detail: 2.2, maxInflight: 8 },
  ) {
    const n = 2 ** opts.rootZ;
    const cx = Math.floor(((centerLon + 180) / 360) * n);
    const latR = (centerLat * Math.PI) / 180;
    const cy = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
    for (let dy = -opts.rootSpan; dy <= opts.rootSpan; dy++)
      for (let dx = -opts.rootSpan; dx <= opts.rootSpan; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= n) continue;
        this.roots.push(this.node(opts.rootZ, (cx + dx + n) % n, y));
      }
  }

  private bounds(z: number, x: number, y: number) {
    const s = WORLD / 2 ** z;
    return { X0: -WORLD / 2 + x * s, X1: -WORLD / 2 + (x + 1) * s, Y0: WORLD / 2 - y * s, Y1: WORLD / 2 - (y + 1) * s };
  }

  private node(z: number, x: number, y: number): Node {
    const { X0, X1, Y0, Y1 } = this.bounds(z, x, y);
    const [ax, az] = this.frame.mxz(X0, Y0), [bx, bz] = this.frame.mxz(X1, Y1);
    return { z, x, y, mesh: null, state: "idle", kids: null,
      center: new THREE.Vector3((ax + bx) / 2, 0, (az + bz) / 2), size: Math.abs(bx - ax) };
  }

  private request(n: Node) {
    if (n.state !== "idle") return;
    n.state = "loading"; this.queue.push(n);
  }

  private pump(camPos: THREE.Vector3) {
    // nearest first
    this.queue.sort((a, b) => a.center.distanceToSquared(camPos) / a.size - b.center.distanceToSquared(camPos) / b.size);
    while (this.inflight < this.opts.maxInflight && this.queue.length) {
      const n = this.queue.shift()!;
      this.inflight++;
      this.load(n).catch(() => { n.state = "failed"; }).finally(() => { this.inflight--; });
    }
  }

  private async load(n: Node) {
    const res = await fetch(tileUrl(n.z, n.x, n.y), { mode: "cors" });
    if (!res.ok) throw new Error(String(res.status));
    const bmp = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const W = bmp.width, S = this.opts.segs, step = (W - 1) / S;
    const { X0, X1, Y0, Y1 } = this.bounds(n.z, n.x, n.y);
    // a grid of (S+1)^2 vertices plus a skirt hanging from its rim, so neighbours of different
    // detail never show a crack between them
    const nv = (S + 1) * (S + 1), rim = 4 * S;
    const pos = new Float32Array((nv + rim) * 3), uv = new Float32Array((nv + rim) * 2);
    const at = (x: number, y: number) => { const k = (y * W + x) * 4; return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768; };
    const h = (i: number, j: number) => {   // bilinear, on the tile's pixel grid (edges on its outer pixels)
      const x = Math.min(W - 1.001, i * step), y = Math.min(W - 1.001, j * step);
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0, v = 0; j <= S; j++)
      for (let i = 0; i <= S; i++, v++) {
        const [x, z] = this.frame.mxz(X0 + ((X1 - X0) * i) / S, Y0 + ((Y1 - Y0) * j) / S);
        const y = yOf(Math.max(-2, h(i, j)));   // the sea as a flat surface, not its floor
        pos.set([x, y, z], v * 3); uv.set([i / S, 1 - j / S], v * 2);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    const idx: number[] = [];
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const a = j * (S + 1) + i, b = a + 1, c2 = a + S + 1, d = c2 + 1;
        idx.push(a, c2, b, b, c2, d);
      }
    // skirt: walk the rim, each rim vertex gets a copy lowered by a fraction of the tile size
    const ring: number[] = [];
    for (let i = 0; i < S; i++) ring.push(i);                              // top, left to right
    for (let j = 0; j < S; j++) ring.push(j * (S + 1) + S);                // right, down
    for (let i = S; i > 0; i--) ring.push(S * (S + 1) + i);                // bottom, right to left
    for (let j = S; j > 0; j--) ring.push(j * (S + 1));                    // left, up
    const drop = n.size * 0.02 + 0.01;
    ring.forEach((r, k) => {
      const v = nv + k;
      pos.set([pos[r * 3], pos[r * 3 + 1] - drop, pos[r * 3 + 2]], v * 3);
      uv.set([uv[r * 2], uv[r * 2 + 1]], v * 2);
    });
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length], a2 = nv + k, b2 = nv + ((k + 1) % ring.length);
      idx.push(a, a2, b, b, a2, b2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // normals from the grid alone (central differences, one-sided at the rim): the skirt's
    // vertical faces must not tilt the rim's normals, or every tile edge shows as a line
    const nrm = new Float32Array((nv + rim) * 3);
    const P = (i: number, j: number) => (Math.min(S, Math.max(0, j)) * (S + 1) + Math.min(S, Math.max(0, i))) * 3;
    const a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), n3 = new THREE.Vector3();
    for (let j = 0, v = 0; j <= S; j++)
      for (let i = 0; i <= S; i++, v++) {
        const l = P(i - 1, j), r = P(i + 1, j), u = P(i, j - 1), d = P(i, j + 1);
        a3.set(pos[r] - pos[l], pos[r + 1] - pos[l + 1], pos[r + 2] - pos[l + 2]);
        b3.set(pos[d] - pos[u], pos[d + 1] - pos[u + 1], pos[d + 2] - pos[u + 2]);
        n3.crossVectors(b3, a3).normalize();
        nrm.set([n3.x, n3.y, n3.z], v * 3);
      }
    ring.forEach((r, k) => nrm.set([nrm[r * 3], nrm[r * 3 + 1], nrm[r * 3 + 2]], (nv + k) * 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    n.center.y = (minY + maxY) / 2;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.visible = false; mesh.frustumCulled = true;
    if (n.state !== "loading") { geo.dispose(); return; }   // pruned while loading
    n.mesh = mesh; n.state = "ready";
    this.group.add(mesh);
  }

  private wantsSplit(n: Node, cam: THREE.Vector3) {
    if (n.z >= this.opts.maxZ) return false;
    const d = Math.max(0.001, cam.distanceTo(n.center) - n.size * 0.7);
    return n.size / d > 1 / this.opts.detail;
  }

  private prune(n: Node) {
    if (n.kids) for (const k of n.kids) { this.prune(k); this.drop(k); }
    n.kids = null;
  }
  private drop(n: Node) {
    if (n.mesh) { this.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh = null; }
    if (n.state === "loading") { const i = this.queue.indexOf(n); if (i >= 0) this.queue.splice(i, 1); }
    n.state = "idle";
  }

  /** Returns true if this node (or, where it is split, its descendants) covers its area. */
  private visit(n: Node, cam: THREE.Vector3): boolean {
    this.request(n);
    if (this.wantsSplit(n, cam)) {
      if (!n.kids) {
        const z = n.z + 1, x = n.x * 2, y = n.y * 2;
        n.kids = [this.node(z, x, y), this.node(z, x + 1, y), this.node(z, x, y + 1), this.node(z, x + 1, y + 1)];
      }
      const covered = n.kids.map((k) => this.visit(k, cam)).every(Boolean);
      if (covered) { if (n.mesh) n.mesh.visible = false; return true; }
      // children not all there yet: show this tile instead, and hide the children that are
      if (n.mesh) { n.mesh.visible = true; for (const k of n.kids) this.hide(k); return true; }
      return false;
    }
    this.prune(n);
    if (n.mesh) n.mesh.visible = true;
    return n.state === "ready" || n.state === "failed";
  }
  private hide(n: Node) {
    if (n.mesh) n.mesh.visible = false;
    if (n.kids) for (const k of n.kids) this.hide(k);
  }

  update(camera: THREE.Camera) {
    const cam = camera.position;
    for (const r of this.roots) this.visit(r, cam);
    this.pump(cam);
  }
}
