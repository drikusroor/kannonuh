/** Small, fast, seedable PRNG (mulberry32). Identical output on every peer. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Roughly normal, mean 0, sd 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.2247;
  }

  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

/** Deterministic value noise in 1D, used for terrain and textures. */
export function valueNoise(rng: Rng, count: number, octaves: number, persistence: number): number[] {
  const out = new Array<number>(count).fill(0);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const points = Math.max(2, Math.round(count / Math.pow(2, octaves - o) / 2) + 2);
    const control: number[] = [];
    for (let i = 0; i < points; i++) control.push(rng.next());
    for (let i = 0; i < count; i++) {
      const p = (i / (count - 1)) * (points - 1);
      const i0 = Math.floor(p);
      const i1 = Math.min(points - 1, i0 + 1);
      const f = p - i0;
      // smoothstep for soft, rolling hills
      const s = f * f * (3 - 2 * f);
      out[i] += (control[i0]! * (1 - s) + control[i1]! * s) * amp;
    }
    total += amp;
    amp *= persistence;
  }
  for (let i = 0; i < count; i++) out[i] = out[i]! / total;
  return out;
}

/** Deterministic hash → [0,1), handy for per-entity texture detail. */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
