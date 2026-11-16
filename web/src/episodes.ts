// Stories: short episodes that fly the camera to a place, set or play the years, and put a
// caption card (and sometimes a chart) on screen. Back and Next step through them.
import { USE, SUPPLY } from "./demand";

export interface Episode {
  title: string;
  /** "@lon,lat,km" or a named view */
  view: string;
  /** the year to show, or [from, to] to play through */
  years: number | [number, number];
  text: string;
  chart?: "demand";
  catchments?: boolean;
}

export const EPISODES: Episode[] = [
  {
    title: "A city without water", view: "@-74.005,40.715,6", years: 1830,
    text: "In 1830 New Yorkers drew water from wells, cisterns and the Collect Pond, by then filled in and built over. The Manhattan Company's wooden pipes carried well water to a fraction of the city. Cholera in 1832 and the Great Fire of 1835 made the case for something better.",
  },
  {
    title: "Croton water arrives", view: "@-73.86,41.0,70", years: [1837, 1843],
    text: "The Old Croton Dam backed up Croton Lake, and an aqueduct of brick and stone carried the water about 41 miles south by gravity. It crossed the Harlem River (on High Bridge from 1848) and fed the receiving reservoir later taken into Central Park and the distributing reservoir on Fifth Avenue at 42nd Street. Croton water reached the city in 1842.",
  },
  {
    title: "The Croton system grows", view: "croton", years: [1870, 1912],
    text: "As the city grew, more dams went up across the Croton watershed, and a second, larger aqueduct opened in 1890. The New Croton Dam (1906) drowned the old dam and its lake under a reservoir several times larger. Villages and farms in the valleys were bought out and cleared.",
    catchments: true,
  },
  {
    title: "What it was all for", view: "@-73.975,40.75,4", years: [1842, 1915],
    text: "The blue column is one day of the city's water, piled on the footprint of the old distributing reservoir. The outline is what the system could dependably deliver. Each time the column came near the outline, the city went looking for the next river.",
    chart: "demand",
  },
  {
    title: "Into the Catskills: Ashokan", view: "ashokan", years: [1906, 1916],
    text: "The Board of Water Supply, created in 1905, dammed Esopus Creek at Olive Bridge. Ashokan Reservoir covered the valley's villages; roughly two thousand people moved away, and their cemeteries were moved too. The old maps show the farms and roads the water would cover.",
  },
  {
    title: "Under the Hudson", view: "@-73.99,41.43,9", years: 1915,
    text: "The Catskill Aqueduct crosses the Hudson between Storm King and Breakneck Ridge in a pressure tunnel driven through granite more than a thousand feet below the river. From there it runs on to Kensico Reservoir, and through City Tunnel No. 1 under the city.",
  },
  {
    title: "Kensico", view: "kensico", years: [1880, 1918],
    text: "A small Croton-system reservoir at Kensico, built in the 1880s, was drowned by the much larger Kensico Reservoir (1915–17), which holds Catskill and later Delaware water before it enters the city's tunnels.",
  },
  {
    title: "The Delaware", view: "delaware", years: [1944, 1966],
    text: "Reaching for the Delaware's headwaters meant a fight with the states downstream, settled by the Supreme Court in 1931 and again in 1954, which capped how much New York could take. Rondout, Neversink, Pepacton and Cannonsville followed, and with them the drowned towns of four more valleys.",
    catchments: true,
  },
  {
    title: "The 1960s drought", view: "@-74.85,42.08,14", years: [1961, 1967],
    text: "From 1962 to 1966 the Northeast had its worst drought on record. The reservoirs fell to about a quarter full and the city restricted water use. Watch the water draw back from the shores and the old valley floors come out again.",
    chart: "demand",
  },
  {
    title: "Catchment", view: "region", years: 2025,
    text: "Today about two thousand square miles of watershed feed the system: every coloured area drains to a reservoir. Tap any spot to see what drains to it. Protecting that land, rather than filtering the water, is why most of New York's water is still not filtered.",
    catchments: true, chart: "demand",
  },
];

/** A small SVG chart of the city's use against dependable supply, with the year marked. */
export function demandChart(year: number): string {
  const W = 280, H = 110, x0 = 1840, x1 = 2030, yMax = 1600;
  const X = (y: number) => ((y - x0) / (x1 - x0)) * (W - 30) + 26;
  const Y = (v: number) => H - 16 - (v / yMax) * (H - 26);
  const line = (pts: [number, number][], step: boolean) => {
    let d = "";
    pts.forEach(([y, v], i) => {
      if (i === 0) d += `M${X(y)},${Y(v)}`;
      else d += step ? `H${X(y)}V${Y(v)}` : `L${X(y)},${Y(v)}`;
    });
    return d;
  };
  const ticks = [0, 500, 1000, 1500].map((v) => `<text x="22" y="${Y(v) + 3}" text-anchor="end">${v}</text><line x1="26" x2="${W - 4}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/>`).join("");
  const yrs = [1850, 1900, 1950, 2000].map((y) => `<text x="${X(y)}" y="${H - 3}" text-anchor="middle">${y}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Water use and dependable supply, million gallons a day">
    ${ticks}${yrs}
    <path d="${line(SUPPLY, true)}" class="supply"/>
    <path d="${line(USE, false)}" class="use"/>
    <line x1="${X(year)}" x2="${X(year)}" y1="6" y2="${H - 16}" class="now"/>
    <text x="30" y="12" class="k use-k">use</text><text x="62" y="12" class="k supply-k">dependable supply</text>
    <text x="${W - 4}" y="12" text-anchor="end" class="k">million gal/day ≈</text>
  </svg>`;
}
