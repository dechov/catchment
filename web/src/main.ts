import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Bounds, Frame, HeightGrid, yOf, loadImage } from "./geo";
import { gridGeometry, shadeGLSL } from "./terrain";
import { buildDam, DamData } from "./dams";
import {
  Reservoir, Aqueduct, Dam, Event, fillFraction, damProgress, damProgressFromYear, lineState,
  ERAS, SYSTEM_COLORS,
} from "./timeline";

interface Valley {
  id: string; bounds: Bounds; water_level_m: number; reservoir_id: number;
  maps: { title: string; year: number }[]; synthetic: boolean;
  /** dated map editions, oldest first: "pre" ones before the reservoir, "post" ones after */
  editions: { file: string; phase: "pre" | "post"; year: number | null; maps: string[] }[];
  /** smaller, older lakes the reservoir drowned (Croton Lake behind the 1842 dam) */
  old_lakes: { file: string; level_m: number; name: string; reservoir_id: number }[];
  /** the rivers before the reservoir, traced from the old maps */
  old_rivers: [number, number][][];
}
interface Scene {
  region: { bounds: Bounds; size: [number, number] };
  valleys: Valley[];
  reservoirs: Reservoir[]; dams: DamData[]; aqueducts: Aqueduct[]; events: Event[];
}

const D = "./data/";
const T0 = 1830, T1 = 2030;
const PLAY_YEARS_PER_SEC = 4;
const MAX_RES = 32;
const MAX_CUT = 12;
const TUNNEL_DEPTH_M = 120;

// real routes from OpenStreetMap (routes.json), split into runs by how they were built
interface Run { kind: "tunnel" | "cutcover" | "bridge"; coords: [number, number][] }
interface Routes { attribution: string; routes: Record<string, { runs: Run[] }> }

async function main() {
  const data: Scene = await (await fetch(D + "scene.json")).json();
  const q = new URLSearchParams(location.search).get("q");
  const low = q === "low" || innerWidth < 700;
  const frame = new Frame(data.region.bounds);
  const loadingEl = document.getElementById("loading")!;
  let nLoaded = 0;
  const nFiles = 5 + data.valleys.length * 5;
  const count = <T,>(p: Promise<T>) => p.then((v) => { loadingEl.textContent = `Loading terrain… ${++nLoaded}/${nFiles}`; return v; });
  const [region, resIdImg, waterImg, routes, rivers, valleyFiles] = await Promise.all([
    count(HeightGrid.load(D + "region_height.png", data.region.bounds)),
    count(loadImage(D + "region_reservoirs.png")),
    count(loadImage(D + "water_mask.png")),
    count(fetch(D + "routes.json").then((r) => r.json() as Promise<Routes>)),
    count(fetch(D + "rivers.json").then((r) => r.json() as Promise<[number, number][][]>)),
    Promise.all(data.valleys.map((v) => Promise.all([
      count(HeightGrid.load(D + `${v.id}_pre.png`, v.bounds)),
      count(loadImage(D + `${v.id}_mask.png`)),
      count(loadImage(D + `${v.id}_water.png`)),
      count(loadImage(D + `${v.id}_dam.png`)),
      count(loadImage(D + `${v.id}_lakes.png`)),
      Promise.all(v.old_lakes.map((o) => loadImage(D + o.file))),
    ]))),
  ]);

  // ---- renderer, camera, controls ------------------------------------------------------
  const app = document.getElementById("app")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  (window as any).__ready = false;
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0xb9c8d4);
  app.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  labels.domElement.style.position = "fixed"; labels.domElement.style.inset = "0";
  labels.domElement.style.pointerEvents = "none";
  app.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xb9c8d4, 250, 650);
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 2000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 2; controls.maxDistance = 600;

  // ---- region terrain ------------------------------------------------------------------
  const tex = (img: HTMLImageElement, nearest = false) => {
    const t = new THREE.Texture(img);
    if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    t.needsUpdate = true; return t;
  };
  const fillU = { value: new Float32Array(MAX_RES) };
  const box = (b: Bounds) => { const [x0, z0] = frame.xz(b.west, b.north), [x1, z1] = frame.xz(b.east, b.south); return new THREE.Vector4(x0, z0, x1, z1); };
  const regionBox = box(data.region.bounds);
  const cutouts = data.valleys.slice(0, MAX_CUT).map((v) => box(v.bounds));
  while (cutouts.length < MAX_CUT) cutouts.push(new THREE.Vector4(1e9, 1e9, 1e9, 1e9));
  // the reservoir image is sampled twice: ids without filtering, the shore coverage (G) smoothly
  const resIdTex = tex(resIdImg, true), resCovTex = tex(resIdImg), lakeTex = tex(waterImg);
  // Water looked up by scene position, shared by the region and the valley patches:
  // the city's reservoirs (id mask, filled on schedule) and natural lakes, ponds and other
  // towns' reservoirs (OpenStreetMap), in a softer, greyer blue so the city's still stand out.
  const waterGLSL = /* glsl */ `
    uniform sampler2D resId; uniform sampler2D resCov; uniform sampler2D lakes; uniform float fill[${MAX_RES}]; uniform vec4 regionBox;
    vec2 regionUv(vec3 w) {
      return vec2((w.x - regionBox.x) / (regionBox.z - regionBox.x), 1.0 - (w.z - regionBox.y) / (regionBox.w - regionBox.y));
    }
    int waterId(vec3 w) { return int(texture2D(resId, regionUv(w)).r * 255.0 + 0.5); }
    vec3 applyLakes(vec3 c, vec3 w) {
      vec3 l = texture2D(lakes, regionUv(w)).rgb;
      c = mix(c, LAKE, smoothstep(0.3, 0.6, l.r));
      return mix(c, WATER * 0.85, smoothstep(0.35, 0.65, l.b));   // sea, Sound, tidal Hudson (coastline)
    }
    vec3 applyWater(vec3 c, int id, vec3 w) {
      if (id > 0 && id < ${MAX_RES}) {
        float f = 0.0;
        for (int k = 0; k < ${MAX_RES}; k++) if (k == id) f = fill[k];
        float cov = smoothstep(0.35, 0.65, texture2D(resCov, regionUv(w)).g);
        return mix(c, mix(c * vec3(0.92, 0.9, 0.8), WATER, f), cov);   // floor tint until it floods
      }
      return c;
    }`;
  const regionMat = new THREE.ShaderMaterial({
    uniforms: {
      resId: { value: resIdTex }, resCov: { value: resCovTex }, lakes: { value: lakeTex }, fill: fillU, regionBox: { value: regionBox },
      cutouts: { value: cutouts },
      fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
      alpha: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      void main() {
        vN = normal; vUv = uv; vE = position.y * 1000.0 / ${EXAG_STR}; vW = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 cutouts[${MAX_CUT}];
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float alpha;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      ${shadeGLSL}
      ${waterGLSL}
      void main() {
        for (int k = 0; k < ${MAX_CUT}; k++) {
          vec4 b = cutouts[k];
          if (vW.x > b.x && vW.x < b.z && vW.z > b.y && vW.z < b.w) discard;
        }
        vec3 c = applyLakes(landColor(vE), vW);
        c = applyWater(c, waterId(vW), vW);
        c = light(c, vN);
        float fog = smoothstep(fogNear, fogFar, vDepth);
        gl_FragColor = vec4(mix(c, fogColor, fog), alpha);
      }`,
  });
  const regionMesh = new THREE.Mesh(gridGeometry(region, frame, low ? 4 : 2), regionMat);
  scene.add(regionMesh);

  // ---- valley details: the pre-reservoir ground, the dam rising and the water filling ----
  // Each valley is a finer (~7-14 m) patch cut into the region. It shows the ground as it was
  // before the reservoir, draped with the USGS sheets of the time; the dam grows out of it and
  // a water plane climbs from the old valley floor to today's level.
  const valleyMats: THREE.ShaderMaterial[] = [];
  const oldRiverMats: LineMaterial[] = [];
  const valleys = data.valleys.map((v, n) => {
    const [pre, maskImg, waterImg_, damImg, lakesImg, oldLakeImgs] = valleyFiles[n];
    const maskData = imageRed(maskImg, pre.w, pre.h);
    const damData = imageRed(damImg, pre.w, pre.h);
    const step = q === "high" ? 1 : low ? 4 : 2;
    const maskGrid0 = new HeightGrid(pre.w, pre.h, Float32Array.from(maskData), v.bounds);
    const inV = (lon: number, lat: number) => lon > v.bounds.west && lon < v.bounds.east && lat > v.bounds.south && lat < v.bounds.north;
    // a modelled dam (crest line from OpenStreetMap) replaces the dam lifted out of the terrain
    const modelled = data.dams.some((d) => d.crests.length && inV(d.lon, d.lat) && maskGrid0.at(d.lon, d.lat) > 127);
    const geo = gridGeometry(pre, frame, step, { damH: (i) => (modelled ? 0 : damData[i]), inRes: (i) => maskData[i] / 255 },
      { at: (lo, la) => region.at(lo, la), px: Math.round(pre.w / 40) });
    const u = {
      topoA: { value: blankTex as THREE.Texture }, topoB: { value: blankTex as THREE.Texture }, topoK: { value: 0 }, topoMix: { value: 1 }, damP: { value: 0 }, alpha: { value: 1 },
      resId: { value: resIdTex }, resCov: { value: resCovTex }, lakes: { value: lakeTex }, fill: fillU, regionBox: { value: regionBox }, ownId: { value: v.reservoir_id }, detail: { value: tex(lakesImg) },
      fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: /* glsl */ `
        attribute float damH; attribute float inRes; uniform float damP;
        varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth; varying vec3 vW; varying float vIn;
        void main() {
          vec3 p = position; p.y += damH * damP * ${EXAG_STR} / 1000.0;
          vN = normal; vUv = uv; vE = p.y * 1000.0 / ${EXAG_STR}; vW = p; vIn = inRes;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D topoA; uniform sampler2D topoB; uniform float topoK; uniform float topoMix; uniform int ownId; uniform sampler2D detail;
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float alpha;
        varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth; varying vec3 vW; varying float vIn;
        ${shadeGLSL}
        ${waterGLSL}
        void main() {
          vec3 c = landColor(vE);
          // other water around the valley: lakes, and older or neighbouring reservoirs. Inside this
          // reservoir's own footprint the ground is pre-dam, so no lakes are drawn there.
          // lakes and sea from the patch's own, finer water map
          if (vIn < 0.5) {
            vec3 l = texture2D(detail, vUv).rgb;
            c = mix(c, LAKE, smoothstep(0.3, 0.6, l.r));
            c = mix(c, WATER * 0.85, smoothstep(0.35, 0.65, l.b));
          }
          // two map editions, crossfading from A to B (where only one has a sheet, that one)
          vec3 mA = texture2D(topoA, vUv).rgb, mB = texture2D(topoB, vUv).rgb;
          float hA = step(0.02, mA.r + mA.g + mA.b), hB = step(0.02, mB.r + mB.g + mB.b);   // outside the neatlines: 0
          float k = hB * (hA > 0.5 ? topoK : step(0.001, topoK));
          vec3 map = mix(mA, mB, k);
          // later editions print woods bright green and towns red: tone them toward the old sheets
          map = mix(vec3(dot(map, vec3(0.3, 0.59, 0.11))), map, 0.7);
          float has = max(hA * (1.0 - k), hB * k);
          // feather the map out toward the patch edges so it doesn't read as a pasted card
          float edge = smoothstep(0.0, 0.06, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
          c = mix(c, map * 1.05, topoMix * has * edge * 0.85);
          // other reservoirs in the patch (older or neighbouring ones, the city's), drawn over the
          // map while they hold water, so a map printed after one was removed can't hide it
          int id = waterId(vW);
          // (this valley's own reservoir too, outside the rebuilt footprint: the patch's border band)
          if ((id != ownId || vIn < 0.5) && id > 0 && id < ${MAX_RES}) {
            float f = 0.0;
            for (int k = 0; k < ${MAX_RES}; k++) if (k == id) f = fill[k];
            c = mix(c, WATER, f * smoothstep(0.35, 0.65, texture2D(resCov, regionUv(vW)).g));
          }
          c = light(c, vN);
          float fog = smoothstep(fogNear, fogFar, vDepth);
          gl_FragColor = vec4(mix(c, fogColor, fog), alpha);
        }`,
    });
    valleyMats.push(mat);
    scene.add(new THREE.Mesh(geo, mat));

    const b = box(v.bounds);
    const waterGeo = new THREE.PlaneGeometry(b.z - b.x, b.w - b.y);
    waterGeo.rotateX(-Math.PI / 2);
    const wU = { mask: { value: tex(waterImg_) }, alpha: { value: 0 } };
    const water = new THREE.Mesh(waterGeo, new THREE.ShaderMaterial({
      uniforms: wU, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D mask; uniform float alpha; varying vec2 vUv;
        void main(){ if (texture2D(mask, vUv).r < 0.5) discard;
          gl_FragColor = vec4(0.16, 0.38, 0.58, 0.88 * alpha); }`,
    }));
    water.position.set((b.x + b.z) / 2, 0, (b.y + b.w) / 2);
    scene.add(water);
    // older lakes under this reservoir, each a flat plane at its own level
    const oldLakes = v.old_lakes.map((o, k) => {
      const ou = { mask: { value: tex(oldLakeImgs[k]) }, alpha: { value: 0 } };
      const m = new THREE.Mesh(waterGeo, new THREE.ShaderMaterial({
        uniforms: ou, transparent: true, depthWrite: false,
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D mask; uniform float alpha; varying vec2 vUv;
          void main(){ if (texture2D(mask, vUv).r < 0.5) discard;
            gl_FragColor = vec4(0.16, 0.38, 0.58, 0.9 * alpha); }`,
      }));
      m.position.set((b.x + b.z) / 2, yOf(o.level_m) + 0.002, (b.y + b.w) / 2);
      scene.add(m);
      // reservoir_id -1: a natural lake (Rye Pond), there until this valley's reservoir drowns it
      return { res: data.reservoirs.find((r) => r.id === o.reservoir_id), u: ou };
    });
    // the city patch has no reservoir of its own (reservoir_id -1): a stand-in that never fills
    const res: Reservoir = data.reservoirs.find((r) => r.id === v.reservoir_id) ?? {
      id: -1, name: v.id, system: "croton", lon: 0, lat: 0, construction_start: null, fill_start: 1905, fill_end: 1930,
      in_service: null, retired: null, water_level_m: -1e4, approx: [] };
    let bed = Infinity;
    for (let i = 0; i < maskData.length; i++) if (maskData[i] > 127 && pre.data[i] < bed) bed = pre.data[i];
    if (!Number.isFinite(bed)) bed = 0;
    const inside = (lon: number, lat: number) => lon > v.bounds.west && lon < v.bounds.east && lat > v.bounds.south && lat < v.bounds.north;
    const maskGrid = maskGrid0;
    const damGrid = new HeightGrid(pre.w, pre.h, Float32Array.from(damData), v.bounds);
    // ground today: the water surface over the reservoir, the dam, and the old ground elsewhere
    const groundNow = (lon: number, lat: number) => {
      const g = pre.at(lon, lat) + damGrid.at(lon, lat);
      return maskGrid.at(lon, lat) > 127 ? Math.max(v.water_level_m, g) : g;
    };
    const fadeFrom = res.fill_start ?? (res.in_service ?? 9999) - 1;
    const fadeTo = Math.max(fadeFrom + 2, res.fill_end ?? res.in_service ?? fadeFrom + 2);
    // the map editions: each fades in over two years from the year it was printed. The first
    // map printed after the reservoir instead comes in once it is full, so the dated pre-dam
    // sheet stays under the rising water and a map of the reservoir never shows an empty valley.
    const firstPost = v.editions.findIndex((e) => e.phase === "post");
    const edWin = v.editions.map((e, i): [number, number] => {
      if (i === 0) return [-Infinity, -Infinity];
      if (i === firstPost && v.reservoir_id >= 0) return [fadeTo - 1, fadeTo + 1];
      const y = e.year ?? 0; return [y - 1, y + 1];
    });
    const maps = new MapStack(v.editions.map((e) => D + e.file), tex);
    // the old rivers, on the pre-dam ground
    const orPts: number[] = [];
    for (const line of v.old_rivers) {
      let prev: number[] | null = null;
      for (let i = 0; i < line.length; i++) {
        const [lo0, la0] = line[i], [lo1, la1] = line[Math.min(i + 1, line.length - 1)];
        const n_ = i === line.length - 1 ? 1 : Math.max(1, Math.ceil(Math.hypot(lo1 - lo0, la1 - la0) / 0.0004));
        for (let k = 0; k < n_; k++) {
          const lo = lo0 + ((lo1 - lo0) * k) / n_, la = la0 + ((la1 - la0) * k) / n_;
          const [x, z] = frame.xz(lo, la);
          const p = [x, yOf(pre.at(lo, la) + 3), z];
          if (prev) orPts.push(...prev, ...p);
          prev = p;
        }
      }
    }
    const orGeo = new LineSegmentsGeometry(); orGeo.setPositions(orPts);
    const orMat = new LineMaterial({ color: 0x2f6fa8, linewidth: 2.4, transparent: true });
    orMat.resolution.set(innerWidth, innerHeight); oldRiverMats.push(orMat);
    const oldRiver = new LineSegments2(orGeo, orMat);
    if (orPts.length) scene.add(oldRiver);
    return { v, res, u, water, wU, bed, inside, maskGrid, groundNow, edWin, maps, oldLakes, pre, oldRiver };
  });
  // modern ground anywhere: a valley patch where there is one (finer), else the region
  const groundAt = (lon: number, lat: number) => {
    for (const vv of valleys) if (vv.inside(lon, lat)) return vv.groundNow(lon, lat);
    return region.at(lon, lat);
  };

  // ---- rivers (OpenStreetMap), draped just above the ground ----------------------------
  const rivPts: number[] = [];
  const rb = data.region.bounds;
  for (const line of rivers) {
    let prev: number[] | null = null;
    for (const [lo, la] of line) {
      if (lo < rb.west || lo > rb.east || la < rb.south || la > rb.north) { prev = null; continue; }
      const [x, z] = frame.xz(lo, la);
      const p = [x, yOf(groundAt(lo, la) + 6), z];
      if (prev) rivPts.push(...prev, ...p);
      prev = p;
    }
  }
  const rivGeo = new LineSegmentsGeometry(); rivGeo.setPositions(rivPts);
  const rivMat = new LineMaterial({ color: 0x3a6f9e, linewidth: 1.4, transparent: true, opacity: 0.85 });
  rivMat.resolution.set(innerWidth, innerHeight);
  scene.add(new LineSegments2(rivGeo, rivMat));

  // ---- dams ----------------------------------------------------------------------------
  // Each dam is built along its mapped crest line (see dams.ts) down to the ground without it:
  // the pre-dam ground in a valley patch, else the region terrain. It rises during construction.
  const groundPre = (lon: number, lat: number) => {
    for (const vv of valleys) if (vv.inside(lon, lat)) return vv.pre.at(lon, lat);
    return region.at(lon, lat);
  };
  const damMeshes = data.dams.flatMap((d) => {
    if (!d.crests.length && !d.crest_elev_m) return [];   // small unmapped dams
    const m = buildDam(d, frame, groundPre);
    if (!m) return [];
    scene.add(m);
    return [{ d, m }];
  });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(-1, 1.4, -0.6); scene.add(sun);

  // ---- aqueducts and tunnels -----------------------------------------------------------
  // Real routes from OpenStreetMap where mapped (routes.json), else the schematic line.
  // Cut-and-cover aqueducts lie just under the ground, so they are drawn on it; bridges ride
  // above it. Rock tunnels run on a straight grade between their portals, never less than
  // TUNNEL_DEPTH_M under the surface (depths are schematic), with shafts up to each portal.
  // Terrain hides them like anything else, and a fainter dotted "x-ray" copy shows through it.
  const surfaceLines = new THREE.Group(); scene.add(surfaceLines);   // lifted when zoomed out
  const lineMats: LineMaterial[] = [], ghostMats: LineMaterial[] = [];
  const mkMat = (ghost: boolean) => {
    const m = new LineMaterial({ linewidth: ghost ? 2.5 : 3.5, dashed: true, dashSize: 1.2, gapSize: 0.6, transparent: true });
    if (ghost) { m.depthTest = false; m.depthWrite = false; ghostMats.push(m); }
    m.resolution.set(innerWidth, innerHeight); lineMats.push(m); return m;
  };
  function runPoints(r: Run): { pts: number[]; ground: number[]; ll: [number, number][] } {
    const ll: [number, number][] = [];
    for (let i = 0; i < r.coords.length - 1; i++) {
      const [lo0, la0] = r.coords[i], [lo1, la1] = r.coords[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot((lo1 - lo0) * 0.75, la1 - la0) / 0.0027));   // ~300 m
      for (let k = 0; k < n; k++) ll.push([lo0 + ((lo1 - lo0) * k) / n, la0 + ((la1 - la0) * k) / n]);
    }
    ll.push(r.coords[r.coords.length - 1]);
    const ground = ll.map(([lo, la]) => groundAt(lo, la));
    const g0 = ground[0] - TUNNEL_DEPTH_M, g1 = ground[ground.length - 1] - TUNNEL_DEPTH_M;
    const pts: number[] = [];
    ll.forEach(([lo, la], i) => {
      const [x, z] = frame.xz(lo, la);
      const e = r.kind === "tunnel"
        ? Math.min(ground[i] - TUNNEL_DEPTH_M, g0 + ((g1 - g0) * i) / Math.max(1, ll.length - 1))
        : ground[i] + (r.kind === "bridge" ? 40 : 12);
      pts.push(x, yOf(e), z);
    });
    return { pts, ground, ll };
  }
  const lines = data.aqueducts.map((a) => {
    const runs: Run[] = routes.routes[a.id]?.runs
      ?? [{ kind: a.kind === "bridge" ? "bridge" : a.kind === "tunnel" ? "tunnel" : "cutcover", coords: a.coords }];
    const solid = mkMat(false), ghost = mkMat(true);
    const objs: THREE.Object3D[] = [];
    let dist = 0;   // dash distance carried across runs, so the flow reads as one aqueduct
    for (const r of runs) {
      if (r.coords.length < 2) continue;
      const { pts, ground } = runPoints(r);
      const add = (p: number[], mat: LineMaterial, parent: THREE.Object3D, order = 0) => {
        const geo = new LineGeometry(); geo.setPositions(p);
        const l = new Line2(geo, mat); l.computeLineDistances(); l.renderOrder = order;
        const d0 = l.geometry.attributes.instanceDistanceStart.array as Float32Array;
        const d1 = l.geometry.attributes.instanceDistanceEnd.array as Float32Array;
        for (let i = 0; i < d0.length; i++) { d0[i] += dist; d1[i] += dist; }
        parent.add(l); objs.push(l); return d1[d1.length - 1];
      };
      if (r.kind === "tunnel") {
        add(pts, solid, scene); dist = add(pts, ghost, scene, 10);
        for (const [k, gi] of [[0, 0], [pts.length - 3, ground.length - 1]]) {   // shafts to the portals
          const [x, y, z] = pts.slice(k, k + 3), top = yOf(ground[gi] + 15);
          if (top - y > 0.02) { add([x, y, z, x, top, z], solid, scene); add([x, y, z, x, top, z], ghost, scene, 10); }
        }
      } else dist = add(pts, solid, surfaceLines);
    }
    return { a, objs, mats: [solid, ghost] };
  });

  // underground mode: the terrain turns see-through so the tunnels can be followed at depth
  let underground = false;
  const ugBtn = document.getElementById("underground") as HTMLButtonElement;
  function setUnderground(on: boolean) {
    underground = on; ugBtn.classList.toggle("on", on);
    for (const m of [regionMat, ...valleyMats]) {
      m.transparent = on; m.depthWrite = !on; m.uniforms.alpha.value = on ? 0.28 : 1; m.needsUpdate = true;
    }
    setParam("ug", on ? "1" : "0");
  }
  ugBtn.onclick = () => setUnderground(!underground);

  // ---- labels --------------------------------------------------------------------------
  const resLabels = data.reservoirs.map((r) => {
    const div = document.createElement("div");
    div.className = "label"; div.textContent = r.name.replace(" Reservoir", "");
    const o = new CSS2DObject(div);
    const [x, z] = frame.xz(r.lon, r.lat);
    o.position.set(x, yOf(Math.max(r.water_level_m, region.at(r.lon, r.lat))) + 0.4, z);
    scene.add(o);
    return { r, div };
  });

  // ---- views ---------------------------------------------------------------------------
  const at = (lon: number, lat: number) => { const [x, z] = frame.xz(lon, lat); return new THREE.Vector3(x, 0.3, z); };
  const VIEWS: Record<string, { target: THREE.Vector3; offset: THREE.Vector3 }> = {
    region: { target: at(-74.5, 41.5), offset: new THREE.Vector3(-20, 230, 150) },
    ashokan: { target: at(-74.17, 41.955), offset: new THREE.Vector3(-3, 13, 15) },
    croton: { target: at(-73.76, 41.3), offset: new THREE.Vector3(-8, 22, 26) },
    city: { target: at(-73.93, 40.82), offset: new THREE.Vector3(-10, 30, 34) },
    delaware: { target: at(-74.95, 42.02), offset: new THREE.Vector3(-4, 34, 40) },
  };
  // every valley also gets a view of its own (?view=pepacton), framed from its patch
  for (const vv of valleys) {
    if (VIEWS[vv.v.id]) continue;
    const b = box(vv.v.bounds), w = Math.max(b.z - b.x, b.w - b.y);
    VIEWS[vv.v.id] = { target: new THREE.Vector3((b.x + b.z) / 2, 0.3, (b.y + b.w) / 2), offset: new THREE.Vector3(-0.1 * w, 0.75 * w, 0.85 * w) };
  }
  let flight: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t: number } | null = null;
  function go(name: string, instant = false) {
    // "@lon,lat,km": look at any point from about that distance (handy for links and checks)
    const at_ = name.startsWith("@") ? name.slice(1).split(",").map(Number) : null;
    const v = at_ && at_.length === 3 && at_.every(Number.isFinite)
      ? { target: at(at_[0], at_[1]), offset: new THREE.Vector3(-0.25, 0.75, 0.75).multiplyScalar(at_[2]) }
      : VIEWS[name] ?? VIEWS.region;
    const to: [THREE.Vector3, THREE.Vector3] = [v.target.clone(), v.target.clone().add(v.offset)];
    document.querySelectorAll<HTMLButtonElement>("#views button[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    if (instant) { controls.target.copy(to[0]); camera.position.copy(to[1]); controls.update(); return; }
    flight = { from: [controls.target.clone(), camera.position.clone()], to, t: 0 };
    setParam("view", name);
  }
  document.querySelectorAll<HTMLButtonElement>("#views button[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view!)));

  // ---- time UI -------------------------------------------------------------------------
  const slider = document.getElementById("slider") as HTMLInputElement;
  const yearEl = document.getElementById("year")!;
  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const caps = document.getElementById("captions")!;
  const pct = (y: number) => ((y - T0) / (T1 - T0)) * 100;
  document.getElementById("eras")!.innerHTML = ERAS.map((e) =>
    `<span title="${e.name}" style="left:${pct(e.from)}%;width:${pct(e.to) - pct(e.from)}%;background:${SYSTEM_COLORS[e.system]}">${e.name}</span>`).join("");
  document.getElementById("ticks")!.innerHTML = [...new Set(data.events.map((e) => e.year))]
    .map((y) => `<i style="left:${pct(y)}%"></i>`).join("");

  const params = new URLSearchParams(location.search);
  let year = Number(params.get("t")) || T0;
  let playing = false;
  slider.value = String(year);
  slider.oninput = () => { year = Number(slider.value); playing = false; playBtn.textContent = "▶"; setParam("t", String(Math.round(year))); };
  playBtn.onclick = () => {
    if (year >= T1 - 0.01) year = T0;
    playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶";
  };

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(location.search); p.set(k, v);
    history.replaceState(null, "", "?" + p.toString());
  }

  const oldMaps = document.getElementById("oldmaps") as HTMLInputElement;
  let lastCapKey = "";
  function applyYear(t: number) {
    yearEl.textContent = String(Math.floor(t));
    for (const r of data.reservoirs) fillU.value[r.id] = fillFraction(r, t);
    const mapsOn = oldMaps.checked ? 1 : 0;
    // valleys: the dam rises during construction, then the water climbs from the old valley floor.
    // The old maps fade out as the land is cleared, from construction to the start of filling.
    for (const vv of valleys) {
      const f = fillFraction(vv.res, t);
      vv.u.damP.value = damProgress(vv.res, t);
      // the edition in force, and the next one while it fades in
      let a = 0;
      while (a + 1 < vv.edWin.length && t >= vv.edWin[a + 1][1]) a++;
      const nxt = a + 1 < vv.edWin.length && t > vv.edWin[a + 1][0] ? a + 1 : -1;
      const [tA, tB] = [vv.maps.get(a), nxt >= 0 ? vv.maps.get(nxt) : null];
      vv.maps.keep([a, nxt, a + 1]);   // and preload the next
      if (tA) vv.u.topoA.value = tA;
      vv.u.topoB.value = tB ?? blankTex;
      vv.u.topoK.value = tB ? (t - vv.edWin[nxt][0]) / (vv.edWin[nxt][1] - vv.edWin[nxt][0]) : 0;
      vv.u.topoMix.value = mapsOn;
      vv.water.position.y = yOf(vv.bed + (vv.v.water_level_m - vv.bed) * Math.sqrt(f)) + 0.002;
      vv.wU.alpha.value = f > 0 ? 1 : 0;
      for (const ol of vv.oldLakes) ol.u.alpha.value = (ol.res ? fillFraction(ol.res, t) > 0 : f < 0.5) ? 1 : 0;
      vv.oldRiver.visible = f < 0.999;
    }
    for (const { d, m } of damMeshes) {
      const p = damProgressFromYear(d as unknown as Dam, t);
      m.visible = p > 0; m.scale.y = Math.max(0.001, p);
    }
    for (const { a, objs, mats } of lines) {
      const st = lineState(a, t);
      for (const o of objs) o.visible = st !== "hidden";
      for (const mat of mats) {
        const isX = mat !== mats[0];
        if (st === "building") { mat.color.set("#f2b33d"); mat.dashSize = 0.5; mat.gapSize = 0.5; }
        else if (st === "service") { mat.color.set(SYSTEM_COLORS[a.system] ?? "#fff"); mat.dashSize = 1.6; mat.gapSize = 0.35; }
        else if (st === "retired") { mat.color.set("#7d858c"); mat.dashSize = 100; mat.gapSize = 0; }
        mat.opacity = (st === "retired" ? 0.55 : 1) * (isX ? (underground ? 0.9 : 0.6) : 1);
      }
    }
    for (const { r, div } of resLabels) {
      const f2 = fillFraction(r, t), building = damProgress(r, t) > 0 && f2 === 0 && t < (r.in_service ?? 9999);
      div.style.opacity = f2 > 0 || building ? "1" : "0";
      div.classList.toggle("building", building);
    }
    // captions: events from the last 6 years, newest first
    const recent = data.events.filter((e) => e.year <= t && e.year > t - 6).slice(-5).reverse();
    const key = recent.map((e) => e.label).join("|");
    if (key !== lastCapKey) {
      lastCapKey = key;
      caps.innerHTML = recent.map((e) =>
        `<div class="cap ${e.system}${e.approx ? " approx" : ""}"><b>${e.year}</b> ${e.label}</div>`).join("");
    }
    caps.querySelectorAll<HTMLElement>(".cap").forEach((el, i) => {
      el.style.opacity = String(Math.max(0.25, 1 - (t - recent[i].year) / 6));
    });
  }

  // ---- loop ----------------------------------------------------------------------------
  go(params.get("view") ?? "region", true);
  if (params.get("ug") === "1") setUnderground(true);
  const clock = new THREE.Clock();
  document.getElementById("loading")!.style.opacity = "0";
  setTimeout(() => document.getElementById("loading")!.remove(), 600);
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    if (playing) {
      year = Math.min(T1, year + dt * PLAY_YEARS_PER_SEC);
      slider.value = String(year);
      if (year >= T1) { playing = false; playBtn.textContent = "▶"; }
    }
    applyYear(year);
    for (const m of lineMats) m.dashOffset -= dt * 1.2;   // water flowing downstream
    // lines on the ground lift a little more the further away the camera is, so the depth
    // buffer does not lose them in the terrain at whole-region scale; the x-ray dots scale too
    const camD = camera.position.distanceTo(controls.target);
    surfaceLines.position.y = camD * 0.0012;
    for (const m of ghostMats) { if (m.dashSize < 50) { m.dashSize = camD * 0.006; m.gapSize = camD * 0.006; } }
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / 1.6);
      const e = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2;
      controls.target.lerpVectors(flight.from[0], flight.to[0], e);
      camera.position.lerpVectors(flight.from[1], flight.to[1], e);
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
  });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
    for (const m of [...lineMats, rivMat, ...oldRiverMats]) m.resolution.set(innerWidth, innerHeight);
  });
  // for automated screenshots: window.catchment.setYear(1915)
  requestAnimationFrame(() => requestAnimationFrame(() => ((window as any).__ready = true)));
  (window as any).catchment = { mapsPending: () => valleys.reduce((n, vv) => n + vv.maps.pending, 0), setYear: (y: number) => { year = y; slider.value = String(y); }, go, camera, controls, frame };
}

const EXAG_STR = "3.0";
const blankTex: THREE.Texture = new THREE.DataTexture(new Uint8Array(4), 1, 1); blankTex.needsUpdate = true;

/** A valley's map editions, loaded when first wanted; textures not wanted are freed (each is
 *  ~25 MB of GPU memory, and a phone can't hold the dozens of them at once). */
class MapStack {
  private texs: (THREE.Texture | null)[];
  private imgs: (HTMLImageElement | null)[];
  private loading = new Set<number>();
  pending = 0;
  constructor(private urls: string[], private mk: (img: HTMLImageElement) => THREE.Texture) {
    this.texs = urls.map(() => null); this.imgs = urls.map(() => null);
  }
  get(i: number): THREE.Texture | null {
    if (i < 0 || i >= this.urls.length) return null;
    if (this.texs[i]) return this.texs[i];
    if (this.imgs[i]) return (this.texs[i] = this.mk(this.imgs[i]!));
    if (!this.loading.has(i)) {
      this.loading.add(i); this.pending++;
      loadImage(this.urls[i]).then((img) => { this.imgs[i] = img; }).finally(() => { this.pending--; });
    }
    return null;
  }
  keep(want: number[]) {
    for (const i of want) this.get(i);
    this.texs.forEach((t, i) => { if (t && !want.includes(i)) { t.dispose(); this.texs[i] = null; } });
  }
}

function imageRed(img: HTMLImageElement, w: number, h: number): Uint8Array {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}

main().catch((e) => {
  document.getElementById("loading")!.textContent = "Could not load the scene: " + e.message;
  console.error(e);
});
