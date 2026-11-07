// Year -> state of each feature. All schedules are linear between dated milestones.

export interface Reservoir {
  id: number; name: string; system: string; lon: number; lat: number;
  construction_start: number | null; fill_start: number | null; fill_end: number | null;
  in_service: number | null; retired: number | null; water_level_m: number; approx: string[];
}
export interface Aqueduct {
  id: string; name: string; system: string; kind: string; coords: [number, number][];
  construction_start: number | null; in_service: number | null; retired: number | null;
}
export interface Dam { name: string; lon: number; lat: number; year: number; height_ft: number | null; length_ft: number | null }
export interface Event { year: number; label: string; system: string; approx: boolean; type: string }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0 = empty valley, 1 = full. Fades out over a year after retirement. */
export function fillFraction(r: Reservoir, t: number): number {
  const ins = r.in_service ?? 9999;
  const fs = r.fill_start ?? ins - 1;
  const fe = r.fill_end ?? Math.max(ins, fs + 0.5);
  let f = t < fs ? 0 : t >= fe ? 1 : (t - fs) / (fe - fs);
  if (r.retired != null) f *= 1 - clamp01(t - r.retired);
  return f;
}

/** 0 = not started, 1 = dam at full height (reached when filling starts). */
export function damProgress(r: Reservoir, t: number): number {
  const ins = r.in_service ?? 9999;
  const fs = r.fill_start ?? ins - 1;
  const cs = r.construction_start ?? fs - 4;
  return clamp01((t - cs) / Math.max(0.5, fs - cs));
}

export function damProgressFromYear(d: Dam, t: number): number {
  return clamp01((t - (d.year - 5)) / 5);
}

export type LineState = "hidden" | "building" | "service" | "retired";
export function lineState(a: Aqueduct, t: number): LineState {
  if (a.construction_start == null || t < a.construction_start) return "hidden";
  if (a.retired != null && t >= a.retired) return "retired";
  if (a.in_service == null || t < a.in_service) return "building";
  return "service";
}

export const ERAS = [
  { name: "Wells and ponds", system: "wells", from: 1830, to: 1837 },
  { name: "Croton", system: "croton", from: 1837, to: 1905 },
  { name: "Catskill", system: "catskill", from: 1905, to: 1931 },
  { name: "Delaware", system: "delaware", from: 1931, to: 1967 },
  { name: "Modern", system: "modern", from: 1967, to: 2030 },
];

export const SYSTEM_COLORS: Record<string, string> = {
  croton: "#d9772f", catskill: "#3d8fd6", delaware: "#3fae6a", modern: "#a46ad1", wells: "#8a8f94",
};
