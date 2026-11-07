import * as THREE from "three";
import { Frame, HeightGrid, mx, my, yOf } from "./geo";

/** Grid mesh geometry over a heightmap, every `step` pixels. Optional extra per-vertex attributes. */
export function gridGeometry(
  g: HeightGrid, frame: Frame, step: number,
  extra: Record<string, (i: number) => number> = {},
): THREE.BufferGeometry {
  const nx = Math.floor((g.w - 1) / step) + 1;
  const ny = Math.floor((g.h - 1) / step) + 1;
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
      const u = (px + 0.5) / g.w, t = (py + 0.5) / g.h;
      const [x, z] = frame.mxz(X0 + (X1 - X0) * u, Y0 + (Y1 - Y0) * t);
      const idx = py * g.w + px;
      pos[v * 3] = x; pos[v * 3 + 1] = yOf(g.data[idx]); pos[v * 3 + 2] = z;
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
