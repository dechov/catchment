import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Bounds, Frame, HeightGrid, yOf, loadImage } from "./geo";
import { gridGeometry, shadeGLSL } from "./terrain";
import {
  Reservoir, Aqueduct, Dam, Event, fillFraction, damProgress, damProgressFromYear, lineState,
  ERAS, SYSTEM_COLORS,
} from "./timeline";

interface Scene {
  region: { bounds: Bounds; size: [number, number] };
  ashokan: { bounds: Bounds; water_level_m: number; reservoir_id: number };
  reservoirs: Reservoir[]; dams: Dam[]; aqueducts: Aqueduct[]; events: Event[];
}

const D = "./data/";
const T0 = 1830, T1 = 2030;
const PLAY_YEARS_PER_SEC = 4;
const MAX_RES = 32;

async function main() {
  const data: Scene = await (await fetch(D + "scene.json")).json();
  const low = new URLSearchParams(location.search).get("q") === "low" || innerWidth < 700;
  const frame = new Frame(data.region.bounds);
  const [region, ashNow, ashPre, ashMaskImg, ashTopoImg, resIdImg] = await Promise.all([
    HeightGrid.load(D + "region_height.png", data.region.bounds),
    HeightGrid.load(D + "ashokan_now.png", data.ashokan.bounds),
    HeightGrid.load(D + "ashokan_pre.png", data.ashokan.bounds),
    loadImage(D + "ashokan_mask.png"),
    loadImage(D + "ashokan_topo.jpg"),
    loadImage(D + "region_reservoirs.png"),
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
  const ab = data.ashokan.bounds;
  const [ax0, az0] = frame.xz(ab.west, ab.north), [ax1, az1] = frame.xz(ab.east, ab.south);
  const fillU = { value: new Float32Array(MAX_RES) };
  const regionMat = new THREE.ShaderMaterial({
    uniforms: {
      resId: { value: tex(resIdImg, true) }, fill: fillU,
      cutout: { value: new THREE.Vector4(ax0, az0, ax1, az1) },
      fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      void main() {
        vN = normal; vUv = uv; vE = position.y * 1000.0 / ${EXAG_STR}; vW = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D resId; uniform float fill[${MAX_RES}]; uniform vec4 cutout;
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      ${shadeGLSL}
      void main() {
        if (vW.x > cutout.x && vW.x < cutout.z && vW.z > cutout.y && vW.z < cutout.w) discard;
        vec3 c = landColor(vE);
        if (vE < 0.25) c = WATER * 0.85;               // sea, harbour, tidal Hudson
        int id = int(texture2D(resId, vUv).r * 255.0 + 0.5);
        if (id > 0) {
          float f = fill[id];
          c = mix(c * vec3(0.92, 0.9, 0.8), WATER, f);  // valley floor tint until it floods
        }
        c = light(c, vN);
        float fog = smoothstep(fogNear, fogFar, vDepth);
        gl_FragColor = vec4(mix(c, fogColor, fog), 1.0);
      }`,
  });
  const regionMesh = new THREE.Mesh(gridGeometry(region, frame, low ? 4 : 2), regionMat);
  scene.add(regionMesh);

  // ---- Ashokan detail: the reconstructed valley, with the dam rising and water filling --
  const level = data.ashokan.water_level_m;
  const maskData = imageRed(ashMaskImg, ashNow.w, ashNow.h);
  const ashGeo = gridGeometry(ashPre, frame, low ? 3 : 1, {
    damH: (i) => (maskData[i] > 127 && ashNow.data[i] > level + 1 ? ashNow.data[i] - ashPre.data[i] : 0),
  });
  const ashU = {
    topo: { value: tex(ashTopoImg) }, topoMix: { value: 1 }, damP: { value: 0 },
    fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
  };
  const ashMat = new THREE.ShaderMaterial({
    uniforms: ashU,
    vertexShader: /* glsl */ `
      attribute float damH; uniform float damP;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth;
      void main() {
        vec3 p = position; p.y += damH * damP * ${EXAG_STR} / 1000.0;
        vN = normal; vUv = uv; vE = p.y * 1000.0 / ${EXAG_STR};
        vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D topo; uniform float topoMix;
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth;
      ${shadeGLSL}
      void main() {
        vec3 base = landColor(vE);
        vec3 map = texture2D(topo, vUv).rgb;
        float has = step(0.02, map.r + map.g + map.b);   // the old sheets stop at 42°N
        vec3 c = mix(base, map * 1.05, topoMix * has * 0.85);
        c = light(c, vN);
        float fog = smoothstep(fogNear, fogFar, vDepth);
        gl_FragColor = vec4(mix(c, fogColor, fog), 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(ashGeo, ashMat));

  const waterGeo = new THREE.PlaneGeometry(ax1 - ax0, az1 - az0);
  waterGeo.rotateX(-Math.PI / 2);
  const ashWaterU = { mask: { value: tex(ashMaskImg) }, alpha: { value: 0 } };
  const ashWater = new THREE.Mesh(waterGeo, new THREE.ShaderMaterial({
    uniforms: ashWaterU, transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D mask; uniform float alpha; varying vec2 vUv;
      void main(){ if (texture2D(mask, vUv).r < 0.5) discard;
        gl_FragColor = vec4(0.16, 0.38, 0.58, 0.88 * alpha); }`,
  }));
  ashWater.position.set((ax0 + ax1) / 2, 0, (az0 + az1) / 2);
  scene.add(ashWater);
  const ashRes = data.reservoirs.find((r) => r.id === data.ashokan.reservoir_id)!;
  const bedM = Math.min(...Array.from(ashPre.data).filter((_, i) => maskData[i] > 127));

  // ---- dams ----------------------------------------------------------------------------
  const inAshokan = (lon: number, lat: number) => lon > ab.west && lon < ab.east && lat > ab.south && lat < ab.north;
  // the Ashokan patch raises its own dam from the terrain, so it gets no marker
  const damMeshes = data.dams.filter((d) => !inAshokan(d.lon, d.lat)).map((d) => {
    const h = ((d.height_ft ?? 50) * 0.3048 * 3) / 1000 + 0.05;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.25, ((d.length_ft ?? 600) * 0.3048) / 1000), h, 0.12),
      new THREE.MeshLambertMaterial({ color: 0xe9e4da }),
    );
    const [x, z] = frame.xz(d.lon, d.lat);
    m.geometry.translate(0, h / 2, 0);
    m.position.set(x, yOf(region.at(d.lon, d.lat)) - 0.02, z);
    scene.add(m);
    return { d, m };
  });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(-1, 1.4, -0.6); scene.add(sun);

  // ---- aqueducts and tunnels -----------------------------------------------------------
  const lineMats: LineMaterial[] = [];
  const lines = data.aqueducts.map((a) => {
    const pts: number[] = [];
    for (let i = 0; i < a.coords.length - 1; i++) {
      const [lo0, la0] = a.coords[i], [lo1, la1] = a.coords[i + 1];
      const n = Math.max(2, Math.ceil(Math.hypot(lo1 - lo0, la1 - la0) / 0.004));
      for (let k = 0; k < n; k++) {
        const lo = lo0 + ((lo1 - lo0) * k) / n, la = la0 + ((la1 - la0) * k) / n;
        const [x, z] = frame.xz(lo, la);
        pts.push(x, yOf(region.at(lo, la) + 150), z);
      }
    }
    const [lo, la] = a.coords[a.coords.length - 1];
    const [x, z] = frame.xz(lo, la); pts.push(x, yOf(region.at(lo, la) + 150), z);
    const geo = new LineGeometry(); geo.setPositions(pts);
    const mat = new LineMaterial({ color: SYSTEM_COLORS[a.system] ?? "#fff", linewidth: 3.5, dashed: true,
      dashSize: 1.2, gapSize: 0.6, transparent: true });
    mat.resolution.set(innerWidth, innerHeight);
    lineMats.push(mat);
    const line = new Line2(geo, mat); line.computeLineDistances();
    scene.add(line);
    return { a, line, mat };
  });

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
  };
  let flight: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t: number } | null = null;
  function go(name: string, instant = false) {
    const v = VIEWS[name] ?? VIEWS.region;
    const to: [THREE.Vector3, THREE.Vector3] = [v.target.clone(), v.target.clone().add(v.offset)];
    document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    if (instant) { controls.target.copy(to[0]); camera.position.copy(to[1]); controls.update(); return; }
    flight = { from: [controls.target.clone(), camera.position.clone()], to, t: 0 };
    setParam("view", name);
  }
  document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => (b.onclick = () => go(b.dataset.view!)));

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
    // Ashokan: the dam rises during construction, then the water climbs from the old creek bed
    const f = fillFraction(ashRes, t);
    ashU.damP.value = damProgress(ashRes, t);
    ashU.topoMix.value = 1 - Math.min(1, Math.max(0, (t - 1908) / 6));
    ashWater.position.y = yOf(bedM + (level - bedM) * Math.sqrt(f)) + 0.002;
    ashWaterU.alpha.value = f > 0 ? 1 : 0;
    for (const { d, m } of damMeshes) {
      const p = damProgressFromYear(d, t);
      m.visible = p > 0; m.scale.y = Math.max(0.001, p);
    }
    for (const { a, line, mat } of lines) {
      const s = lineState(a, t);
      line.visible = s !== "hidden";
      if (s === "building") { mat.color.set("#f2b33d"); mat.dashSize = 0.5; mat.gapSize = 0.5; mat.opacity = 1; }
      else if (s === "service") { mat.color.set(SYSTEM_COLORS[a.system] ?? "#fff"); mat.dashSize = 1.6; mat.gapSize = 0.35; mat.opacity = 1; }
      else if (s === "retired") { mat.color.set("#7d858c"); mat.dashSize = 100; mat.gapSize = 0; mat.opacity = 0.55; }
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
    for (const { mat } of lines) mat.dashOffset -= dt * 1.2;   // water flowing downstream
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
    for (const m of lineMats) m.resolution.set(innerWidth, innerHeight);
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
