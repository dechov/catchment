// The city as the consumer: one day's water, standing on the city's own ground.
//
// Two columns stand where the Croton Distributing Reservoir stood (Fifth Avenue, 40th to 42nd
// Street, now the library), on that reservoir's own footprint, about 420 feet square.
// The blue one holds one day of the city's draw from its upland reservoirs, the outlined one
// what the system could dependably deliver that year. Each is drawn at the scene's height
// exaggeration, like the terrain. When the blue column reaches the outline, the city is using
// all the water it has, which is when the next reservoir was built.
//
// The figures are rounded, approximate values for the upland (Croton, Catskill, Delaware)
// system, interpolated between the years listed; see DEMAND_NOTES.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Frame, yOf } from "./geo";

/** [year, million gallons a day drawn from the upland system] */
export const USE: [number, number][] = [
  [1842, 12], [1850, 30], [1860, 50], [1870, 75], [1880, 95], [1890, 150], [1900, 250], [1910, 340],
  [1917, 450], [1920, 550], [1930, 800], [1940, 950], [1949, 1050], [1950, 1000], [1960, 1150],
  [1963, 1200], [1965, 1050], [1967, 1150], [1970, 1300], [1979, 1500], [1990, 1420], [2000, 1240],
  [2010, 1040], [2020, 980], [2030, 980],
];
/** [year, MGD the system could dependably deliver]: steps as each source came in */
export const SUPPLY: [number, number][] = [
  [1842, 40], [1873, 70], [1890, 250], [1906, 340], [1915, 600], [1927, 900], [1951, 1000],
  [1955, 1150], [1964, 1290], [2030, 1290],
];
/** five-borough population, US census */
const POP: [number, number][] = [
  [1790, 49_447], [1800, 79_216], [1810, 119_734], [1820, 152_056], [1830, 242_278], [1840, 391_114],
  [1850, 696_115], [1860, 1_174_779], [1870, 1_478_103], [1880, 1_911_698], [1890, 2_507_414],
  [1900, 3_437_202], [1910, 4_766_883], [1920, 5_620_048], [1930, 6_930_446], [1940, 7_454_995],
  [1950, 7_891_957], [1960, 7_781_984], [1970, 7_894_862], [1980, 7_071_639], [1990, 7_322_564],
  [2000, 8_008_278], [2010, 8_175_133], [2020, 8_804_190], [2030, 8_804_190],
];
export const DEMAND_NOTES =
  "Water use and dependable supply are rounded approximations (NYC DEP histories; consumption " +
  "data from 1979). Before 1917 most of Brooklyn and Queens drew on their own wells and ponds.";

const lerp = (t: [number, number][], y: number, step = false) => {
  if (y < t[0][0]) return 0;
  for (let i = 0; i < t.length - 1; i++) {
    const [y0, v0] = t[i], [y1, v1] = t[i + 1];
    if (y < y1) return step ? v0 : v0 + ((v1 - v0) * (y - y0)) / (y1 - y0);
  }
  return t[t.length - 1][1];
};
export const waterUse = (y: number) => lerp(USE, y);

/** The great droughts: [peak year (fractional), lowest system storage (share of full), years from
 *  start to peak]. Rounded, approximate lows from DEP and press accounts. */
const DROUGHTS: [number, number, number, string][] = [
  [1950.0, 0.33, 1.2, "1949–50 drought"],
  [1965.5, 0.25, 2.5, "1960s drought"],
  [1981.1, 0.35, 0.9, "1980–81 drought"],
  [1985.3, 0.55, 0.7, "1985 drought"],
  [2002.2, 0.5, 0.8, "2001–02 drought"],
];
/** System storage as a share of full in year `y` (1 outside droughts), and which drought. */
export function storage(y: number): { s: number; name: string | null } {
  for (const [peak, low, rise, name] of DROUGHTS) {
    const fall = rise * 0.6;   // reservoirs refill faster than they drain
    const u = y < peak ? (peak - y) / rise : (y - peak) / fall;
    if (u < 1) { const k = 0.5 + 0.5 * Math.cos(Math.PI * u); return { s: 1 - (1 - low) * k, name }; }
  }
  return { s: 1, name: null };
}
export const supply = (y: number) => lerp(SUPPLY, y, true);
export const population = (y: number) => lerp(POP, y);

/** One year's people, use, what the system could draw, and any drought, as short HTML lines. */
export function demandSummary(year: number): string {
  const u = waterUse(year), s = supply(year), p = population(year), dr = storage(year);
  if (u <= 0) return `${(p / 1e6).toFixed(2)} million people, on wells, cisterns and ponds`;
  const fmt = (mgd: number) => (mgd >= 1000 ? `${(mgd / 1000).toFixed(2)} billion` : `${Math.round(mgd)} million`);
  return `${(p / 1e6).toFixed(p < 1e6 ? 2 : 1)} million people · use ≈ ${fmt(u)} gal a day · can draw ≈ ${fmt(s)}` +
    (dr.name && dr.s < 0.97 ? `<br><span class="drought">${dr.name}: reservoirs ≈ ${Math.round(dr.s * 100)}% full</span>` : "");
}

const M3_PER_MG = 3785.41;
const ANCHOR: [number, number] = [-73.98, 40.7536];   // Fifth Avenue at 42nd Street
const BEARING = 29;                                   // Manhattan's avenues, degrees east of north
const STREET = 79.6;                                  // metres between streets
const SIDE = 128;                                     // the reservoir: ~420 ft square

export function buildDemand(frame: Frame, ground: (lon: number, lat: number) => number) {
  const b = (BEARING * Math.PI) / 180;
  const k = Math.cos((ANCHOR[1] * Math.PI) / 180);
  // the reservoir: 40th to 42nd Street, from Fifth Avenue westward
  const north = [Math.sin(b), Math.cos(b)], west = [-Math.cos(b), Math.sin(b)];   // east, north
  const cE = west[0] * (SIDE / 2) - north[0] * STREET, cN = west[1] * (SIDE / 2) - north[1] * STREET;
  const lon = ANCHOR[0] + cE / (111_200 * k), lat = ANCHOR[1] + cN / 111_200;
  const [x, z] = frame.xz(lon, lat);
  const area = SIDE * SIDE;   // m^2
  const g = yOf(ground(lon, lat));
  const w = SIDE / 1000, d = SIDE / 1000;   // km

  const group = new THREE.Group();
  group.position.set(x, g, z);
  group.rotation.y = -b;
  const box = new THREE.BoxGeometry(w, 1, d); box.translate(0, 0.5, 0);
  const useMat = new THREE.MeshLambertMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.8, emissive: 0x0b2440 });
  const use = new THREE.Mesh(box, useMat);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false });
  const cap = new THREE.Mesh(box, capMat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  cap.add(edges);
  group.add(use, cap);

  const div = document.createElement("div");
  div.className = "label demand";
  const label = new CSS2DObject(div);
  group.add(label);

  const shortage = new THREE.Color(0xd9603b), normal = new THREE.Color(0x2f7fd0);
  const fmt = (mgd: number) => (mgd >= 1000 ? `${(mgd / 1000).toFixed(2)} billion` : `${Math.round(mgd)} million`);
  /** scene height (km, exaggerated like the terrain) of one day of `mgd` over the block */
  const hOf = (mgd: number) => yOf((mgd * M3_PER_MG) / area);

  return {
    group,
    update(year: number) {
      const u = waterUse(year), s = supply(year), p = population(year);
      group.visible = u > 0;
      if (!group.visible) return;
      const hu = Math.max(1e-4, hOf(u)), hs = Math.max(1e-4, hOf(s));
      use.scale.y = hu; cap.scale.y = hs;
      const tight = u / Math.max(1, s);   // > 0.9: the city is close to using all it has
      useMat.color.copy(normal).lerp(shortage, Math.min(1, Math.max(0, (tight - 0.85) / 0.15)));
      label.position.set(0, Math.max(hu, hs) + 0.05, 0);
      const dr = storage(year);
      div.innerHTML = `<b>${(p / 1e6).toFixed(p < 1e6 ? 2 : 1)} million people</b><br>` +
        `use ≈ ${fmt(u)} gal a day<br><span class="cap-line">can draw ≈ ${fmt(s)}</span>` +
        (dr.name && dr.s < 0.97 ? `<br><span class="drought">${dr.name}: reservoirs ≈ ${Math.round(dr.s * 100)}% full</span>` : "");
      div.classList.toggle("short", tight > 0.9 || dr.s < 0.7);
    },
  };
}
