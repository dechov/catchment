import * as THREE from "three";
import { Frame, HeightGrid, mx, my, yOf } from "./geo";

const R = 6378137;

/** Grid mesh geometry over a heightmap, every `step` pixels. Optional extra per-vertex attributes. */
/** Grid mesh geometry over a heightmap, every `step` pixels, reaching the grid's exact bounds.
 *  With `edge`, heights within `edge.px` pixels of the border blend into `edge.at(lon, lat)`, so a
 *  detail patch meets the coarser terrain around it without a step. */
export function gridGeometry(
  g: HeightGrid, frame: Frame, step: number,
  extra: Record<string, (i: number) => number> = {},
  edge?: { at: (lon: number, lat: number) => number; px: number },
): THREE.BufferGeometry {
  const nx = Math.ceil((g.w - 1) / step) + 1;
  const ny = Math.ceil((g.h - 1) / step) + 1;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  const ex: Record<string, Float32Array> = {};
  for (const k in extra) ex[k] = new Float32Array(nx * ny);
  const X0 = mx(g.b.west), X1 = mx(g.b.east), Y0 = my(g.b.north), Y1 = my(g.b.south);
  let v = 0;
  for (let j = 0; j < ny; j++) {
    const py = Math.min(g.h - 1, j * step);
    for (let i = 0; i < nx; i++, v++) {
      const px = Math.min(g.w - 1, i * step);
      // pixel centres, except the outermost vertices, which sit on the bounds themselves
      const u = i === 0 ? 0 : i === nx - 1 ? 1 : (px + 0.5) / g.w;
      const t = j === 0 ? 0 : j === ny - 1 ? 1 : (py + 0.5) / g.h;
      const X = X0 + (X1 - X0) * u, Y = Y0 + (Y1 - Y0) * t;
      const [x, z] = frame.mxz(X, Y);
      const idx = py * g.w + px;
      let e = g.data[idx];
      if (edge) {
        const d = Math.min(px, g.w - 1 - px, py, g.h - 1 - py);
        if (d < edge.px) {
          const lon = (X / R) * 180 / Math.PI, lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) * 180 / Math.PI;
          const w = d / edge.px, k = w * w * (3 - 2 * w);
          e = edge.at(lon, lat) * (1 - k) + e * k;
        }
      }
      pos[v * 3] = x; pos[v * 3 + 1] = yOf(e); pos[v * 3 + 2] = z;
      uv[v * 2] = u; uv[v * 2 + 1] = 1 - t;
      for (const k in extra) ex[k][v] = extra[k](idx);
    }
  }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index[n++] = a; index[n++] = c; index[n++] = b;
      index[n++] = b; index[n++] = c; index[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  for (const k in ex) geo.setAttribute(k, new THREE.BufferAttribute(ex[k], 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}

// Shared GLSL: hypsometric tint + simple lighting, so the region and the Ashokan patch match.
export const shadeGLSL = /* glsl */ `
  vec3 landColor(float e) {
    vec3 c0 = vec3(0.36, 0.47, 0.30);  // lowland
    vec3 c1 = vec3(0.50, 0.55, 0.36);  // ~300 m
    vec3 c2 = vec3(0.60, 0.56, 0.44);  // ~700 m
    vec3 c3 = vec3(0.78, 0.76, 0.72);  // summits
    vec3 c = mix(c0, c1, smoothstep(0.0, 300.0, e));
    c = mix(c, c2, smoothstep(300.0, 750.0, e));
    return mix(c, c3, smoothstep(750.0, 1250.0, e));
  }
  vec3 light(vec3 base, vec3 n) {
    vec3 sun = normalize(vec3(-0.55, 0.75, -0.35));
    float d = max(dot(normalize(n), sun), 0.0);
    return base * (0.38 + 0.78 * d);
  }
  const vec3 WATER = vec3(0.16, 0.36, 0.55);
  const vec3 LAKE = vec3(0.33, 0.47, 0.58);
`;
