// Geographic helpers. The scene uses kilometres in a local frame centred on the region:
// web-mercator metres scaled by cos(centre latitude), so distances are true near the centre.
// Heights are exaggerated by EXAG so the Catskills read at regional scale.

export const EXAG = 3;
const R = 6378137;

export interface Bounds { west: number; south: number; east: number; north: number }

export const mx = (lon: number) => (lon * Math.PI / 180) * R;
export const my = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

export class Frame {
  cx: number; cy: number; k: number;
  constructor(b: Bounds) {
    this.cx = (mx(b.west) + mx(b.east)) / 2;
    this.cy = (my(b.south) + my(b.north)) / 2;
    this.k = Math.cos(((b.south + b.north) / 2) * Math.PI / 180);
  }
  /** lon/lat -> scene x, z (km). North is -z. */
  xz(lon: number, lat: number): [number, number] {
    return [((mx(lon) - this.cx) * this.k) / 1000, (-(my(lat) - this.cy) * this.k) / 1000];
  }
  /** scene x, z (km) -> lon/lat */
  lonlat(x: number, z: number): [number, number] {
    const X = (x * 1000) / this.k + this.cx, Y = (-z * 1000) / this.k + this.cy;
    return [((X / R) * 180) / Math.PI, ((2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) * 180) / Math.PI];
  }
  /** mercator metres -> scene x, z */
  mxz(X: number, Y: number): [number, number] {
    return [((X - this.cx) * this.k) / 1000, (-(Y - this.cy) * this.k) / 1000];
  }
}

export const yOf = (elevM: number) => (elevM * EXAG) / 1000;

/** A decoded heightmap (metres) on a web-mercator-aligned grid. */
export class HeightGrid {
  constructor(public w: number, public h: number, public data: Float32Array, public b: Bounds) {}

  static async load(url: string, b: Bounds): Promise<HeightGrid> {
    const img = await loadImage(url);
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const out = new Float32Array(img.width * img.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768; // Terrarium encoding
    }
    return new HeightGrid(img.width, img.height, out, b);
  }

  /** bilinear sample at lon/lat (metres) */
  at(lon: number, lat: number): number {
    const u = (mx(lon) - mx(this.b.west)) / (mx(this.b.east) - mx(this.b.west));
    const v = (my(this.b.north) - my(lat)) / (my(this.b.north) - my(this.b.south));
    const x = Math.min(this.w - 1.001, Math.max(0, u * this.w - 0.5));
    const y = Math.min(this.h - 1.001, Math.max(0, v * this.h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const d = this.data, W = this.w, i = y0 * W + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + W] * (1 - fx) + d[i + W + 1] * fx) * fy;
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("failed to load " + url));
    img.src = url;
  });
}
