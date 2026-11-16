// The rain loop: an average year of the watershed's water, by month, played on its own clock.
//
// Rain (or, in winter, snow) falls around the view; some of it rises back to the air from the
// land as a faint shimmer (evaporation and the trees' transpiration, about half of the rain over a
// year, mostly in summer); the rest runs off, so the stream drops speed up in the spring melt and
// slow in late summer; and the reservoirs stand full in May and are drawn down by autumn.
//
// The monthly shapes are approximate, for an average year, from regional figures: about 45-50 in
// of precipitation a year, spread fairly evenly over the months; potential evaporation peaking in
// July; Catskill streamflow peaking in March-April with the snowmelt and lowest in August-September
// (USGS gauges such as Esopus Creek at Coldbrook); and the system's storage near full in late spring
// and lowest in October-November (DEP's "normal" storage curve). They are not measured for any
// one year; the real-years version would replace them with NOAA rain and DEP storage by month.
import * as THREE from "three";
import { HeightGrid, Frame, yOf } from "./geo";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// inches of precipitation per month, watershed average (approximate)
const PRECIP = [3.6, 3.1, 3.9, 4.1, 4.2, 4.4, 4.3, 4.2, 4.2, 4.2, 4.1, 3.9];
// share of it falling as snow
const SNOW = [0.85, 0.85, 0.5, 0.15, 0, 0, 0, 0, 0, 0, 0.15, 0.6];
// inches back to the air (evaporation and transpiration), ~24 a year
const ET = [0.2, 0.3, 0.8, 1.8, 3.3, 4.3, 4.6, 3.8, 2.6, 1.4, 0.6, 0.3];
// streamflow relative to the year's mean
const RUNOFF = [1.0, 1.0, 1.9, 2.1, 1.2, 0.7, 0.4, 0.3, 0.35, 0.6, 1.0, 1.1];
// system storage, fraction of full, at mid-month
const STORAGE = [0.85, 0.87, 0.92, 0.97, 0.99, 0.98, 0.94, 0.89, 0.84, 0.8, 0.81, 0.83];

const YEAR_S = 36;   // seconds for one year of the loop

/** A monthly series, read smoothly at a fractional month (0 = mid-January), wrapping round. */
const at = (s: number[], m: number) => {
  const a = ((Math.floor(m) % 12) + 12) % 12, b = (a + 1) % 12, f = m - Math.floor(m);
  return s[a] + (s[b] - s[a]) * (0.5 - 0.5 * Math.cos(Math.PI * f));
};

const pointShader = (size: number) => ({
  vertexShader: /* glsl */ `
    attribute float a; varying float vA; uniform float scale;
    void main() { vA = a; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
      gl_PointSize = ${size.toFixed(1)} * scale; }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color; uniform float opacity; varying float vA;
    void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard;
      gl_FragColor = vec4(color, opacity * vA * (1.0 - r * 4.0)); }`,
});

export class RainLoop {
  readonly group = new THREE.Group();
  on = false;
  month = 3.5;   // fractional month (0 = mid-January): starts in the spring melt
  private rain: THREE.LineSegments; private snow: THREE.Points; private mist: THREE.Points;
  private R: Float32Array; private S: Float32Array; private Sa: Float32Array; private M: Float32Array; private Ma: Float32Array;
  private mLife: Float32Array;
  private nRain: number; private nSnow: number; private nMist: number;
  private c = new THREE.Vector3(); private size = 10;

  constructor(private ground: HeightGrid, private frame: Frame, low: boolean) {
    this.nRain = low ? 1500 : 4000; this.nSnow = low ? 1500 : 4000; this.nMist = low ? 1200 : 3000;
    this.R = new Float32Array(this.nRain * 6);
    const rg = new THREE.BufferGeometry(); rg.setAttribute("position", new THREE.BufferAttribute(this.R, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xcfe3f5, transparent: true, opacity: 0.35, depthWrite: false }));
    this.S = new Float32Array(this.nSnow * 3); this.Sa = new Float32Array(this.nSnow).fill(1);
    const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(this.S, 3)); sg.setAttribute("a", new THREE.BufferAttribute(this.Sa, 1));
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({ ...pointShader(3), transparent: true, depthWrite: false,
      uniforms: { color: { value: new THREE.Color(0xffffff) }, opacity: { value: 0.8 }, scale: { value: 1 } } }));
    // what rises back to the air: faint, slow, fading as it goes up
    this.M = new Float32Array(this.nMist * 3); this.Ma = new Float32Array(this.nMist); this.mLife = new Float32Array(this.nMist);
    const mg = new THREE.BufferGeometry(); mg.setAttribute("position", new THREE.BufferAttribute(this.M, 3)); mg.setAttribute("a", new THREE.BufferAttribute(this.Ma, 1));
    this.mist = new THREE.Points(mg, new THREE.ShaderMaterial({ ...pointShader(6), transparent: true, depthWrite: false,
      uniforms: { color: { value: new THREE.Color(0xeef6f0) }, opacity: { value: 0.35 }, scale: { value: 1 } } }));
    for (const o of [this.rain, this.snow, this.mist]) { o.frustumCulled = false; o.renderOrder = 3; this.group.add(o); }
    this.group.visible = false;
  }

  /** this month's figures, for the panel: inches of rain and snow, back to air, runoff and storage */
  now() {
    const m = this.month;
    return { name: MONTHS[((Math.floor(m + 0.5) % 12) + 12) % 12], precip: at(PRECIP, m), snow: at(SNOW, m), et: at(ET, m), runoff: at(RUNOFF, m), storage: at(STORAGE, m) };
  }

  setOn(on: boolean) { this.on = on; this.group.visible = on; }

  private groundY(x: number, z: number) { const [lo, la] = this.frame.lonlat(x, z); return yOf(Math.max(0, this.ground.at(lo, la))); }
  private place(x: number, z: number) {
    // a random point in a disc around the view's centre
    const r = Math.sqrt(Math.random()) * this.size, t = Math.random() * Math.PI * 2;
    return [x + r * Math.cos(t), z + r * Math.sin(t)];
  }

  /** Advance the year by dt seconds around `centre` (the view's target), `camD` km from the camera. */
  update(dt: number, centre: THREE.Vector3, camD: number, pxScale: number) {
    if (!this.on) return;
    this.month = (this.month + (dt * 12) / YEAR_S) % 12;
    const n = this.now();
    // the falling volume follows the view; drops are scaled to it so the look holds at every zoom
    this.size = camD * 0.9; this.c.copy(centre);
    const top = camD * 0.35, fall = camD * 0.9;   // km a second, as seen
    const wet = Math.min(1, n.precip / 4.4);
    const showR = Math.round(this.nRain * wet * (1 - n.snow)), showS = Math.round(this.nSnow * wet * n.snow);
    const showM = Math.round(this.nMist * Math.min(1, n.et / 4.6));
    this.rain.geometry.setDrawRange(0, showR * 2); this.snow.geometry.setDrawRange(0, showS); this.mist.geometry.setDrawRange(0, showM);
    for (const o of [this.snow, this.mist]) (o.material as THREE.ShaderMaterial).uniforms.scale.value = pxScale;
    const streak = camD * 0.02;
    for (let k = 0; k < showR; k++) {
      const i = k * 6;
      let x = this.R[i], y = this.R[i + 1], z = this.R[i + 2];
      const far = Math.hypot(x - this.c.x, z - this.c.z) > this.size;
      y -= fall * dt;
      if (far || y < this.groundY(x, z) || !Number.isFinite(y)) {
        [x, z] = this.place(this.c.x, this.c.z); y = this.groundY(x, z) + Math.random() * top;
      }
      this.R[i] = x; this.R[i + 1] = y; this.R[i + 2] = z;
      this.R[i + 3] = x + streak * 0.15; this.R[i + 4] = y + streak; this.R[i + 5] = z;
    }
    const t = performance.now() / 1000;
    for (let k = 0; k < showS; k++) {
      const i = k * 3;
      let x = this.S[i], y = this.S[i + 1], z = this.S[i + 2];
      const far = Math.hypot(x - this.c.x, z - this.c.z) > this.size;
      y -= fall * 0.12 * dt;
      x += Math.sin(t * 0.7 + k) * camD * 0.004 * dt;
      if (far || y < this.groundY(x, z) || !Number.isFinite(y)) {
        [x, z] = this.place(this.c.x, this.c.z); y = this.groundY(x, z) + Math.random() * top;
      }
      this.S[i] = x; this.S[i + 1] = y; this.S[i + 2] = z;
    }
    for (let k = 0; k < showM; k++) {
      const i = k * 3;
      this.mLife[k] -= dt;
      if (this.mLife[k] <= 0 || Math.hypot(this.M[i] - this.c.x, this.M[i + 2] - this.c.z) > this.size) {
        const [x, z] = this.place(this.c.x, this.c.z);
        this.M[i] = x; this.M[i + 1] = this.groundY(x, z); this.M[i + 2] = z; this.mLife[k] = 2 + Math.random() * 3;
      }
      this.M[i + 1] += camD * 0.02 * dt;
      const life = this.mLife[k];
      this.Ma[k] = Math.min(1, life / 1.5) * Math.min(1, (5 - life) / 0.8);
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
    this.snow.geometry.attributes.position.needsUpdate = true;
    this.mist.geometry.attributes.position.needsUpdate = true;
    (this.mist.geometry.attributes.a as THREE.BufferAttribute).needsUpdate = true;
  }
}
