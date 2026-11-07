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
import {
  Reservoir, Aqueduct, Dam, Event, fillFraction, damProgress, damProgressFromYear, lineState,
  ERAS, SYSTEM_COLORS,
} from "./timeline";

interface Valley {
  id: string; bounds: Bounds; water_level_m: number; reservoir_id: number;
  maps: { title: string; year: number }[]; synthetic: boolean;
}
interface Scene {
  region: { bounds: Bounds; size: [number, number] };
  valleys: Valley[];
  reservoirs: Reservoir[]; dams: Dam[]; aqueducts: Aqueduct[]; events: Event[];
}

const D = "./data/";
const T0 = 1830, T1 = 2030;
const PLAY_YEARS_PER_SEC = 4;
const MAX_RES = 32;
const MAX_CUT = 8;
const LAKE_ID = 255;   // natural water in region_reservoirs.png

async function main() {
  const data: Scene = await (await fetch(D + "scene.json")).json();
  const q = new URLSearchParams(location.search).get("q");
  const low = q === "low" || innerWidth < 700;
  const frame = new Frame(data.region.bounds);
  const loadingEl = document.getElementById("loading")!;
  let nLoaded = 0;
  const nFiles = 3 + data.valleys.length * 4;
  const count = <T,>(p: Promise<T>) => p.then((v) => { loadingEl.textContent = `Loading terrain… ${++nLoaded}/${nFiles}`; return v; });
  const [region, resIdImg, rivers, valleyFiles] = await Promise.all([
    count(HeightGrid.load(D + "region_height.png", data.region.bounds)),
    count(loadImage(D + "region_reservoirs.png")),
    count(fetch(D + "rivers.json").then((r) => r.json() as Promise<[number, number][][]>)),
    Promise.all(data.valleys.map((v) => Promise.all([
      count(HeightGrid.load(D + `${v.id}_pre.png`, v.bounds)),
      count(loadImage(D + `${v.id}_mask.png`)),
      count(loadImage(D + `${v.id}_dam.png`)),
      count(loadImage(D + `${v.id}_topo.jpg`)),
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
  const resIdTex = tex(resIdImg, true);
  // reservoir ids and natural lakes, looked up by scene position (shared by region and valleys)
  const waterGLSL = /* glsl */ `
    uniform sampler2D resId; uniform float fill[${MAX_RES}]; uniform vec4 regionBox;
    int waterId(vec3 w) {
      vec2 uv = vec2((w.x - regionBox.x) / (regionBox.z - regionBox.x), 1.0 - (w.z - regionBox.y) / (regionBox.w - regionBox.y));
      return int(texture2D(resId, uv).r * 255.0 + 0.5);
    }
    vec3 applyWater(vec3 c, int id) {
      if (id == ${LAKE_ID}) return WATER;                          // natural lakes and ponds
      if (id > 0 && id < ${MAX_RES}) {
        float f = 0.0;
        for (int k = 0; k < ${MAX_RES}; k++) if (k == id) f = fill[k];
        return mix(c * vec3(0.92, 0.9, 0.8), WATER, f);          // valley floor tint until it floods
      }
      return c;
    }`;
  const regionMat = new THREE.ShaderMaterial({
    uniforms: {
      resId: { value: resIdTex }, fill: fillU, regionBox: { value: regionBox },
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
        vec3 c = landColor(vE);
        if (vE < 0.25) c = WATER * 0.85;               // sea, harbour, tidal Hudson
        c = applyWater(c, waterId(vW));
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
  const valleys = data.valleys.map((v, n) => {
    const [pre, maskImg, damImg, topoImg] = valleyFiles[n];
    const maskData = imageRed(maskImg, pre.w, pre.h);
    const damData = imageRed(damImg, pre.w, pre.h);
    const step = q === "high" ? 1 : low ? 4 : 2;
    const geo = gridGeometry(pre, frame, step, { damH: (i) => damData[i], inRes: (i) => maskData[i] / 255 });
    const u = {
      topo: { value: tex(topoImg) }, topoMix: { value: 1 }, damP: { value: 0 }, alpha: { value: 1 },
      resId: { value: resIdTex }, fill: fillU, regionBox: { value: regionBox }, ownId: { value: v.reservoir_id },
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
        uniform sampler2D topo; uniform float topoMix; uniform int ownId;
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float alpha;
        varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth; varying vec3 vW; varying float vIn;
        ${shadeGLSL}
        ${waterGLSL}
        void main() {
          vec3 c = landColor(vE);
          if (vE < 0.25) c = WATER * 0.85;
          // other water around the valley: lakes, and older or neighbouring reservoirs. Inside this
          // reservoir's own footprint the ground is pre-dam, so only older reservoirs show there.
          int id = waterId(vW);
          if (id != ownId && !(vIn > 0.5 && id == ${LAKE_ID})) c = applyWater(c, id);
          vec3 map = texture2D(topo, vUv).rgb;
          float has = step(0.02, map.r + map.g + map.b);   // outside the sheets' neatlines
          c = mix(c, map * 1.05, topoMix * has * 0.85);
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
    const wU = { mask: { value: tex(maskImg) }, alpha: { value: 0 } };
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
    const res = data.reservoirs.find((r) => r.id === v.reservoir_id)!;
    let bed = Infinity;
    for (let i = 0; i < maskData.length; i++) if (maskData[i] > 127 && pre.data[i] < bed) bed = pre.data[i];
    const inside = (lon: number, lat: number) => lon > v.bounds.west && lon < v.bounds.east && lat > v.bounds.south && lat < v.bounds.north;
    const maskGrid = new HeightGrid(pre.w, pre.h, Float32Array.from(maskData), v.bounds);
    const damGrid = new HeightGrid(pre.w, pre.h, Float32Array.from(damData), v.bounds);
    // ground today: the water surface over the reservoir, the dam, and the old ground elsewhere
    const groundNow = (lon: number, lat: number) => {
      const g = pre.at(lon, lat) + damGrid.at(lon, lat);
      return maskGrid.at(lon, lat) > 127 ? Math.max(v.water_level_m, g) : g;
    };
    return { v, res, u, water, wU, bed, inside, maskGrid, groundNow,
             mapYear: Math.max(...v.maps.map((m) => m.year)) };
  });
  // modern ground anywhere: a valley patch where there is one (finer), else the region
  const groundAt = (lon: number, lat: number) => {
    for (const vv of valleys) if (vv.inside(lon, lat)) return vv.groundNow(lon, lat);
    return region.at(lon, lat);
  };

  // ---- rivers (OpenStreetMap), draped just above the ground ----------------------------
  const rivPts: number[] = [];
  for (const line of rivers) {
    let prev: number[] | null = null;
    for (const [lo, la] of line) {
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
  // a valley patch raises its own dam out of the terrain, so dams inside a patch's reservoir
  // footprint get no marker
  const raised = (lon: number, lat: number) => valleys.some((vv) => vv.inside(lon, lat) && vv.maskGrid.at(lon, lat) > 127);
  const damMeshes = data.dams.filter((d) => !raised(d.lon, d.lat)).map((d) => {
    const h = ((d.height_ft ?? 50) * 0.3048 * 3) / 1000 + 0.05;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.25, ((d.length_ft ?? 600) * 0.3048) / 1000), h, 0.12),
      new THREE.MeshLambertMaterial({ color: 0xe9e4da }),
    );
    const [x, z] = frame.xz(d.lon, d.lat);
    m.geometry.translate(0, h / 2, 0);
    m.position.set(x, yOf(groundAt(d.lon, d.lat)) - 0.02, z);
    scene.add(m);
    return { d, m };
  });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(-1, 1.4, -0.6); scene.add(sun);

  // ---- aqueducts and tunnels -----------------------------------------------------------
  // Deep pressure tunnels run well below ground: drawn on a straight grade between their ends,
  // never less than TUNNEL_COVER_M under the surface (depths are schematic). Grade aqueducts
  // (cut-and-cover, masonry) hug the ground; bridges ride above it. Tunnels also get a faint
  // x-ray copy drawn on top of everything, so they read through the terrain.
  const TUNNEL_COVER_M = 100;
  const lineMats: LineMaterial[] = [];
  const lines = data.aqueducts.map((a) => {
    const tunnel = a.kind === "tunnel";
    const shaftPts: number[] = [];
      const parts: { line: Line2; mat: LineMaterial; xray: boolean }[] = [];
    for (const chain of a.chains) {
      if (chain.length < 2) continue;
      const ll: [number, number][] = [];
      for (let i = 0; i < chain.length - 1; i++) {
        const [lo0, la0] = chain[i], [lo1, la1] = chain[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(lo1 - lo0, la1 - la0) / 0.003));
        for (let k = 0; k < n; k++) ll.push([lo0 + ((lo1 - lo0) * k) / n, la0 + ((la1 - la0) * k) / n]);
      }
      ll.push(chain[chain.length - 1]);
      const ground = ll.map(([lo, la]) => groundAt(lo, la));
      const g0 = ground[0] - TUNNEL_COVER_M, g1 = ground[ground.length - 1] - TUNNEL_COVER_M;
      const elev = ground.map((g, i) => tunnel
        ? Math.min(g - TUNNEL_COVER_M, g0 + ((g1 - g0) * i) / (ground.length - 1))
        : a.kind === "bridge" ? g + 45 : g + 12);
      const pts: number[] = [];
      ll.forEach(([lo, la], i) => { const [x, z] = frame.xz(lo, la); pts.push(x, yOf(elev[i]), z); });
      if (tunnel) for (const i of [0, ll.length - 1]) {   // shafts/portals at each end
        const [x, z] = frame.xz(ll[i][0], ll[i][1]);
        shaftPts.push(x, yOf(elev[i]), z, x, yOf(ground[i] + 20), z);
      }
      for (const xray of tunnel ? [false, true] : [false]) {
        const geo = new LineGeometry(); geo.setPositions(pts);
        const mat = new LineMaterial({ color: SYSTEM_COLORS[a.system] ?? "#fff", linewidth: xray ? 2.5 : 3.5,
          dashed: true, dashSize: 1.2, gapSize: 0.6, transparent: true, depthTest: !xray, depthWrite: !xray });
        mat.resolution.set(innerWidth, innerHeight);
        lineMats.push(mat);
        const line = new Line2(geo, mat); line.computeLineDistances();
        if (xray) line.renderOrder = 10;
        scene.add(line);
        parts.push({ line, mat, xray });
      }
    }
    const shafts = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(shaftPts, 3)),
      new THREE.LineBasicMaterial({ color: 0x30353a, transparent: true, opacity: 0.8 }));
    scene.add(shafts);
    return { a, parts, shafts };
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
    const v = VIEWS[name] ?? VIEWS.region;
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

  let lastCapKey = "";
  function applyYear(t: number) {
    yearEl.textContent = String(Math.floor(t));
    for (const r of data.reservoirs) fillU.value[r.id] = fillFraction(r, t);
    // valleys: the dam rises during construction, then the water climbs from the old valley floor.
    // The old maps fade out as the land is cleared, from construction to the start of filling.
    for (const vv of valleys) {
      const f = fillFraction(vv.res, t);
      vv.u.damP.value = damProgress(vv.res, t);
      const fs = vv.res.fill_start ?? (vv.res.in_service ?? 9999) - 1;
      const fadeFrom = Math.max(vv.mapYear, fs - 6);
      vv.u.topoMix.value = 1 - Math.min(1, Math.max(0, (t - fadeFrom) / Math.max(1, fs - fadeFrom)));
      vv.water.position.y = yOf(vv.bed + (vv.v.water_level_m - vv.bed) * Math.sqrt(f)) + 0.002;
      vv.wU.alpha.value = f > 0 ? 1 : 0;
    }
    for (const { d, m } of damMeshes) {
      const p = damProgressFromYear(d, t);
      m.visible = p > 0; m.scale.y = Math.max(0.001, p);
    }
    for (const { a, parts, shafts } of lines) {
      const st = lineState(a, t);
      shafts.visible = st !== "hidden";
      for (const { line, mat, xray: isX } of parts) {
        line.visible = st !== "hidden";
        if (st === "building") { mat.color.set("#f2b33d"); mat.dashSize = 0.5; mat.gapSize = 0.5; }
        else if (st === "service") { mat.color.set(SYSTEM_COLORS[a.system] ?? "#fff"); mat.dashSize = 1.6; mat.gapSize = 0.35; }
        else if (st === "retired") { mat.color.set("#7d858c"); mat.dashSize = 100; mat.gapSize = 0; }
        mat.opacity = (st === "retired" ? 0.55 : 1) * (isX ? (underground ? 0.9 : 0.5) : 1);
      }
    }
    for (const { r, div } of resLabels) {
      const f2 = fillFraction(r, t), building = damProgress(r, t) > 0 && f2 === 0;
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
    for (const m of [...lineMats, rivMat]) m.resolution.set(innerWidth, innerHeight);
  });
  // for automated screenshots: window.catchment.setYear(1915)
  requestAnimationFrame(() => requestAnimationFrame(() => ((window as any).__ready = true)));
  (window as any).catchment = { setYear: (y: number) => { year = y; slider.value = String(y); }, go };
}

const EXAG_STR = "3.0";

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
