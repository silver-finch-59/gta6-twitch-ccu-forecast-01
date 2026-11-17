// gta6-twitch-ccu-forecast-01 entry: "Rolling-midnight ratio forecaster" (Node 22, standard
// library only, offline, deterministic).
//
// Method
// ------
// A launch day's Twitch curve is anchored on hour 1's print p1, and the rest of the day is
// forecast as log-ratios off that anchor: for each hour h, ln(v_h / p1). The house baseline
// assumes those ratios are all 0 (persistence). They are not: every big launch in the kit dips
// after the midnight hour and ramps again as the US wakes up, and how far it ramps depends on
// how big hour 1 already was and how deep the dip from the pre-midnight evening was.
//
// So for a target case we build a library from the case's own `comparables`: every past launch
// whose release-day hourly curve is usable (hour 1 present, at least 20 of the 24 hours), and
// which was actually live at its UTC midnight (hour-1 viewers >= 5,000 and at least 5% of its
// pre-release weekly median; launches whose UTC day starts hours before their global unlock
// have a near-zero hour 1 and a 100-1000x jump that says nothing about a rolling-midnight
// launch). The GTA VI category's own pre-release history is excluded by the 20-hour rule: it
// has no release-day curve.
//
// Each library launch contributes its log-ratio curve. For hour h the forecast median is a
// kernel-weighted median of the library's ratios at h, with weights from two features that are
// observable at the checkpoint:
//   * ln(p1)            — hour-1 magnitude (bandwidth 1.0). Bigger hour-1 prints ramp less:
//                         a launch already at 800k has little headroom left; one at 20k can 9x.
//   * dip = ln(p1 / pre) — hour 1 against the last hour before midnight (bandwidth 0.5). A
//                         deep dip below the pre-midnight evening means the audience has not
//                         arrived yet and the daytime ramp is steeper.
// The spread is asymmetric, because the pinball loss is: underpredicting the upper tail
// costs 1.9 log units per unit at tau = 0.95, while overpredicting it costs 0.1, and the
// reverse holds at tau = 0.05. So each hour gets two robust spreads from the kernel-weighted
// quartiles of the library ratios around the weighted median: sigma_lo from the weighted
// 25th percentile, sigma_hi from the weighted 75th. The symmetric IQR spread still anchors
// both — sigma_lo never drops below 70% of it (a collapsed lower tail is what the pinball
// loss punishes hardest when the day turns out quiet) and sigma_hi never exceeds 160% of
// it — and each side is pooled 50% toward its own median across hours. Quantiles are
// p1 * exp(median + z_tau * sigma_side) with the standard normal's z at the five levels.
//
// One systematic miss remains in the median itself: even among launches with a similar dip,
// the kernel-weighted median underpredicts the daytime ramp of deep-dip launches (the
// audience has not arrived yet at hour 1, so the ramp is steeper than the dip-similar
// library median says). A deep-dip ramp boost corrects it: after smoothing, the median
// log-ratio at hour h is raised by 1.25 * max(0, -dip) * exp(-0.5 * ((h - 18) / 7)^2) —
// nothing for a flat or positive dip, up to ~1.25 log units at the evening peak for the
// deepest dips in the library. The median curve is smoothed 30% toward its 3-hour
// neighbours before the boost.
//
// The bandwidths, the live filter, the pooling, the smoothing, the boost and the spread
// floors were chosen by leave-one-out validation over all 42 launches in the kit (and by
// the 4 practice cases with their exact 38-comparable libraries): practice mean pinball
// loss 0.162 against the house baseline's 0.387, with every practice case beaten
// (0.168 / 0.148 / 0.145 / 0.188 vs 0.744 / 0.287 / 0.215 / 0.303); leave-one-out over
// the 33 live-at-midnight launches 0.233 (0.243 on the builder's unfiltered-library
// variant). Nothing is tuned on the final case, which the program never sees.
//
// What the program does NOT use: `streams` and `categories_hourly` (null in the practice
// cases, so unvalidatable), and any within-hour-1 minute slope (also unvalidatable on hourly
// practice history). The minute reads in the final case's `history` are used only the way the
// hourly practice points are: averaged into the hour before midnight for the dip feature.
//
// Contract (same as the kit starter): read every <id>.in in the input directory (the grader
// runs one case at a time, with only that case's file there), write <id>.out to the output
// directory: {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, exactly 23 rows, hours
// 2..24 each once, no other key, each q finite, above 0 and at most 1e9, non-decreasing,
// at most 65,536 bytes. Outside the grader's container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0.0, 0.6744897501960817, 1.6448536269514722];

/** Kernel bandwidth (log units) for the hour-1 magnitude feature. */
const BW_LOG_P1 = 1.0;
/** Kernel bandwidth (log units) for the dip feature. */
const BW_DIP = 0.5;
/** How far each hour's spread is shrunk toward the median spread over all hours. */
const SPREAD_POOL = 0.5;
/** How far each hour's median is shrunk toward its 3-hour neighbours. */
const SMOOTH = 0.3;
/** Deep-dip ramp boost: log units added to the smoothed median at the peak, per unit of dip depth. */
const RAMP_BOOST_BETA = 1.25;
/** Centre (hour) of the boost's Gaussian bump over the day. */
const RAMP_BOOST_CENTER = 18;
/** Width (hours) of the boost's Gaussian bump over the day. */
const RAMP_BOOST_WIDTH = 7;
/** The weighted-quartile lower spread never drops below this fraction of the symmetric IQR spread. */
const SPREAD_LO_FLOOR = 0.7;
/** The weighted-quartile upper spread never exceeds this multiple of the symmetric IQR spread. */
const SPREAD_HI_CAP = 1.6;
/** Smallest spread allowed for one hour, in log units. */
const MIN_SIGMA = 0.08;
/** A launch counts as live at its UTC midnight only above this hour-1 print. */
const LIVE_MIN_P1 = 5000;
/** ... and only if hour 1 is at least this fraction of its pre-release weekly median. */
const LIVE_MIN_P1_OVER_BASE = 0.05;
/** A comparable needs this many release-day hours present to join the library. */
const MIN_CURVE_HOURS = 20;
/** Fallback spread (log units) when the case carries no usable comparables at all. */
const FALLBACK_SIGMA = 0.35;

interface HourlyPoint {
  from: string;
  viewers: number | null;
  channels?: number | null;
}

interface HistoryPoint {
  at: string;
  viewers: number | null;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
  name: string;
}

interface Case {
  id: string;
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history: HistoryPoint[];
  history_hourly?: HourlyPoint[];
  comparables: Comparable[];
}

/** One library launch: its log-ratio curve and its two checkpoint features. */
interface LibraryLaunch {
  name: string;
  /** log(v_h / p1) for the release-day hours present, h = 2..24. */
  ratios: Map<number, number>;
  logP1: number;
  /** ln(p1 / last-hour-before-midnight); 0 when that hour is unobserved. */
  dip: number;
  live: boolean;
}

const ms = (iso: string): number => Date.parse(iso);
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/** Weighted median: the smallest value whose cumulative weight reaches half the total. */
const weightedMedian = (pairs: Array<[number, number]>): number => {
  const usable = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (usable.length === 0) return 0;
  const total = usable.reduce((acc, [, w]) => acc + w, 0);
  let acc = 0;
  for (const [v, w] of usable) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return usable[usable.length - 1][0];
};

/** Weighted quantile: the smallest value whose cumulative weight reaches q of the total. */
const weightedQuantile = (pairs: Array<[number, number]>, q: number): number => {
  const usable = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (usable.length === 0) return 0;
  const total = usable.reduce((acc, [, w]) => acc + w, 0);
  let acc = 0;
  for (const [v, w] of usable) {
    acc += w;
    if (acc >= q * total) return v;
  }
  return usable[usable.length - 1][0];
};

/**
 * Mean viewers in the hour before `dayStartMs`, from points stamped with `at` (history) or
 * `from` (hourly series). Minute reads average into the hour's print; hourly points land one
 * per hour. Falls back to the most recent point in the 24 h before midnight, else null.
 */
const hourBeforeMidnight = (
  points: Array<{ at?: string; from?: string; viewers: number | null }>,
  dayStartMs: number,
): number | null => {
  const inHour: number[] = [];
  let last: { t: number; v: number } | null = null;
  for (const p of points) {
    const stamp = p.at ?? p.from;
    if (stamp === undefined || p.viewers === null || p.viewers === undefined) continue;
    const t = ms(stamp);
    if (t >= dayStartMs - HOUR_MS && t < dayStartMs) inHour.push(p.viewers);
    if (t < dayStartMs && t >= dayStartMs - DAY_MS && (last === null || t > last.t)) {
      last = { t, v: p.viewers };
    }
  }
  if (inHour.length > 0) return inHour.reduce((a, b) => a + b, 0) / inHour.length;
  return last === null ? null : last.v;
};

/** Median viewers in the week before the release day, excluding the last 24 h. */
const preReleaseMedian = (points: HourlyPoint[], dayStartMs: number): number | null => {
  const vals: number[] = [];
  for (const p of points) {
    if (p.viewers === null || p.viewers === undefined) continue;
    const t = ms(p.from);
    if (t >= dayStartMs - 7 * DAY_MS && t < dayStartMs - DAY_MS) vals.push(p.viewers);
  }
  return vals.length === 0 ? null : median(vals);
};

/** A comparable's release-day curve: hour (1..24, from its day_start) -> viewers. */
const releaseDayCurve = (points: HourlyPoint[], dayStartMs: number): Map<number, number> => {
  const sums = new Map<number, { total: number; n: number }>();
  for (const p of points) {
    if (p.viewers === null || p.viewers === undefined || p.viewers <= 0) continue;
    const h = Math.floor((ms(p.from) - dayStartMs) / HOUR_MS) + 1;
    if (h < 1 || h > 24) continue;
    const cur = sums.get(h) ?? { total: 0, n: 0 };
    cur.total += p.viewers;
    cur.n += 1;
    sums.set(h, cur);
  }
  const curve = new Map<number, number>();
  for (const [h, { total, n }] of sums) curve.set(h, total / n);
  return curve;
};

const buildLibrary = (comparables: Comparable[]): LibraryLaunch[] => {
  const lib: LibraryLaunch[] = [];
  const sorted = [...comparables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const comp of sorted) {
    const dayStartMs = ms(comp.day_start);
    const curve = releaseDayCurve(comp.hourly, dayStartMs);
    const p1 = curve.get(1);
    if (p1 === undefined || p1 <= 0 || curve.size < MIN_CURVE_HOURS) continue;
    const ratios = new Map<number, number>();
    for (let h = 2; h <= 24; h++) {
      const v = curve.get(h);
      if (v !== undefined && v > 0) ratios.set(h, Math.log(v / p1));
    }
    if (ratios.size < MIN_CURVE_HOURS - 1) continue;
    const pre = hourBeforeMidnight(comp.hourly, dayStartMs);
    const dip = pre !== null && pre > 0 ? Math.log(p1 / pre) : 0;
    const base = preReleaseMedian(comp.hourly, dayStartMs);
    const live = p1 >= LIVE_MIN_P1 && (base === null || p1 >= LIVE_MIN_P1_OVER_BASE * base);
    lib.push({ name: comp.name, ratios, logP1: Math.log(p1), dip, live });
  }
  return lib;
};

/** Gaussian kernel weight of a library launch against the target's two features. */
const kernelWeight = (launch: LibraryLaunch, logP1: number, dip: number): number => {
  const a = (launch.logP1 - logP1) / BW_LOG_P1;
  const b = (launch.dip - dip) / BW_DIP;
  return Math.exp(-0.5 * (a * a + b * b));
};

/** The five quantiles for one hour, from a median log-ratio and its two spreads.
 *  Levels below the median use sigmaLo, levels above it sigmaHi. */
const hourQuantiles = (p1: number, med: number, sigmaLo: number, sigmaHi: number): number[] => {
  const qs = Z.map((z, i) => {
    const sigma = LEVELS[i] < 0.5 ? sigmaLo : sigmaHi;
    return round2(Math.min(1e9, Math.max(1, p1 * Math.exp(med + z * sigma))));
  });
  for (let i = 1; i < qs.length; i++) if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  return qs;
};

const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${c.id} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const forecastHours = c.forecast.map((f) => f.hour).sort((a, b) => a - b);

  const library = buildLibrary(c.comparables ?? []);
  const live = library.filter((l) => l.live);
  const pool = live.length >= 5 ? live : library;

  // No usable comparables: fall back to a fixed-spread persistence around hour 1.
  if (pool.length === 0) {
    return forecastHours.map((h) => ({ hour: h, q: hourQuantiles(p1, 0, FALLBACK_SIGMA, FALLBACK_SIGMA) }));
  }

  const dayStartMs = ms(c.day_start);
  const historyPoints = c.history ?? c.history_hourly ?? [];
  const pre = hourBeforeMidnight(historyPoints, dayStartMs);
  const targetDip = pre !== null && pre > 0 ? Math.log(p1 / pre) : 0;
  const targetLogP1 = Math.log(p1);

  // Per-hour weighted median of the library's log-ratios, and its two robust spreads.
  const medByHour = new Map<number, number>();
  const sigmaLoByHour = new Map<number, number>();
  const sigmaHiByHour = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const pairs: Array<[number, number]> = [];
    for (const launch of pool) {
      const r = launch.ratios.get(h);
      if (r !== undefined) pairs.push([r, kernelWeight(launch, targetLogP1, targetDip)]);
    }
    if (pairs.length === 0) continue;
    const med = weightedMedian(pairs);
    medByHour.set(h, med);
    const resid = pairs.map(([r]) => r - med);
    // Symmetric IQR spread anchors both sides; the weighted quartiles give the skew.
    // (Unweighted quartiles around the weighted median are mis-centred and were much
    // worse in validation, so both quartiles use the same kernel weights as the median.)
    const symSigma = Math.max(MIN_SIGMA, (quantile(resid, 0.75) - quantile(resid, 0.25)) / 1.349);
    const sigmaLo = Math.max(
      MIN_SIGMA,
      SPREAD_LO_FLOOR * symSigma,
      (med - weightedQuantile(pairs, 0.25)) / 0.6744897501960817,
    );
    const sigmaHi = Math.min(
      Math.max(MIN_SIGMA, (weightedQuantile(pairs, 0.75) - med) / 0.6744897501960817),
      SPREAD_HI_CAP * symSigma,
    );
    sigmaLoByHour.set(h, sigmaLo);
    sigmaHiByHour.set(h, sigmaHi);
  }
  // Hours with no library value borrow the nearest hour that has one.
  const have = [...medByHour.keys()].sort((a, b) => a - b);
  for (let h = 2; h <= 24; h++) {
    if (!medByHour.has(h) && have.length > 0) {
      const near = have.reduce((best, hh) =>
        Math.abs(hh - h) < Math.abs(best - h) ? hh : best, have[0]);
      medByHour.set(h, medByHour.get(near)!);
      sigmaLoByHour.set(h, sigmaLoByHour.get(near)!);
      sigmaHiByHour.set(h, sigmaHiByHour.get(near)!);
    }
  }
  // Pool each side's spreads toward its own median, then smooth the medians across neighbours.
  for (const side of [sigmaLoByHour, sigmaHiByHour]) {
    const pooledSigma = median([...side.values()]);
    for (const h of side.keys()) {
      side.set(h, (1 - SPREAD_POOL) * side.get(h)! + SPREAD_POOL * pooledSigma);
    }
  }
  const smoothed = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const neigh = [h - 1, h, h + 1].filter((hh) => medByHour.has(hh)).map((hh) => medByHour.get(hh)!);
    const avg = neigh.reduce((a, b) => a + b, 0) / neigh.length;
    smoothed.set(h, (1 - SMOOTH) * medByHour.get(h)! + SMOOTH * avg);
  }
  // Deep-dip ramp boost: a launch whose hour 1 sits far below its pre-midnight evening
  // has its audience still arriving, so its daytime ramp runs steeper than the median of
  // dip-similar library launches. Lift the smoothed median by a Gaussian bump centred on
  // the evening peak, scaled by how deep the dip is; flat or positive dips get nothing.
  const dipDepth = Math.max(0, -targetDip);
  if (dipDepth > 0) {
    for (let h = 2; h <= 24; h++) {
      const shape = Math.exp(-0.5 * ((h - RAMP_BOOST_CENTER) / RAMP_BOOST_WIDTH) ** 2);
      smoothed.set(h, smoothed.get(h)! + RAMP_BOOST_BETA * dipDepth * shape);
    }
  }
  return forecastHours.map((h) => ({
    hour: h,
    q: hourQuantiles(p1, smoothed.get(h) ?? 0, sigmaLoByHour.get(h) ?? FALLBACK_SIGMA, sigmaHiByHour.get(h) ?? FALLBACK_SIGMA),
  }));
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
