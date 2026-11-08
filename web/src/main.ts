import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Bounds, Frame, HeightGrid, yOf, loadImage, mx, my } from "./geo";
import { gridGeometry, shadeGLSL } from "./terrain";
import { buildDam, DamData } from "./dams";
import { TileTerrain } from "./tiles";
import { buildDemand, storage, waterUse } from "./demand";
import { Catchments, catchGLSL, CatchInfo } from "./catchments";
import { FlowParticles, buildPeaks, waterTableGrid } from "./flowfx";
import { EPISODES, demandChart } from "./episodes";
import { DISPLACED } from "./displaced";
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
  const nFiles = 7 + data.valleys.length * 5;
  const count = <T,>(p: Promise<T>) => p.then((v) => { loadingEl.textContent = `Loading terrain… ${++nLoaded}/${nFiles}`; return v; });
  const [region, resIdImg, waterImg, routes, rivers, valleyFiles, flowImg, catchInfo] = await Promise.all([
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
    count(loadImage(D + "flow.png")),
    count(fetch(D + "catchments.json").then((r) => r.json() as Promise<CatchInfo>)),
  ]);

  // ---- renderer, camera, controls ------------------------------------------------------
  const app = document.getElementById("app")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(low ? 1.5 : 2, window.devicePixelRatio));
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
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 3000);
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
  // the holes the tiles leave for the valley patches stop short of each patch's edge by its rim
  // band (rimKm): there both are drawn, the patch sunk a little, so whichever surface is higher
  // shows and no gap opens along the seam when the tiles nearby are coarser than the patch
  const rimKm = (b: THREE.Vector4) => Math.min(b.z - b.x, b.w - b.y) * 0.02;
  const cutouts = data.valleys.slice(0, MAX_CUT).map((v) => {
    const b = box(v.bounds), m = rimKm(b);
    return new THREE.Vector4(b.x + m, b.y + m, b.z - m, b.w - m);
  });
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
    bool inRegion(vec3 w) { vec2 u = regionUv(w); return u.x > 0.0 && u.x < 1.0 && u.y > 0.0 && u.y < 1.0; }
    int waterId(vec3 w) { return inRegion(w) ? int(texture2D(resId, regionUv(w)).r * 255.0 + 0.5) : 0; }
    vec3 applyLakes(vec3 c, vec3 w) {
      // beyond the region's water maps, only the sea (ground at sea level) is known
      if (!inRegion(w)) return w.y < 0.001 ? WATER * 0.85 : c;
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
  const sysOfId = (id: number) => new THREE.Color(SYSTEM_COLORS[data.reservoirs.find((r) => r.id === id)?.system ?? ""] ?? "#888");
  const catchments = new Catchments(flowImg, catchInfo, data.region.bounds, sysOfId);
  // the reservoir (if any) at a point, from the region's id image
  const resIdAt = (() => {
    const c = document.createElement("canvas"); c.width = resIdImg.width; c.height = resIdImg.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(resIdImg, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data, b = data.region.bounds;
    return (lon: number, lat: number) => {
      const u = (mx(lon) - mx(b.west)) / (mx(b.east) - mx(b.west)), v = (my(b.north) - my(lat)) / (my(b.north) - my(b.south));
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
      return px[(Math.floor(v * c.height) * c.width + Math.floor(u * c.width)) * 4];
    };
  })();
  const regionMat = new THREE.ShaderMaterial({
    // both sides: a tile's skirt must hide a crack whichever side of the seam it is seen from
    side: THREE.DoubleSide,
    uniforms: {
      ...catchments.uniforms,
      resId: { value: resIdTex }, resCov: { value: resCovTex }, lakes: { value: lakeTex }, fill: fillU, regionBox: { value: regionBox },
      cutouts: { value: cutouts },
      photo: { value: blankTex as THREE.Texture }, photoOn: { value: 0 }, morph: { value: new THREE.Vector2(0, 0) },
      tileN: { value: blankTex as THREE.Texture }, tileNOn: { value: 0 },
      fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
      alpha: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float coarseY; uniform vec2 morph;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      void main() {
        // streamed tiles ease toward their parent's coarser shape with distance (tiles.ts)
        float m = morph.y > 0.0 ? smoothstep(morph.x, morph.y, distance(position, cameraPosition)) : 0.0;
        vec3 p = position; p.y = mix(position.y, coarseY, m);
        vN = normal; vUv = uv; vE = p.y * 1000.0 / ${EXAG_STR}; vW = p;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 cutouts[${MAX_CUT}]; uniform sampler2D photo; uniform float photoOn; uniform sampler2D tileN; uniform float tileNOn;
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float alpha;
      varying vec3 vN; varying vec2 vUv; varying float vE; varying vec3 vW; varying float vDepth;
      ${shadeGLSL}
      ${waterGLSL}
      ${catchGLSL()}
      void main() {
        for (int k = 0; k < ${MAX_CUT}; k++) {
          vec4 b = cutouts[k];
          if (vW.x > b.x && vW.x < b.z && vW.z > b.y && vW.z < b.w) discard;
        }
        vec3 c = applyLakes(landColor(vE), vW);
        if (photoOn > 0.5) c = texture2D(photo, vUv).rgb * 1.1;   // today's aerial photograph
        c = applyCatch(c, vW);
        c = applyWater(c, waterId(vW), vW);
        c = light(c, tileNOn > 0.5 ? texture2D(tileN, vUv).xyz * 2.0 - 1.0 : vN);
        float fog = smoothstep(fogNear, fogFar, vDepth);
        gl_FragColor = vec4(mix(c, fogColor, fog), alpha);
      }`,
  });
  // the ground outside the valley patches: streamed tiles out to the horizon (?tiles=0: the
  // region's own heightmap only, as before, e.g. offline)
  const useTiles = new URLSearchParams(location.search).get("tiles") !== "0";
  const centre = { lon: (data.region.bounds.west + data.region.bounds.east) / 2, lat: (data.region.bounds.south + data.region.bounds.north) / 2 };
  const tiles = useTiles ? new TileTerrain(frame, regionMat, centre.lon, centre.lat,
    { rootZ: 5, rootSpan: 1, maxZ: low ? 14 : 15, segs: 32, detail: low ? 2 : 3, maxInflight: 8 }) : null;
  if (tiles) scene.add(tiles.group);
  else scene.add(new THREE.Mesh(gridGeometry(region, frame, low ? 4 : 2), regionMat));

  // ---- valley details: the pre-reservoir ground, the dam rising and the water filling ----
  // Each valley is a finer (~7-14 m) patch cut into the region. It shows the ground as it was
  // before the reservoir, draped with the USGS sheets of the time; the dam grows out of it and
  // a water plane climbs from the old valley floor to today's level.
  const valleyMats: THREE.ShaderMaterial[] = [];
  const valleyMeshes: THREE.Mesh[] = [];
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
      // among the streamed tiles (the same zoom-14 source) the patch's own rim already meets
      // them, so it just hangs a skirt; over the coarse region heightmap it blends into it
      useTiles ? undefined : { at: (lo, la) => region.at(lo, la), px: Math.round(pre.w / 40) }, useTiles ? 0.06 : 0,
      useTiles ? { px: Math.round(Math.min(pre.w, pre.h) * 0.02), m: 8 } : undefined);
    // the patch's ground shading at every scale: its normals in a mipmapped texture, so from
    // farther away the shading can step down to the detail the tiles around it have and the
    // patch doesn't stand out as a sharper rectangle
    const pb = box(v.bounds);
    const nTex = normalTexture(pre, (pb.z - pb.x) / pre.w, (pb.w - pb.y) / pre.h);
    const u = {
      normTex: { value: nTex }, texelKm: { value: (pb.z - pb.x) / pre.w },
      topoA: { value: blankTex as THREE.Texture }, topoB: { value: blankTex as THREE.Texture }, topoK: { value: 0 }, topoMix: { value: 1 }, postA: { value: 0 }, postB: { value: 0 }, damP: { value: 0 }, alpha: { value: 1 },
      resId: { value: resIdTex }, resCov: { value: resCovTex }, lakes: { value: lakeTex }, fill: fillU, regionBox: { value: regionBox }, ownId: { value: v.reservoir_id }, detail: { value: tex(lakesImg) },
      fogColor: { value: new THREE.Color(0xb9c8d4) }, fogNear: { value: 250 }, fogFar: { value: 650 },
      ...catchments.uniforms,
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
        uniform sampler2D topoA; uniform sampler2D topoB; uniform float topoK; uniform float topoMix; uniform float postA; uniform float postB; uniform int ownId; uniform sampler2D detail;
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float alpha;
        uniform sampler2D normTex; uniform float texelKm;
        varying vec3 vN; varying vec2 vUv; varying float vE; varying float vDepth; varying vec3 vW; varying float vIn;
        ${shadeGLSL}
        ${waterGLSL}
        ${catchGLSL()}
        void main() {
          vec3 c = landColor(vE);
          // the reservoir's own bed, bare mud and stumps where a drought has drawn it down
          c = mix(c, vec3(0.50, 0.45, 0.36), step(0.5, vIn) * max(postA, postB));
          // other water around the valley: lakes, and older or neighbouring reservoirs. Inside this
          // reservoir's own footprint the ground is pre-dam, so no lakes are drawn there.
          // lakes and sea from the patch's own, finer water map
          if (vIn < 0.5) {
            vec3 l = texture2D(detail, vUv).rgb;
            c = mix(c, LAKE, smoothstep(0.3, 0.6, l.r));
            c = mix(c, WATER * 0.85, smoothstep(0.35, 0.65, l.b));
          }
          // two map editions, crossfading from A to B. Each map's alpha (softMapEdges) fades it
          // out along a soft, wandering line inside its sheets and the patch, so no neatline or
          // patch border shows as a straight edge.
          vec4 tA = texture2D(topoA, vUv), tB = texture2D(topoB, vUv);
          // a map printed after the reservoir shows it as water: inside the footprint, where the
          // old ground is only seen when a drought draws the water down, it isn't draped
          float inRes = smoothstep(0.3, 0.7, vIn);
          float wA = tA.a * (1.0 - postA * inRes) * (1.0 - topoK), wB = tB.a * (1.0 - postB * inRes) * topoK;
          float has = wA + wB;
          vec3 map = (tA.rgb * wA + tB.rgb * wB) / max(has, 1e-4);
          // later editions print woods bright green and towns red: tone them toward the old sheets
          map = mix(vec3(dot(map, vec3(0.3, 0.59, 0.11))), map, 0.7);
          c = mix(c, map * 1.05, topoMix * min(has, 1.0) * 0.85);
          // other reservoirs in the patch (older or neighbouring ones, the city's), drawn over the
          // map while they hold water, so a map printed after one was removed can't hide it
          int id = waterId(vW);
          // (this valley's own reservoir too, outside the rebuilt footprint: the patch's border band)
          if ((id != ownId || vIn < 0.5) && id > 0 && id < ${MAX_RES}) {
            float f = 0.0;
            for (int k = 0; k < ${MAX_RES}; k++) if (k == id) f = fill[k];
            c = mix(c, WATER, f * smoothstep(0.35, 0.65, texture2D(resCov, regionUv(vW)).g));
          }
          if (vIn < 0.5) c = applyCatch(c, vW);
          // the tiles around shade with detail of about depth/${TILE_SPACING_DIV} km; shade with the
          // patch's normals averaged to about that spacing
          float lod = log2(max(1.0, vDepth / ${TILE_SPACING_DIV} / texelKm));
          vec3 nFar = textureLod(normTex, vUv, lod).xyz * 2.0 - 1.0;
          c = light(c, normalize(mix(vN, nFar, smoothstep(0.5, 2.0, lod))));
          float fog = smoothstep(fogNear, fogFar, vDepth);
          gl_FragColor = vec4(mix(c, fogColor, fog), alpha);
        }`,
    });
    valleyMats.push(mat);
    const vMesh = new THREE.Mesh(geo, mat);
    valleyMeshes.push(vMesh);
    scene.add(vMesh);

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
    const maps = new MapStack(v.editions.map((e) => D + e.file), softMapEdges);
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
  // the city's daily use against what the system can deliver, on the old distributing reservoir's block
  const demand = buildDemand(frame, (lo, la) => region.at(lo, la));
  scene.add(demand.group);
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
    waterTable.visible = on;
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
    // the communities it took, under its name, when close enough to read
    const dp = DISPLACED[r.name];
    const sub = dp ? document.createElement("div") : null;
    if (sub && dp) { sub.className = "displaced"; div.appendChild(sub); }
    const o = new CSS2DObject(div);
    const [x, z] = frame.xz(r.lon, r.lat);
    o.position.set(x, yOf(Math.max(r.water_level_m, region.at(r.lon, r.lat))) + 0.4, z);
    scene.add(o);
    return { r, div, sub, dp };
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
    // a portrait screen is narrow: stand back so the same ground fits across it
    const fit = camera.aspect < 1.3 ? Math.pow(1.3 / camera.aspect, 0.5) : 1;
    const to: [THREE.Vector3, THREE.Vector3] = [v.target.clone(), v.target.clone().add(v.offset.clone().multiplyScalar(fit))];
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
  slider.oninput = () => { year = Number(slider.value); playing = false; playTo = null; playBtn.textContent = "▶"; setParam("t", String(Math.round(year))); };
  playBtn.onclick = () => {
    if (year >= T1 - 0.01) year = T0;
    playTo = null; playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶";
  };

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(location.search); p.set(k, v);
    history.replaceState(null, "", "?" + p.toString());
  }

  const oldMaps = document.getElementById("oldmaps") as HTMLInputElement;
  const catchOn = document.getElementById("catchOn") as HTMLInputElement;
  catchOn.addEventListener("change", () => { catchments.uniforms.catchOn.value = catchOn.checked ? 1 : 0; });
  const photosOn = document.getElementById("photosOn") as HTMLInputElement;
  if (!tiles) photosOn.parentElement!.style.display = "none";
  photosOn.addEventListener("change", () => tiles?.setPhotos(photosOn.checked));
  // drops running down the streams, and the named peaks
  const resById = new Map(data.reservoirs.map((r) => [r.id, r]));
  const drops = new FlowParticles(catchments.W, catchments.H, catchments.dir, catchments.acc, catchments.first, region,
    data.region.bounds, frame, (id) => { const r = resById.get(id); return r ? new THREE.Color(SYSTEM_COLORS[r.system] ?? "#cfe") : null; },
    low ? 1500 : 4000);
  scene.add(drops.points);
  const peaks = buildPeaks(region, frame);
  scene.add(peaks.group);
  // the water table, seen in the underground view; it sinks in a drought
  const waterTable = new THREE.Mesh(gridGeometry(waterTableGrid(region, low ? 8 : 4), frame, 1),
    new THREE.MeshLambertMaterial({ color: 0x3a8fd8, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
  waterTable.visible = false; waterTable.renderOrder = 1;
  scene.add(waterTable);
  // tap (not drag) the ground: trace everything upstream of that point
  scene.add(catchments.label);
  const rb_ = data.region.bounds;
  const cellKm = ((rb_.east - rb_.west) * 111.2 * Math.cos((((rb_.north + rb_.south) / 2) * Math.PI) / 180)) / catchments.W;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt: { x: number; y: number; t: number } | null = null, lastTap: THREE.Vector3 | null = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6 || performance.now() - downAt.t > 500) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const ground = [...(tiles ? tiles.group.children.filter((m) => m.visible) : []), ...valleyMeshes];
    const hit = ray.intersectObjects(ground, false)[0];
    if (!hit) return;
    const camD = camera.position.distanceTo(controls.target);
    if (lastTap && hit.point.distanceTo(lastTap) < camD * 0.02) { catchments.clear(); lastTap = null; return; }
    const [lon, lat] = frame.lonlat(hit.point.x, hit.point.z);
    // on a reservoir that holds water: its whole catchment
    const rid = resIdAt(lon, lat), res = data.reservoirs.find((r) => r.id === rid && fillFraction(r, year) > 0);
    const area = catchments.trace(lon, lat, cellKm * cellKm, res ? rid : 0);
    if (area === null) return;
    lastTap = hit.point.clone();
    catchments.show(hit.point.clone().add(new THREE.Vector3(0, camD * 0.01, 0)), area, waterUse(year), res?.name);
  });
  // phones: the legend is a sheet behind a button
  const legendBtn = document.getElementById("legendBtn")!, legendEl = document.getElementById("legend")!;
  legendBtn.addEventListener("click", () => {
    const open = legendEl.classList.toggle("open");
    legendBtn.classList.toggle("on", open); legendBtn.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("legend-open", open);
  });
  let lastCapKey = "";
  function applyYear(t: number) {
    yearEl.textContent = String(Math.floor(t));
    // in a drought every full reservoir draws down together (the system is run as one)
    const dry = storage(t).s;
    const fillNow = (r: Reservoir) => { const f = fillFraction(r, t); return f >= 1 ? dry : f; };
    for (const r of data.reservoirs) fillU.value[r.id] = fillNow(r);
    catchments.update((id) => { const r = data.reservoirs.find((q) => q.id === id); return !!r && fillFraction(r, t) > 0; });
    const mapsOn = oldMaps.checked ? 1 : 0;
    // valleys: the dam rises during construction, then the water climbs from the old valley floor.
    // The old maps fade out as the land is cleared, from construction to the start of filling.
    for (const vv of valleys) {
      const f = fillNow(vv.res);
      vv.u.damP.value = damProgress(vv.res, t);
      // the edition in force, and the next one while it fades in
      let a = 0;
      while (a + 1 < vv.edWin.length && t >= vv.edWin[a + 1][1]) a++;
      const nxt = a + 1 < vv.edWin.length && t > vv.edWin[a + 1][0] ? a + 1 : -1;
      const [tA, tB] = [vv.maps.get(a), nxt >= 0 ? vv.maps.get(nxt) : null];
      vv.maps.keep([a, nxt, a + 1]);   // and preload the next
      if (tA) vv.u.topoA.value = tA;
      vv.u.topoB.value = tB ?? blankTex;
      vv.u.postA.value = vv.v.editions[a]?.phase === "post" ? 1 : 0;
      vv.u.postB.value = nxt >= 0 && vv.v.editions[nxt]?.phase === "post" ? 1 : 0;
      vv.u.topoK.value = tB ? (t - vv.edWin[nxt][0]) / (vv.edWin[nxt][1] - vv.edWin[nxt][0]) : 0;
      vv.u.topoMix.value = mapsOn;
      vv.water.position.y = yOf(vv.bed + (vv.v.water_level_m - vv.bed) * Math.sqrt(f)) + 0.002;
      vv.wU.alpha.value = f > 0 ? 1 : 0;
      const f0 = fillFraction(vv.res, t);   // filling only, not drought
      for (const ol of vv.oldLakes) ol.u.alpha.value = (ol.res ? fillFraction(ol.res, t) > 0 : f0 < 0.5) ? 1 : 0;
      vv.oldRiver.visible = f0 < 0.999;
    }
    demand.update(t);
    waterTable.position.y = -yOf((1 - dry) * 12);   // a drought lowers the water table too
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
    const camNear = camera.position.distanceTo(controls.target) < 90;
    for (const { r, div, sub, dp } of resLabels) {
      const f2 = fillFraction(r, t), building = damProgress(r, t) > 0 && f2 === 0 && t < (r.in_service ?? 9999);
      div.style.opacity = f2 > 0 || building ? "1" : "0";
      div.classList.toggle("building", building);
      if (sub && dp) {
        sub.style.display = camNear && (f2 > 0 || building) ? "block" : "none";
        sub.textContent = `${f2 > 0 ? "Drowned or moved" : "Being cleared"}: ${dp.places}${dp.note ? ` (${dp.note})` : ""}`;
      }
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

  // ---- stories ---------------------------------------------------------------------------
  let playTo: number | null = null, storySpeed = 4, storyChartOn = false, storyAt = -1;
  const storyEl = document.getElementById("story")!, storyChart = document.getElementById("storyChart")!;
  const showStory = (i: number) => {
    storyAt = (i + EPISODES.length) % EPISODES.length;
    const ep = EPISODES[storyAt];
    storyEl.hidden = false; document.body.classList.add("story-on");
    document.getElementById("storyNum")!.textContent = `Story ${storyAt + 1} of ${EPISODES.length}`;
    document.getElementById("storyTitle")!.textContent = ep.title;
    document.getElementById("storyText")!.textContent = ep.text;
    storyChartOn = ep.chart === "demand";
    storyChart.innerHTML = storyChartOn ? demandChart(year) : "";
    if (ep.catchments !== undefined) { catchOn.checked = ep.catchments || catchOn.checked; catchments.uniforms.catchOn.value = catchOn.checked ? 1 : 0; }
    catchments.clear();
    go(ep.view);
    if (Array.isArray(ep.years)) {
      year = ep.years[0]; playTo = ep.years[1];
      storySpeed = Math.max(1, (ep.years[1] - ep.years[0]) / 9);   // about nine seconds
      playing = true; playBtn.textContent = "❚❚";
    } else { year = ep.years; playTo = null; playing = false; playBtn.textContent = "▶"; }
    slider.value = String(year);
    setParam("story", String(storyAt + 1));
  };
  const closeStory = () => { storyEl.hidden = true; document.body.classList.remove("story-on"); storyChartOn = false; playTo = null; setParam("story", "0"); };
  document.getElementById("storiesBtn")!.onclick = () => (storyEl.hidden ? showStory(Math.max(0, storyAt)) : closeStory());
  document.getElementById("storyNext")!.onclick = () => showStory(storyAt + 1);
  document.getElementById("storyPrev")!.onclick = () => showStory(storyAt - 1);
  document.getElementById("storyClose")!.onclick = closeStory;
  addEventListener("keydown", (e) => {
    if (storyEl.hidden) return;
    if (e.key === "ArrowRight") showStory(storyAt + 1);
    else if (e.key === "ArrowLeft") showStory(storyAt - 1);
    else if (e.key === "Escape") closeStory();
  });

  // ---- loop ----------------------------------------------------------------------------
  go(params.get("view") ?? "region", true);
  if (params.get("ug") === "1") setUnderground(true);
  if (Number(params.get("story")) > 0) showStory(Number(params.get("story")) - 1);
  const clock = new THREE.Clock();
  document.getElementById("loading")!.style.opacity = "0";
  setTimeout(() => document.getElementById("loading")!.remove(), 600);
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    if (playing) {
      const end = playTo ?? T1;
      year = Math.min(end, year + dt * (playTo ? storySpeed : PLAY_YEARS_PER_SEC));
      slider.value = String(year);
      if (year >= end) { playing = false; playTo = null; playBtn.textContent = "▶"; }
    }
    if (storyChartOn) storyChart.innerHTML = demandChart(year);
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
    tiles?.update(camera);
    peaks.update(camD);
    drops.points.visible = catchOn.checked && camD > 8 && camD < 160;
    if (drops.points.visible) drops.update(dt, (id) => { const r = resById.get(id); return !!r && fillFraction(r, year) > 0; });
    // fog follows the camera's distance, so the horizon fades whether close in or far out
    const fogD = Math.max(60, camD);
    for (const m of [regionMat, ...valleyMats]) { m.uniforms.fogNear.value = fogD * 1.6; m.uniforms.fogFar.value = fogD * 5; }
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
  (window as any).catchment = {
    traceAt: (lon: number, lat: number) => {
      const rid = resIdAt(lon, lat), res = data.reservoirs.find((r) => r.id === rid && fillFraction(r, year) > 0);
      const a = catchments.trace(lon, lat, cellKm * cellKm, res ? rid : 0);
      const [x, z] = frame.xz(lon, lat);
      if (a !== null) catchments.show(new THREE.Vector3(x, yOf(groundAt(lon, lat)) + 0.5, z), a, waterUse(year), res?.name);
      return a;
    },
    mapsPending: () => valleys.reduce((n, vv) => n + vv.maps.pending, 0) + (tiles?.pending ?? 0), setYear: (y: number) => { year = y; slider.value = String(y); }, go, camera, controls, frame };
}

const EXAG_STR = "3.0";
/** the tiles shade from 128-pixel normal maps (tiles.ts): about this many of their pixels per km
 *  of distance from the camera, so depth / this is their shading detail */
const TILE_SPACING_DIV = "300.0";

/** A height grid's normals (scene units, exaggerated like the terrain) as a mipmapped texture. */
function normalTexture(g: HeightGrid, dxKm: number, dzKm: number): THREE.Texture {
  const { w, h, data } = g, px = new Uint8Array(w * h * 4);
  const H = (x: number, y: number) => yOf(data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]);
  const n = new THREE.Vector3();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    n.set(-(H(x + 1, y) - H(x - 1, y)) / (2 * dxKm), 1, -(H(x, y + 1) - H(x, y - 1)) / (2 * dzKm)).normalize();
    // the texture's first row is the south edge (uv v = 0)
    const i = ((h - 1 - y) * w + x) * 4;
    px[i] = (n.x * 0.5 + 0.5) * 255; px[i + 1] = (n.y * 0.5 + 0.5) * 255; px[i + 2] = (n.z * 0.5 + 0.5) * 255; px[i + 3] = 255;
  }
  const t = new THREE.DataTexture(px, w, h);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

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

/** A map sheet as a texture whose alpha fades it out toward the edges of its printed area and
 *  of the patch, over a band that wanders (smooth noise), so the boundary reads as a soft,
 *  irregular edge rather than a rectangle. Coverage and distance are worked out on a small grid
 *  and the alpha is scaled up smoothly onto the full image. */
function softMapEdges(img: HTMLImageElement): THREE.Texture {
  const G = 256, s = G / Math.max(img.width, img.height);
  const w = Math.max(8, Math.round(img.width * s)), h = Math.max(8, Math.round(img.height * s));
  const small = document.createElement("canvas"); small.width = w; small.height = h;
  const sx = small.getContext("2d", { willReadFrequently: true })!;
  sx.drawImage(img, 0, 0, w, h);
  const px = sx.getImageData(0, 0, w, h);
  // distance (in grid cells) to the nearest cell without a map, or to the border: chamfer 3-4
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = px.data[i * 4] + px.data[i * 4 + 1] + px.data[i * 4 + 2] > 40 ? 1e9 : 0;
  // (beyond the image counts as covered: the patch border has its own, rounder fade below)
  const D = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 1e9 : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], D(x - 1, y) + 3, D(x, y - 1) + 3, D(x - 1, y - 1) + 4, D(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], D(x + 1, y) + 3, D(x, y + 1) + 3, D(x + 1, y + 1) + 4, D(x - 1, y + 1) + 4);
  }
  // smooth value noise, two octaves, so the fade line meanders
  const seed = (img.width * 7919 + img.height * 104729) % 1000;
  const hash = (x: number, y: number) => { const t = Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453; return t - Math.floor(t); };
  const vnoise = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * ux, b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * ux;
    return a + (b - a) * uy;
  };
  const F = 0.05 * G;   // the width of the fade at a sheet's edge, in cells
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const n = 0.65 * vnoise(x / 28, y / 28) + 0.35 * vnoise(x / 9 + 50, y / 9 + 50);
    const t = Math.min(1, Math.max(0, (d[i] / 3 - n * 0.7 * F) / F));
    // toward the patch border: a squircle (rounded rectangle) with a wandering rim, fading over
    // the outer third or so, so a patch's map reads as a soft, irregular blob
    const u = (2 * (x + 0.5)) / w - 1, v = (2 * (y + 0.5)) / h - 1;
    const r = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25) + (n - 0.5) * 0.18;
    const k = Math.min(1, Math.max(0, (0.97 - r) / 0.35));
    px.data[i * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t) * k * k * (3 - 2 * k));
    px.data[i * 4] = px.data[i * 4 + 1] = px.data[i * 4 + 2] = 255;
  }
  sx.putImageData(px, 0, 0);
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const cx = c.getContext("2d")!;
  cx.drawImage(img, 0, 0);
  cx.globalCompositeOperation = "destination-in";
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
  cx.drawImage(small, 0, 0, img.width, img.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
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
