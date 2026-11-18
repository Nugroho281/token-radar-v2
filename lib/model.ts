// Sightline — the token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every genuine pre-token protocol: it records no token (no market cap, no CoinGecko
// id, no symbol) and is not a wrapped, staked, bridged or exchange product, following the house
// watchlist's own exclusion rules without its $50M floor. The watchlist is the floor, never the
// ceiling: all 40 of its slugs are on the board, plus the genuine pre-token protocols below the floor.
//
// Implied value is fitted, never asserted: a size curve (log-log OLS of market cap on TVL) over the
// traded tokens in this same snapshot, with extra terms kept only when a walk-forward test keeps them.
// The final model is refit on every comp at runtime and bootstrapped 200 times, so each row carries a
// p10/p50/p90 band and a rank range. No protocol name is ever special-cased: the same functions score
// every row, and every number the dashboard shows is computed here from the snapshot.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A seeded RNG (mulberry32): every random draw in this file comes from a fixed seed, so two runs agree. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list (sorted copy, linear interpolation). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)]! + s[Math.ceil(mid)]!) / 2;
}

/** The q-th quantile of a sorted list (linear interpolation). */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A comp's age in years from its listing date to the snapshot date. */
function ageYears(asOf: string, listedAt: string | null): number | null {
  const d = ageDays(asOf, listedAt);
  return d === null ? null : d / 365.25;
}

/** Growth clipped to the bake-off's window, null reported as 0. */
function growthClipped(change7d: number | null): number {
  return Math.min(200, Math.max(-90, finite(change7d, 0)));
}

// ---------------------------------------------------------------- comps

/** One traded token the model is fitted on: one per ticker, largest TVL per group. */
export interface Comp {
  slug: string;
  category: string | null;
  chains_n: number;
  tvl: number;
  mcap: number;
  x: number; // log10(tvl)
  y: number; // log10(mcap)
  growth: number; // clipped change_7d, in per cent
  age: number; // age in years (median-imputed when listed_at is null)
  has_listed_at: boolean;
  listed_at: string | null;
}

/** The comps: dedupe one-per-ticker (group gecko_id, fallback symbol; TVL largest), mcap>0, tvl>0. */
export function buildComps(snapshot: Snapshot): Comp[] {
  const byTicker = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) {
    if (!(p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)) continue;
    const key = p.gecko_id ?? p.symbol ?? p.slug;
    const cur = byTicker.get(key);
    if (cur === undefined || p.tvl_usd > cur.tvl_usd) byTicker.set(key, p);
  }
  const ages = [...byTicker.values()]
    .map((p) => ageYears(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 1;
  const comps: Comp[] = [...byTicker.values()].map((p) => {
    const age = ageYears(snapshot.as_of, p.listed_at);
    return {
      slug: p.slug,
      category: p.category,
      chains_n: p.chains.length,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd as number,
      x: Math.log10(p.tvl_usd),
      y: Math.log10(p.mcap_usd as number),
      growth: growthClipped(p.change_7d),
      age: age ?? medianAge,
      has_listed_at: p.listed_at !== null,
      listed_at: p.listed_at,
    };
  });
  comps.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return comps;
}

/** The features a protocol (comp or board row) is scored on. */
export interface Features {
  x: number;
  growth: number; // growth/100, clipped
  age: number; // years
  chains: number;
  category: string | null;
}

export function featuresOf(p: SnapshotProtocol, asOf: string, medianAge: number): Features {
  const age = ageYears(asOf, p.listed_at);
  return {
    x: Math.log10(Math.max(1, p.tvl_usd)),
    growth: growthClipped(p.change_7d) / 100,
    age: age ?? medianAge,
    chains: p.chains.length,
    category: p.category,
  };
}

// ---------------------------------------------------------------- linear algebra

/** Solve A z = b by Gaussian elimination with partial pivoting (small dense systems only). */
function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) a[piv]![col] = 1e-12;
    if (piv !== col) {
      const tmp = a[col]!;
      a[col] = a[piv]!;
      a[piv] = tmp;
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * z[c]!;
    z[r] = s / a[r]![r]!;
  }
  return z;
}

/** Ordinary least squares for a design matrix whose first column is the intercept. */
function ols(design: number[][], y: number[], ridge: number, penalizeIntercept: boolean): number[] {
  const k = design[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i]!;
    for (let a = 0; a < k; a++) {
      xty[a]! += row[a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += row[a]! * row[b]!;
    }
  }
  for (let a = 0; a < k; a++) {
    if (a === 0 && !penalizeIntercept) continue;
    xtx[a]![a]! += ridge;
  }
  return solveLinear(xtx, xty);
}

// ---------------------------------------------------------------- model specs

/** A term the size curve may carry, beyond log10(TVL). */
export type Term = 'growth' | 'age' | 'chains';

/** How a model is built: its linear terms, and whether a shrunk per-category offset is added. */
export interface ModelSpec {
  terms: Term[];
  catOffset: boolean;
  ridge: boolean;
}

const BASE_SPEC: ModelSpec = { terms: [], catOffset: false, ridge: false };

/** A fitted model: coefficients over [1, x, ...terms] plus, when set, shrunk category offsets. */
export interface FittedModel {
  spec: ModelSpec;
  coef: number[];
  offsets: Map<string, number>;
  means: number[];
  stds: number[];
}

function designRow(f: Features, spec: ModelSpec, means: number[], stds: number[]): number[] {
  const raw: number[] = [1, f.x];
  for (const t of spec.terms) {
    if (t === 'growth') raw.push(f.growth);
    else if (t === 'age') raw.push(f.age);
    else raw.push(f.chains);
  }
  if (!spec.ridge) return raw;
  return raw.map((v, i) => (i === 0 ? v : (v - means[i]!) / (stds[i] === 0 ? 1 : stds[i]!)));
}

/** Fit a spec on comps: OLS (or ridge on standardised features) plus shrunk category offsets. */
export function fitModel(comps: Comp[], spec: ModelSpec): FittedModel {
  const feats: Features[] = comps.map((c) => ({ x: c.x, growth: c.growth / 100, age: c.age, chains: c.chains_n, category: c.category }));
  const k = 2 + spec.terms.length;
  const means = new Array<number>(k).fill(0);
  const stds = new Array<number>(k).fill(1);
  if (spec.ridge) {
    for (let j = 1; j < k; j++) {
      const vals = feats.map((f) => designRow(f, { ...spec, ridge: false }, means, stds)[j]!);
      const m = vals.reduce((s, v) => s + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / vals.length);
      means[j] = m;
      stds[j] = sd === 0 ? 1 : sd;
    }
  }
  const design = feats.map((f) => designRow(f, spec, means, stds));
  const y = comps.map((c) => c.y);
  const coef = ols(design, y, spec.ridge ? 1e-3 : 1e-12, spec.ridge);
  const offsets = new Map<string, number>();
  if (spec.catOffset) {
    const residByCat = new Map<string, number[]>();
    for (let i = 0; i < comps.length; i++) {
      const cat = comps[i]!.category ?? 'null';
      const pred = design[i]!.reduce((s, v, j) => s + v * coef[j]!, 0);
      const list = residByCat.get(cat) ?? [];
      list.push(y[i]! - pred);
      residByCat.set(cat, list);
    }
    for (const [cat, rs] of residByCat) {
      const n = rs.length;
      const meanResid = rs.reduce((s, v) => s + v, 0) / n;
      offsets.set(cat, (n / (n + 8)) * meanResid);
    }
  }
  return { spec, coef, offsets, means, stds };
}

/** A fitted model's log10(market cap) prediction for one protocol's features. */
export function predictLog10(model: FittedModel, f: Features): number {
  const row = designRow(f, model.spec, model.means, model.stds);
  let pred = row.reduce((s, v, j) => s + v * model.coef[j]!, 0);
  if (model.spec.catOffset) pred += model.offsets.get(f.category ?? 'null') ?? 0;
  return pred;
}

/** Variant A: the median mcap/TVL multiple per category (global median when a category has <3 comps). */
export interface MedianMultipleModel {
  byCat: Map<string, number>;
  global: number;
}

export function fitMedianMultiple(comps: Comp[]): MedianMultipleModel {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const c of comps) {
    const m = c.mcap / c.tvl;
    all.push(m);
    const list = byCat.get(c.category ?? 'null') ?? [];
    list.push(m);
    byCat.set(c.category ?? 'null', list);
  }
  const out = new Map<string, number>();
  for (const [cat, ms] of byCat) if (ms.length >= 3) out.set(cat, median(ms));
  return { byCat: out, global: median(all) };
}

export function predictMedianMultiple(model: MedianMultipleModel, f: Features, tvl: number): number {
  const mult = model.byCat.get(f.category ?? 'null') ?? model.global;
  return Math.log10(Math.max(1, tvl * mult));
}

/** |log10 error| of a prediction against an actual market cap. */
function logError(predLog10: number, actualMcap: number): number {
  return Math.abs(predLog10 - Math.log10(actualMcap));
}

export interface VariantScore {
  variant: string;
  label: string;
  wf_median: number;
  wf_within2: number;
  blind_median: number;
  blind_within2: number;
}

export interface ValidationResult {
  scores: VariantScore[];
  winner: string;
  selected_terms: string[];
  n_comps: number;
  n_wf: number;
  n_blind: number;
}

// ---------------------------------------------------------------- validation

const LOG2 = Math.log10(2);

function summarizeErrors(errors: number[]): { median: number; within2: number } {
  if (errors.length === 0) return { median: Number.NaN, within2: 0 };
  return {
    median: median(errors),
    within2: errors.filter((e) => e <= LOG2).length / errors.length,
  };
}

/** Predict one comp with a spec (A handled separately): the spec's own fit on the training comps. */
function predictWithSpec(train: Comp[], spec: ModelSpec, target: Comp): number {
  const model = fitModel(train, spec);
  return predictLog10(model, { x: target.x, growth: target.growth / 100, age: target.age, chains: target.chains_n, category: target.category });
}

/** Walk-forward time-split errors: comps with listed_at, sorted by it, 3 expanding folds. */
function walkForwardErrors(comps: Comp[], predict: (train: Comp[], target: Comp) => number): number[] {
  const dated = comps
    .filter((c) => c.has_listed_at)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const n = dated.length;
  const cuts = [Math.floor(n * 0.5), Math.floor(n * 0.7), Math.floor(n * 0.85), n];
  const errors: number[] = [];
  for (let f = 0; f < 3; f++) {
    const train = dated.slice(0, cuts[f]!);
    const test = dated.slice(cuts[f]!, cuts[f + 1]!);
    for (const t of test) errors.push(logError(predict(train, t), t.mcap));
  }
  return errors;
}

/** Blind holdout errors: 5 seeded 75/25 splits over all comps. */
function blindErrors(comps: Comp[], predict: (train: Comp[], target: Comp) => number, seedBase: number): number[] {
  const errors: number[] = [];
  for (let s = 0; s < 5; s++) {
    const rng = mulberry32(seedBase + s);
    const idx = comps.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = idx[i]!;
      idx[i] = idx[j]!;
      idx[j] = tmp;
    }
    const nTest = Math.floor(comps.length * 0.25);
    const testIdx = new Set(idx.slice(0, nTest));
    const train = comps.filter((_, i) => !testIdx.has(i));
    const test = comps.filter((_, i) => testIdx.has(i));
    for (const t of test) errors.push(logError(predict(train, t), t.mcap));
  }
  return errors;
}

const WF_IMPROVE = 0.005;
const TIE_MARGIN = 0.01;
const SIMPLER_ORDER = ['A', 'B', 'D', 'C'];

/**
 * The bake-off: variants A–D scored by walk-forward time-split and blind holdout. Variant C keeps a
 * term only when adding it improves the walk-forward median error by at least 0.005, tried in the
 * order category offset, growth, age, chains. The winner is the lowest walk-forward median error;
 * within 0.01 of it, the simpler variant wins (A < B < D < C).
 */
export function evaluateVariants(snapshot: Snapshot, comps: Comp[]): ValidationResult {
  const seedBase = 20261114;
  const predictA = (train: Comp[], t: Comp): number => {
    const m = fitMedianMultiple(train);
    return predictMedianMultiple(m, { x: t.x, growth: t.growth / 100, age: t.age, chains: t.chains_n, category: t.category }, t.tvl);
  };
  const predictB = (train: Comp[], t: Comp): number => predictWithSpec(train, BASE_SPEC, t);

  const wfA = summarizeErrors(walkForwardErrors(comps, predictA));
  const wfB = summarizeErrors(walkForwardErrors(comps, predictB));
  const blindA = summarizeErrors(blindErrors(comps, predictA, seedBase));
  const blindB = summarizeErrors(blindErrors(comps, predictB, seedBase));

  // Variant C: greedy term selection on the walk-forward score.
  let specC: ModelSpec = { terms: [], catOffset: false, ridge: false };
  let bestWf = wfB.median;
  const selected: string[] = [];
  const candidates: { name: string; apply: (s: ModelSpec) => ModelSpec }[] = [
    { name: 'category-offset', apply: (s) => ({ ...s, catOffset: true }) },
    { name: 'growth', apply: (s) => ({ ...s, terms: [...s.terms, 'growth' as Term] }) },
    { name: 'age', apply: (s) => ({ ...s, terms: [...s.terms, 'age' as Term] }) },
    { name: 'chains', apply: (s) => ({ ...s, terms: [...s.terms, 'chains' as Term] }) },
  ];
  for (const cand of candidates) {
    const trial = cand.apply(specC);
    const wf = summarizeErrors(
      walkForwardErrors(comps, (train, t) => predictWithSpec(train, trial, t)),
    ).median;
    if (bestWf - wf >= WF_IMPROVE) {
      specC = trial;
      bestWf = wf;
      selected.push(cand.name);
    }
  }
  const predictC = (train: Comp[], t: Comp): number => predictWithSpec(train, specC, t);
  const wfC = summarizeErrors(walkForwardErrors(comps, predictC));
  const blindC = summarizeErrors(blindErrors(comps, predictC, seedBase));

  // Variant D: ridge multi-factor log-log, standardised features, no category offset.
  const specD: ModelSpec = { terms: ['growth', 'age', 'chains'], catOffset: false, ridge: true };
  const predictD = (train: Comp[], t: Comp): number => predictWithSpec(train, specD, t);
  const wfD = summarizeErrors(walkForwardErrors(comps, predictD));
  const blindD = summarizeErrors(blindErrors(comps, predictD, seedBase));

  const scores: VariantScore[] = [
    { variant: 'A', label: 'Median multiple per category', wf_median: wfA.median, wf_within2: wfA.within2, blind_median: blindA.median, blind_within2: blindA.within2 },
    { variant: 'B', label: 'Size curve (log-log OLS)', wf_median: wfB.median, wf_within2: wfB.within2, blind_median: blindB.median, blind_within2: blindB.within2 },
    { variant: 'C', label: 'Size curve + walk-forward term selection', wf_median: wfC.median, wf_within2: wfC.within2, blind_median: blindC.median, blind_within2: blindC.within2 },
    { variant: 'D', label: 'Ridge multi-factor log-log', wf_median: wfD.median, wf_within2: wfD.within2, blind_median: blindD.median, blind_within2: blindD.within2 },
  ];
  const best = Math.min(...scores.map((s) => s.wf_median));
  const tied = scores.filter((s) => s.wf_median - best < TIE_MARGIN).map((s) => s.variant);
  tied.sort((a, b) => SIMPLER_ORDER.indexOf(a) - SIMPLER_ORDER.indexOf(b));
  const winner = tied[0]!;
  return {
    scores,
    winner,
    selected_terms: selected,
    n_comps: comps.length,
    n_wf: walkForwardErrors(comps, predictB).length,
    n_blind: 5 * Math.floor(comps.length * 0.25),
  };
}

/** The fitted final model for a winning variant, on the comps given. */
export function fitWinner(comps: Comp[], winner: string, selectedTerms: string[]): FittedModel | MedianMultipleModel {
  if (winner === 'A') return fitMedianMultiple(comps);
  if (winner === 'B') return fitModel(comps, BASE_SPEC);
  if (winner === 'D') return fitModel(comps, { terms: ['growth', 'age', 'chains'], catOffset: false, ridge: true });
  const spec: ModelSpec = {
    terms: selectedTerms.filter((t): t is Term => t === 'growth' || t === 'age' || t === 'chains'),
    catOffset: selectedTerms.includes('category-offset'),
    ridge: false,
  };
  return fitModel(comps, spec);
}

/** Log10 prediction from a fitted winner (either shape) for one protocol's features. */
export function predictWinner(model: FittedModel | MedianMultipleModel, f: Features, tvl: number): number {
  if ('byCat' in model) return predictMedianMultiple(model, f, tvl);
  return predictLog10(model, f);
}

// ---------------------------------------------------------------- board eligibility

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The house watchlist's exclusion categories. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a version marker: a space then V2, v2, 2.0, 2 or the like. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+(\.\d+)?)$/;
/** A whole word wrapped, staked or staking in a name, any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** An exchange's name at the start of a protocol name. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Why a pre-token protocol is kept off the board, or null when it belongs on it. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'category';
  if (VERSIONED.test(p.name)) return 'versioned-name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-word';
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange-prefix';
  return null;
}

// ---------------------------------------------------------------- farm plan

/** The farm plan's named constants, as the dashboard states them. */
export const HORIZON_WEEKS = 12;
export const COMMUNITY_SHARE = 0.05;
export const FARM_HOURS = 6.8;
export const CAPITAL_APR = 0.05;
export const PARTICIPATION: Record<string, number> = {
  Dexs: 0.15,
  Lending: 0.12,
  Derivatives: 0.12,
  Yield: 0.1,
  'Yield Aggregator': 0.1,
  'Risk Curators': 0.06,
  'Onchain Capital Allocator': 0.06,
  RWA: 0.05,
};
export const DEFAULT_PARTICIPATION = 0.08;

export function participationFor(category: string | null): number {
  return category !== null && category in PARTICIPATION ? PARTICIPATION[category]! : DEFAULT_PARTICIPATION;
}

/** The deposit tier from a protocol's TVL. */
export function depositFor(tvl: number): number {
  if (tvl >= 250_000_000) return 5000;
  if (tvl >= 75_000_000) return 2500;
  if (tvl >= 20_000_000) return 1000;
  return 500;
}

/** A row's costed farm plan, netted to the dollar at the low end of its value band. */
export interface FarmPlan {
  deposit: number;
  participation: number;
  competing: number;
  gross_low: number;
  fees: number;
  hours: number;
  capital_cost: number;
  net: number;
  usd_per_hour: number;
  breakeven: number;
  verdict: 'farm' | 'thin' | 'skip';
}

export function farmPlan(p: SnapshotProtocol, p10: number): FarmPlan {
  const deposit = depositFor(p.tvl_usd);
  const participation = participationFor(p.category);
  const competing = participation * p.tvl_usd;
  const gross_low = p10 * COMMUNITY_SHARE * (deposit / (deposit + competing));
  const fees = 10 * p.chains.length + 0.001 * deposit;
  const hours = FARM_HOURS;
  const capital_cost = deposit * CAPITAL_APR * (HORIZON_WEEKS / 52);
  const net = gross_low - fees - capital_cost;
  const usd_per_hour = net / hours;
  const breakeven = (fees + capital_cost) / (COMMUNITY_SHARE * (deposit / (deposit + competing)));
  const verdict: FarmPlan['verdict'] = net >= 200 && usd_per_hour >= 25 ? 'farm' : net > 0 ? 'thin' : 'skip';
  return { deposit, participation, competing, gross_low, fees, hours, capital_cost, net, usd_per_hour, breakeven, verdict };
}

/** Compact dollars: $1.23M, $45.6K, $812. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(a)}`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, deposit: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${deposit} of USDC to ${name} on ${chain} and keep the lending position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${deposit} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('liquidity manager')) return `Deposit $${deposit} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('yield')) return `Deposit $${deposit} into ${name}'s main yield position on ${chain} and keep it open.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('synthetic')) return `Deposit $${deposit} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return `Deposit $${deposit} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('rwa')) return `Mint $${deposit} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('stable') || c.includes('reserve')) return `Mint or deposit $${deposit} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${deposit} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('prediction')) return `Fund $${deposit} and place one market position on ${name}.`;
  if (c.includes('launchpad')) return `Stake $${deposit} into ${name}'s launch allocation on ${chain} and join its sales.`;
  return `Deposit $${deposit} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with its cost and time, embedding the protocol's
 * own numbers (TVL, deposit, low-end value, fees, net, $/hour, break-even). The plan is derived from
 * the protocol's own record, never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, plan: FarmPlan, p10: number, p50: number): string[] {
  const chain = chainOf(p);
  const action = actionFor(p, plan.deposit, chain);
  const verdictLine =
    plan.verdict === 'farm'
      ? `Verdict: farm — the low end already clears the bar, so run the full ${HORIZON_WEEKS}-week plan.`
      : plan.verdict === 'thin'
        ? `Verdict: thin — the low end barely pays, so farm small and only with funds you can leave idle.`
        : `Verdict: skip — at the low end the plan loses money, so wait for a better entry or a bigger share.`;
  const steps = [
    `Set up a fresh wallet holding only the funds you plan to farm, and bridge $${plan.deposit} to ${chain} for ${p.name}. Cost: about $${(10 * p.chains.length).toFixed(0)} of gas across ${p.chains.length} chain${p.chains.length === 1 ? '' : 's'}. Time: 10 minutes.`,
    `${action} Cost: $${plan.deposit} of capital plus about $${(0.001 * plan.deposit).toFixed(0)} of gas. Time: 15 minutes to set up.`,
    `Make one qualifying action each week for ${HORIZON_WEEKS} weeks — a deposit, a swap, a vote or a claim — so the activity is counted in more than one snapshot. Cost: about $2 of gas a week. Time: ${plan.hours} hours over the whole plan.`,
    `At the low end of the value band (${fmtUsd(p10)} implied, vs ${fmtUsd(p50)} at the middle), the community share is worth ${fmtUsd(plan.gross_low)} gross; fees ${fmtUsd(plan.fees)} and capital cost ${fmtUsd(plan.capital_cost)} leave a net of ${fmtUsd(plan.net)}, or ${fmtUsd(plan.usd_per_hour)} an hour. Cost: ${fmtUsd(plan.fees + plan.capital_cost)} all in. Time: ${HORIZON_WEEKS} weeks.`,
    `Break-even needs the token to launch at ${fmtUsd(plan.breakeven)} implied value; below that the plan loses money, above it every extra dollar of value is profit on a $${plan.deposit} deposit against ${fmtUsd(plan.competing)} of competing capital. Cost: nothing to check. Time: 10 minutes.`,
    `${verdictLine} Before you withdraw, open ${p.name}'s own points page from the link it publishes and claim only there — never pay to claim. Cost: no fee to check. Time: 10 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------- board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  implied_value_usd: number;
  implied_p10: number;
  implied_p90: number;
  rank_lo: number;
  rank_hi: number;
  deposit: number;
  gross_low: number;
  fees: number;
  hours: number;
  capital_cost: number;
  net: number;
  usd_per_hour: number;
  breakeven: number;
  verdict: 'farm' | 'thin' | 'skip';
  watchlist: boolean;
  farm_steps: string[];
}

/** How the 758 protocols are accounted for. */
export interface Coverage {
  total: number;
  board: number;
  token_recorded: number;
  excluded: number;
  excluded_by_reason: Record<string, number>;
}

/** Everything the dashboard needs: the board, the model, the validation and the coverage. */
export interface RadarData {
  board_name: string;
  as_of: string;
  source: string;
  floor_usd: number;
  model_name: string;
  model_formula: string;
  winner: string;
  selected_terms: string[];
  variant_scores: VariantScore[];
  n_comps: number;
  n_wf: number;
  n_blind: number;
  watchlist_size: number;
  board_size: number;
  coverage: Coverage;
  verdict_counts: Record<string, number>;
  assumptions: Record<string, unknown>;
  rows: BoardRow[];
}

const BOOTSTRAP_REFITS = 200;
const BOOTSTRAP_SEED = 0x51_67_74;

/**
 * Build the board: fit the winning variant on all comps, bootstrap 200 refits for the p10/p50/p90
 * band and the rank range, rank by the bootstrap median, and cost a farm plan per row.
 */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; validation: ValidationResult } {
  const comps = buildComps(snapshot);
  const validation = evaluateVariants(snapshot, comps);
  const winner = validation.winner;
  const fitted = fitWinner(comps, winner, validation.selected_terms);
  const ages = comps.map((c) => c.age);
  const medianAge = median(ages);

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlistSet = new Set(snapshot.watchlist);

  // Coverage accounting: every protocol is board, token-recorded, or excluded for a named reason.
  const excludedByReason: Record<string, number> = {};
  let tokenRecorded = 0;
  const boardProtocols: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) {
      tokenRecorded++;
      continue;
    }
    const reason = exclusionReason(p);
    if (reason !== null) {
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
      continue;
    }
    boardProtocols.push(p);
  }
  const coverage: Coverage = {
    total: snapshot.protocols.length,
    board: boardProtocols.length,
    token_recorded: tokenRecorded,
    excluded: snapshot.protocols.length - boardProtocols.length - tokenRecorded,
    excluded_by_reason: excludedByReason,
  };

  const feats = boardProtocols.map((p) => featuresOf(p, snapshot.as_of, medianAge));
  const pointLog = feats.map((f, i) => predictWinner(fitted, f, boardProtocols[i]!.tvl_usd));

  // Bootstrap: resample the comps with replacement, refit, predict every board protocol.
  const rng = mulberry32(BOOTSTRAP_SEED);
  const n = boardProtocols.length;
  const bootValues: number[][] = boardProtocols.map(() => []);
  const bootRanks: number[][] = boardProtocols.map(() => []);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const sample: Comp[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const refit = fitWinner(sample, winner, validation.selected_terms);
    const preds = feats.map((f, i) => Math.pow(10, predictWinner(refit, f, boardProtocols[i]!.tvl_usd)));
    for (let i = 0; i < n; i++) bootValues[i]!.push(preds[i]!);
    const order = preds
      .map((v, i) => ({ v, i }))
      .sort((a, b2) => b2.v - a.v || (boardProtocols[a.i]!.slug < boardProtocols[b2.i]!.slug ? -1 : 1));
    order.forEach((o, pos) => bootRanks[o.i]!.push(pos + 1));
  }

  const scored = boardProtocols.map((p, i) => {
    const vals = [...bootValues[i]!].sort((a, b) => a - b);
    const ranks = [...bootRanks[i]!].sort((a, b) => a - b);
    const p10 = quantileSorted(vals, 0.1);
    const p50 = quantileSorted(vals, 0.5);
    const p90 = quantileSorted(vals, 0.9);
    const plan = farmPlan(p, p10);
    return {
      p,
      p10,
      p50,
      p90,
      rank_lo: Math.round(quantileSorted(ranks, 0.1)),
      rank_hi: Math.round(quantileSorted(ranks, 0.9)),
      point: Math.pow(10, pointLog[i]!),
      plan,
    };
  });
  scored.sort((a, b) => b.p50 - a.p50 || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    implied_value_usd: Math.max(1, Math.round(s.p50)),
    implied_p10: Math.max(1, Math.round(s.p10)),
    implied_p90: Math.max(1, Math.round(s.p90)),
    rank_lo: s.rank_lo,
    rank_hi: s.rank_hi,
    deposit: s.plan.deposit,
    gross_low: round2(s.plan.gross_low),
    fees: round2(s.plan.fees),
    hours: s.plan.hours,
    capital_cost: round2(s.plan.capital_cost),
    net: round2(s.plan.net),
    usd_per_hour: round2(s.plan.usd_per_hour),
    breakeven: Math.max(1, Math.round(s.plan.breakeven)),
    verdict: s.plan.verdict,
    watchlist: watchlistSet.has(s.p.slug),
    farm_steps: farmSteps(s.p, s.plan, s.p10, s.p50),
  }));

  // The watchlist is the floor: every slug must be on the board, or the run refuses.
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) throw new SnapshotError(`board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`);
  void index;

  const verdictCounts: Record<string, number> = { farm: 0, thin: 0, skip: 0 };
  for (const r of board) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;

  const formula =
    winner === 'A'
      ? 'implied = TVL x median(mcap/TVL) of its category (global median when fewer than 3 comps)'
      : winner === 'B'
        ? 'log10(implied) = a + b x log10(TVL)'
        : winner === 'D'
          ? 'log10(implied) = ridge(a + b x log10(TVL) + c x growth + d x age + e x chains), standardised, lambda 1e-3'
          : `log10(implied) = a + b x log10(TVL)${validation.selected_terms.includes('growth') ? ' + c x (growth_7d/100)' : ''}${validation.selected_terms.includes('age') ? ' + d x age_years' : ''}${validation.selected_terms.includes('chains') ? ' + e x chains_n' : ''}${validation.selected_terms.includes('category-offset') ? ' + shrunk category offset' : ''}`;

  const radar: RadarData = {
    board_name: 'Sightline',
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_name: `Sightline-${winner}`,
    model_formula: formula,
    winner,
    selected_terms: validation.selected_terms,
    variant_scores: validation.scores,
    n_comps: comps.length,
    n_wf: validation.n_wf,
    n_blind: validation.n_blind,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    coverage,
    verdict_counts: verdictCounts,
    assumptions: {
      horizon_weeks: HORIZON_WEEKS,
      community_share: COMMUNITY_SHARE,
      farm_hours: FARM_HOURS,
      capital_apr: CAPITAL_APR,
      participation: PARTICIPATION,
      default_participation: DEFAULT_PARTICIPATION,
      deposit_tiers: 'TVL >= $250M: $5000; >= $75M: $2500; >= $20M: $1000; else $500',
      fees: '10 x chains_n + 0.001 x deposit',
      capital_cost: 'deposit x 0.05 x 12/52',
      bootstrap_refits: BOOTSTRAP_REFITS,
    },
    rows: board,
  };
  return { board, radar, validation };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
