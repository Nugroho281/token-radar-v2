// Token Radar v2 — valuation model, validation harness and farm-plan costing.
//
// Everything in this file is computed from the sealed snapshot at run time:
// traded protocols in the snapshot become the comparable set ("comps"), four
// candidate models are fitted and scored out of sample (a walk-forward
// time-split plus repeated blind holdouts), the winner is refitted on all
// comps, and a 200-refit bootstrap turns each point estimate into a band and
// a rank range. Farm plans are then costed against the low end of the band.
//
// Deterministic by construction: the only randomness is a seeded mulberry32
// stream, and every date comes from the snapshot itself.

// ------------------------------------------------------------------ types

export interface Protocol {
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

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** Model-ready features for one protocol. */
export interface Feats {
  slug: string;
  x: number; // log10(tvl_usd)
  growth: number; // change_7d clipped to [-90, 200], divided by 100
  growthImputed: boolean;
  age: number; // years since listed_at (median of comps when unknown)
  chainsLog: number; // log10(chains.length), at least 0
  cat: string; // category or "(none)"
  tvl: number;
  mcap: number | null;
  listed: string | null; // listed_at, kept for the time-split ordering
}

export type TermName = 'cat' | 'growth' | 'age' | 'chains';
export type VariantId = 'A' | 'B' | 'C' | 'D';

export interface VariantScore {
  id: VariantId;
  label: string;
  wf_median_err: number;
  wf_within2x: number;
  blind_median_err: number;
  blind_within2x: number;
}

export interface FittedModel {
  kind: 'flat' | 'linear' | 'ridge';
  // flat
  catMultiple: Map<string, number>;
  globalMultiple: number;
  // linear (OLS in log-log space, optional extra terms and category offsets)
  coef: number[]; // [intercept, slope, growth?, age?, chains?] in term order below
  terms: TermName[]; // extra terms beyond intercept+slope, in fitting order
  catOffset: Map<string, number>;
  // ridge (standardised features, no category offsets)
  ridgeMean: number[];
  ridgeSd: number[];
  ridgeBeta: number[]; // over [x, growth, age, chainsLog]
  ridgeYMean: number;
}

// ------------------------------------------------------------- farm costs

export const HORIZON_WEEKS = 12;
export const COMMUNITY_SHARE = 0.05;
export const CAPITAL_APR = 0.05;
export const FEE_PER_CHAIN = 10;
export const FEE_DEPOSIT_RATE = 0.001;
export const BASE_HOURS = 2;
export const HOURS_PER_WEEK = 0.4;

/** Share of a protocol's TVL assumed to be actively farming an allocation. */
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
export const PARTICIPATION_DEFAULT = 0.08;

/** Modelled farmer deposit, tiered by the protocol's TVL. */
export function depositFor(tvl: number): number {
  if (tvl >= 250_000_000) return 5_000;
  if (tvl >= 75_000_000) return 2_500;
  if (tvl >= 20_000_000) return 1_000;
  return 500;
}

// ------------------------------------------------------------------- PRNG

/** mulberry32: tiny seeded PRNG so bootstrap and blind splits are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- helpers

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Percentile with linear interpolation between closest ranks. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const at = (p / 100) * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

const DAY_MS = 86_400_000;

function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map((v) => Number(v));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot is missing protocols or watchlist');
  }
  return raw;
}

// ------------------------------------------------------------------ comps

/**
 * The comparable set: protocols whose token already trades (mcap and TVL
 * positive), deduplicated one per ticker — group by gecko_id, falling back
 * to symbol, and keep the largest-TVL record of each group.
 */
export function buildComps(snapshot: Snapshot): Protocol[] {
  const byTicker = new Map<string, Protocol>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const key = p.gecko_id ?? (p.symbol !== null ? `sym:${p.symbol}` : `slug:${p.slug}`);
    const kept = byTicker.get(key);
    if (kept === undefined || p.tvl_usd > kept.tvl_usd) byTicker.set(key, p);
  }
  return [...byTicker.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

/** Median listing age of the comps that carry a listing date. */
export function medianCompAge(comps: Protocol[], asOf: string): number {
  const ages: number[] = [];
  for (const c of comps) {
    if (c.listed_at !== null) ages.push(Math.max(0, (dayMs(asOf) - dayMs(c.listed_at)) / DAY_MS / 365.25));
  }
  return ages.length > 0 ? median(ages) : 0;
}

export function featsOf(p: Protocol, asOf: string, medianAge: number): Feats {
  const imputed = p.change_7d === null;
  const clipped = Math.min(200, Math.max(-90, p.change_7d ?? 0));
  const age =
    p.listed_at !== null ? Math.max(0, (dayMs(asOf) - dayMs(p.listed_at)) / DAY_MS / 365.25) : medianAge;
  return {
    slug: p.slug,
    x: Math.log10(Math.max(1, p.tvl_usd)),
    growth: clipped / 100,
    growthImputed: imputed,
    age,
    chainsLog: Math.log10(Math.max(1, p.chains.length)),
    cat: p.category ?? '(none)',
    tvl: p.tvl_usd,
    mcap: p.mcap_usd,
    listed: p.listed_at,
  };
}

// ------------------------------------------------------------ linear algebra

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!;
    M[col] = M[piv]!;
    M[piv] = tmp;
    const d = M[col]![col]!;
    if (Math.abs(d) < 1e-12) M[col]![col] = d < 0 ? -1e-12 : 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Ordinary least squares for y ~ design rows (first column is the intercept). */
function ols(rows: number[][], y: number[]): number[] {
  const k = rows[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] = b[a]! + rows[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c] = A[a]![c]! + rows[i]![a]! * rows[i]![c]!;
    }
  }
  for (let a = 0; a < k; a++) A[a]![a] = A[a]![a]! + 1e-10;
  return solve(A, b);
}

/** Design row for the linear family: intercept, size, then the kept extra terms. */
function designRow(f: Feats, terms: TermName[]): number[] {
  const row = [1, f.x];
  for (const t of terms) {
    if (t === 'growth') row.push(f.growth);
    else if (t === 'age') row.push(f.age);
    else if (t === 'chains') row.push(f.chainsLog);
  }
  return row;
}

// ---------------------------------------------------------------- fitting

function blankModel(kind: FittedModel['kind']): FittedModel {
  return {
    kind,
    catMultiple: new Map(),
    globalMultiple: 0,
    coef: [],
    terms: [],
    catOffset: new Map(),
    ridgeMean: [],
    ridgeSd: [],
    ridgeBeta: [],
    ridgeYMean: 0,
  };
}

/** Variant A — flat multiple: median mcap/TVL per category, global fallback. */
export function fitFlat(train: Feats[]): FittedModel {
  const m = blankModel('flat');
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const f of train) {
    const ratio = f.mcap! / f.tvl;
    all.push(ratio);
    const arr = byCat.get(f.cat) ?? [];
    arr.push(ratio);
    byCat.set(f.cat, arr);
  }
  m.globalMultiple = median(all);
  for (const [cat, arr] of byCat) if (arr.length >= 3) m.catMultiple.set(cat, median(arr));
  return m;
}

/**
 * Linear family (variants B and C): OLS of log10(mcap) on log10(TVL) plus the
 * kept extra terms; when 'cat' is kept, each category also earns a shrunk
 * offset — n/(n+8) times its mean residual — fitted on the training rows.
 */
export function fitLinear(train: Feats[], terms: TermName[]): FittedModel {
  const m = blankModel('linear');
  const linTerms = terms.filter((t) => t !== 'cat');
  m.terms = [...terms];
  m.coef = ols(
    train.map((f) => designRow(f, linTerms)),
    train.map((f) => Math.log10(f.mcap!)),
  );
  if (terms.includes('cat')) {
    const resid = new Map<string, number[]>();
    for (const f of train) {
      const pred = designRow(f, linTerms).reduce((s, v, i) => s + v * m.coef[i]!, 0);
      const arr = resid.get(f.cat) ?? [];
      arr.push(Math.log10(f.mcap!) - pred);
      resid.set(f.cat, arr);
    }
    for (const [cat, arr] of resid) {
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      m.catOffset.set(cat, (arr.length / (arr.length + 8)) * mean);
    }
  }
  return m;
}

const RIDGE_FEATURES = 4; // x, growth, age, chainsLog
const RIDGE_LAMBDA = 1e-3;

/** Variant D — ridge regression on standardised features, no category offsets. */
export function fitRidge(train: Feats[]): FittedModel {
  const m = blankModel('ridge');
  const raw = train.map((f) => [f.x, f.growth, f.age, f.chainsLog]);
  m.ridgeMean = Array.from({ length: RIDGE_FEATURES }, (_, j) => raw.reduce((s, r) => s + r[j]!, 0) / raw.length);
  m.ridgeSd = Array.from({ length: RIDGE_FEATURES }, (_, j) => {
    const mean = m.ridgeMean[j]!;
    const sd = Math.sqrt(raw.reduce((s, r) => s + (r[j]! - mean) ** 2, 0) / raw.length);
    return sd > 1e-9 ? sd : 1;
  });
  m.ridgeYMean = train.reduce((s, f) => s + Math.log10(f.mcap!), 0) / train.length;
  const k = RIDGE_FEATURES;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < train.length; i++) {
    const z = raw[i]!.map((v, j) => (v - m.ridgeMean[j]!) / m.ridgeSd[j]!);
    const yc = Math.log10(train[i]!.mcap!) - m.ridgeYMean;
    for (let a = 0; a < k; a++) {
      b[a] = b[a]! + z[a]! * yc;
      for (let c = 0; c < k; c++) A[a]![c] = A[a]![c]! + z[a]! * z[c]!;
    }
  }
  for (let a = 0; a < k; a++) A[a]![a] = A[a]![a]! + RIDGE_LAMBDA;
  m.ridgeBeta = solve(A, b);
  return m;
}

/** Predicted implied value in dollars for one protocol's features. */
export function predict(m: FittedModel, f: Feats): number {
  if (m.kind === 'flat') {
    const mult = m.catMultiple.get(f.cat) ?? m.globalMultiple;
    return f.tvl * mult;
  }
  if (m.kind === 'ridge') {
    const raw = [f.x, f.growth, f.age, f.chainsLog];
    let log = m.ridgeYMean;
    for (let j = 0; j < RIDGE_FEATURES; j++) log += m.ridgeBeta[j]! * ((raw[j]! - m.ridgeMean[j]!) / m.ridgeSd[j]!);
    return 10 ** log;
  }
  const linTerms = m.terms.filter((t) => t !== 'cat');
  let log = designRow(f, linTerms).reduce((s, v, i) => s + v * m.coef[i]!, 0);
  if (m.terms.includes('cat')) log += m.catOffset.get(f.cat) ?? 0;
  return 10 ** log;
}

/**
 * Multiplicative breakdown of a prediction against the pure size curve:
 * each kept term's factor, with `base` absorbing everything else so that
 * base × cat × growth × age × chains equals the full-fit prediction.
 */
export function breakdownOf(m: FittedModel, f: Feats, sizeOnly: FittedModel): { base: number; cat: number; growth: number; age: number; chains: number } {
  const full = predict(m, f);
  let cat = 1;
  let growth = 1;
  let age = 1;
  let chains = 1;
  if (m.kind === 'flat') {
    const mult = m.catMultiple.get(f.cat) ?? m.globalMultiple;
    cat = m.globalMultiple > 0 ? mult / m.globalMultiple : 1;
  } else if (m.kind === 'ridge') {
    const raw = [f.x, f.growth, f.age, f.chainsLog];
    const z = raw.map((v, j) => (v - m.ridgeMean[j]!) / m.ridgeSd[j]!);
    growth = 10 ** (m.ridgeBeta[1]! * z[1]!);
    age = 10 ** (m.ridgeBeta[2]! * z[2]!);
    chains = 10 ** (m.ridgeBeta[3]! * z[3]!);
  } else {
    const linTerms = m.terms.filter((t) => t !== 'cat');
    linTerms.forEach((t, i) => {
      const c = m.coef[i + 2]!;
      if (t === 'growth') growth = 10 ** (c * f.growth);
      else if (t === 'age') age = 10 ** (c * f.age);
      else if (t === 'chains') chains = 10 ** (c * f.chainsLog);
    });
    if (m.terms.includes('cat')) cat = 10 ** (m.catOffset.get(f.cat) ?? 0);
  }
  void sizeOnly;
  const rest = cat * growth * age * chains;
  return { base: rest > 0 ? full / rest : full, cat, growth, age, chains };
}

// -------------------------------------------------------------- validation

interface Fold {
  train: Feats[];
  test: Feats[];
}

/**
 * Expanding walk-forward folds over the comps that carry a listing date,
 * ordered oldest first: train 50% → test next 20%; train 70% → test next
 * 15%; train 85% → test the last 15%.
 */
function timeSplitFolds(comps: Feats[]): Fold[] {
  const dated = comps
    .filter((f) => f.listed !== null)
    .sort((a, b) => (a.listed! < b.listed! ? -1 : a.listed! > b.listed! ? 1 : a.slug < b.slug ? -1 : 1));
  const n = dated.length;
  const c1 = Math.floor(0.5 * n);
  const c2 = Math.floor(0.7 * n);
  const c3 = Math.floor(0.85 * n);
  return [
    { train: dated.slice(0, c1), test: dated.slice(c1, c2) },
    { train: dated.slice(0, c2), test: dated.slice(c2, c3) },
    { train: dated.slice(0, c3), test: dated.slice(c3) },
  ].filter((f) => f.train.length >= 8 && f.test.length > 0);
}

/** Five seeded random 75/25 holdouts over all comps. */
function blindFolds(comps: Feats[]): Fold[] {
  const folds: Fold[] = [];
  for (let s = 0; s < 5; s++) {
    const rng = mulberry32(90_001 + s * 7_919);
    const idx = comps.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = idx[i]!;
      idx[i] = idx[j]!;
      idx[j] = tmp;
    }
    const cut = Math.floor(0.75 * idx.length);
    folds.push({
      train: idx.slice(0, cut).map((i) => comps[i]!),
      test: idx.slice(cut).map((i) => comps[i]!),
    });
  }
  return folds;
}

type FitFn = (train: Feats[]) => FittedModel;

function scoreFolds(fit: FitFn, folds: Fold[]): { medianErr: number; within2x: number; n: number } {
  const errs: number[] = [];
  for (const fold of folds) {
    const model = fit(fold.train);
    for (const f of fold.test) {
      const pred = predict(model, f);
      if (pred > 0 && f.mcap !== null && f.mcap > 0) errs.push(Math.abs(Math.log10(pred / f.mcap)));
    }
  }
  const within = errs.filter((e) => e <= Math.log10(2)).length;
  return { medianErr: median(errs), within2x: errs.length > 0 ? within / errs.length : 0, n: errs.length };
}

const TERM_ORDER: TermName[] = ['cat', 'growth', 'age', 'chains'];

/**
 * Variant C term selection: start from the plain size curve and try adding
 * one term at a time; a term stays only when the walk-forward time-split
 * median error improves by at least 0.005.
 */
export function selectTermsC(comps: Feats[]): TermName[] {
  const folds = timeSplitFolds(comps);
  let kept: TermName[] = [];
  let best = scoreFolds((tr) => fitLinear(tr, kept), folds).medianErr;
  for (const term of TERM_ORDER) {
    const candidate = [...kept, term];
    const score = scoreFolds((tr) => fitLinear(tr, candidate), folds).medianErr;
    if (best - score >= 0.005) {
      kept = candidate;
      best = score;
    }
  }
  return kept;
}

export interface ValidationResult {
  scores: VariantScore[];
  winner: VariantId;
  termsKept: TermName[];
  wfTestN: number;
}

const VARIANT_LABELS: Record<VariantId, string> = {
  A: 'Flat multiple — median mcap/TVL per category',
  B: 'Size curve — log-log OLS on TVL',
  C: 'Size curve + terms kept by walk-forward selection',
  D: 'Ridge — standardised multi-factor, no category offsets',
};

/** Score all four variants on both validation protocols and pick the winner. */
export function validateVariants(comps: Feats[]): ValidationResult {
  const wf = timeSplitFolds(comps);
  const blind = blindFolds(comps);
  const termsKept = selectTermsC(comps);
  const fits: Record<VariantId, FitFn> = {
    A: (tr) => fitFlat(tr),
    B: (tr) => fitLinear(tr, []),
    C: (tr) => fitLinear(tr, termsKept),
    D: (tr) => fitRidge(tr),
  };
  const scores: VariantScore[] = (Object.keys(fits) as VariantId[]).map((id) => {
    const w = scoreFolds(fits[id], wf);
    const b = scoreFolds(fits[id], blind);
    return {
      id,
      label: VARIANT_LABELS[id],
      wf_median_err: w.medianErr,
      wf_within2x: w.within2x,
      blind_median_err: b.medianErr,
      blind_within2x: b.within2x,
    };
  });
  // Lowest walk-forward median error wins; a gap under 0.01 is a tie and the
  // simpler variant takes it (simplicity order A < B < D < C).
  const simplicity: VariantId[] = ['A', 'B', 'D', 'C'];
  const minErr = Math.min(...scores.map((s) => s.wf_median_err));
  const winner = simplicity.find((id) => scores.find((s) => s.id === id)!.wf_median_err <= minErr + 0.01) ?? 'B';
  return { scores, winner, termsKept, wfTestN: wf.reduce((n, f) => n + f.test.length, 0) };
}

/** Fit the winning variant on a (possibly resampled) comp set. */
export function fitWinner(id: VariantId, termsKept: TermName[], train: Feats[]): FittedModel {
  if (id === 'A') return fitFlat(train);
  if (id === 'D') return fitRidge(train);
  if (id === 'C') return fitLinear(train, termsKept);
  return fitLinear(train, []);
}

export function formulaText(id: VariantId, model: FittedModel): string {
  if (id === 'A') return 'implied = TVL × median(mcap/TVL of the protocol category among traded comps)';
  if (id === 'D') return 'log10(mcap) = ridge over standardised [log10(TVL), growth/100, age in years, log10(chains)]';
  const parts = ['log10(mcap) = a + b·log10(TVL)'];
  const lin = model.terms.filter((t) => t !== 'cat');
  for (const t of lin) {
    if (t === 'growth') parts.push('c·(7d growth/100)');
    else if (t === 'age') parts.push('d·(age in years)');
    else if (t === 'chains') parts.push('e·log10(chains)');
  }
  if (model.terms.includes('cat')) parts.push('shrunk category offset n/(n+8)·mean residual');
  return parts.join(' + ');
}


// --------------------------------------------------------------- board set

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(?:[Vv]\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/;
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;

export type ExclusionReason = 'category' | 'version-name' | 'wrapped-word' | 'exchange-name';

/**
 * Why a tokenless protocol is kept off the board, or null when it belongs on
 * it. Mirrors the house watchlist rule without its TVL floor: wrapped,
 * staked and bridged products of traded tokens, exchange products, bridge
 * and staking categories, and versioned re-launches are not launch radar
 * subjects.
 */
export function exclusionReason(p: Protocol): ExclusionReason | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'category';
  if (VERSION_SUFFIX.test(p.name)) return 'version-name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-word';
  for (const ex of EXCHANGE_PREFIXES) {
    if (p.name === ex || p.name.startsWith(`${ex} `) || p.name.startsWith(`${ex}-`)) return 'exchange-name';
  }
  return null;
}

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// --------------------------------------------------------------- farm plan

export interface FarmCalc {
  deposit: number;
  competing: number;
  farmerShare: number;
  grossLow: number;
  fees: number;
  capitalCost: number;
  hours: number;
  net: number;
  usdPerHour: number;
  breakEven: number;
  verdict: 'farm' | 'thin' | 'skip';
}

/**
 * Cost one farm plan against the low end of the value band: a 5% community
 * allocation, shared with the category's assumed farming participation,
 * minus per-chain fees, a deposit fee and the capital cost of the deposit.
 */
export function farmCalc(p: Protocol, impliedP10: number): FarmCalc {
  const deposit = depositFor(p.tvl_usd);
  const participation = PARTICIPATION[p.category ?? ''] ?? PARTICIPATION_DEFAULT;
  const competing = p.tvl_usd * participation;
  const farmerShare = deposit / (deposit + competing);
  const grossLow = impliedP10 * COMMUNITY_SHARE * farmerShare;
  const chainsN = Math.max(1, p.chains.length);
  const fees = FEE_PER_CHAIN * chainsN + FEE_DEPOSIT_RATE * deposit;
  const capitalCost = deposit * CAPITAL_APR * (HORIZON_WEEKS / 52);
  const hours = BASE_HOURS + HOURS_PER_WEEK * HORIZON_WEEKS;
  const net = grossLow - fees - capitalCost;
  const usdPerHour = net / hours;
  const breakEven = (fees + capitalCost) / (COMMUNITY_SHARE * farmerShare);
  const verdict: FarmCalc['verdict'] = net >= 200 && usdPerHour >= 25 ? 'farm' : net > 0 ? 'thin' : 'skip';
  return { deposit, competing, farmerShare, grossLow, fees, capitalCost, hours, net, usdPerHour, breakEven, verdict };
}

const money = (n: number): string =>
  `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** Category-specific middle steps: what the farmer actually does each week. */
function actionSteps(p: Protocol): [string, string] {
  const cat = p.category ?? '';
  const chain = p.chains[0] ?? 'its main chain';
  switch (cat) {
    case 'Dexs':
      return [
        `Trade on ${p.name} every week: route swaps through its pools on ${chain} so the wallet builds a real trading history, not one-off volume.`,
        `Add a two-sided liquidity position in its busiest pool and keep it in range; rebalance weekly and record the fees the position actually earns.`,
      ];
    case 'Lending':
      return [
        `Supply the deposit as collateral on ${p.name} (${chain}) and leave it supplied; a supplied balance that never moves earns nothing here.`,
        `Run a conservative borrow loop: borrow at most 40% against the supply, re-supply the borrowed asset, and keep the health factor above 2 at all times.`,
      ];
    case 'Derivatives':
      return [
        `Trade perpetuals on ${p.name} with small size: open and close modest positions weekly so the account shows consistent, genuine trading activity.`,
        `Keep total open notional under the deposit, avoid liquidation by holding margin above 50%, and log every fee paid so the plan's cost stays honest.`,
      ];
    case 'Yield':
    case 'Yield Aggregator':
      return [
        `Deposit the full amount into ${p.name}'s flagship vault on ${chain} and hold the vault shares untouched for the whole horizon.`,
        `Check the vault weekly: confirm the strategy has not changed, skim nothing, and only exit early if the vault announces a migration or a pause.`,
      ];
    case 'RWA':
      return [
        `Complete ${p.name}'s onboarding and identity checks first, then deposit into its flagship real-world-asset product on ${chain}.`,
        `Hold the position for the full horizon and keep every onboarding document; RWA allocations reward verified, patient accounts over churn.`,
      ];
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return [
        `Allocate the deposit into a curated vault on ${p.name} (${chain}) run by an established curator, and keep the vault shares for the full horizon.`,
        `Review the curator's allocations weekly; move only if the curator exits a market entirely, since churn costs gas without adding history.`,
      ];
    default:
      return [
        `Use ${p.name}'s core product on ${chain} every week with the deposit: real, repeated usage is what a launch snapshot can see.`,
        `Take part in its governance and community programmes when they open, and keep records of each action with dates and transaction hashes.`,
      ];
  }
}

/** Five to seven concrete steps, each carrying this protocol's own numbers. */
export function farmSteps(p: Protocol, calc: FarmCalc, band: { p10: number; p50: number }, asOf: string): string[] {
  const chainsN = Math.max(1, p.chains.length);
  const [act1, act2] = actionSteps(p);
  return [
    `Set up before ${asOf}: connect a fresh wallet on ${p.chains[0] ?? 'the main chain'}, fund it with the modelled ${money(calc.deposit)} deposit plus a gas buffer, and bookmark ${p.name}'s official app.`,
    act1,
    act2,
    `Carry the position for ${HORIZON_WEEKS} weeks: budget ${money(calc.fees)} in gas and fees across ${chainsN} chain${chainsN === 1 ? '' : 's'} plus ${money(calc.capitalCost)} of capital cost at 5% APR on the deposit.`,
    `Know the low end: at the band's low estimate of ${money(band.p10)} (median ${money(band.p50)}), a 5% community allocation at your modelled share pays about ${money(calc.grossLow)} gross.`,
    `Verdict ${calc.verdict}: net after costs is ${money(calc.net)}, about $${calc.usdPerHour.toFixed(2)} per hour over ${calc.hours.toFixed(1)} hours; stop if the implied value drops under the ${money(calc.breakEven)} break-even.`,
  ];
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface RadarRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change_7d: number | null;
  listed_at: string | null;
  no_token_days: number | null;
  watchlist: boolean;
  implied_p10: number;
  implied_p50: number;
  implied_p90: number;
  rank: number;
  rank_lo: number;
  rank_hi: number;
  deposit: number;
  gross_low: number;
  fees: number;
  capital_cost: number;
  net: number;
  usd_per_hour: number;
  break_even: number;
  verdict: string;
  breakdown: { base: number; cat_factor: number; growth_factor: number; age_factor: number; chains_factor: number };
  farm_steps: string[];
}

export interface Radar {
  meta: {
    as_of: string;
    snapshot_total: number;
    comps_n: number;
    board_n: number;
    anchors_n: number;
    excluded: { total: number; by_reason: Record<string, number> };
    model: {
      name: string;
      formula_text: string;
      terms_kept: string[];
      variants: VariantScore[];
      bootstrap_refits: number;
      assumptions: Record<string, unknown>;
    };
  };
  rows: RadarRow[];
}

const BOOTSTRAP_REFITS = 200;
const BOOTSTRAP_SEED = 424_242;

/** Build the whole radar: validate, fit, bootstrap, cost, rank. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const compsRaw = buildComps(snapshot);
  const medAge = medianCompAge(compsRaw, snapshot.as_of);
  const comps = compsRaw.map((p) => featsOf(p, snapshot.as_of, medAge));
  const validation = validateVariants(comps);
  const full = fitWinner(validation.winner, validation.termsKept, comps);
  const sizeOnly = fitLinear(comps, []);

  // Board set: tokenless protocols minus the house-style exclusions.
  const watch = new Set(snapshot.watchlist);
  const byReason: Record<string, number> = {};
  let excludedTotal = 0;
  let anchors = 0;
  const boardProtocols: Protocol[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) {
      anchors++;
      continue;
    }
    const reason = exclusionReason(p);
    if (reason !== null) {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      excludedTotal++;
      continue;
    }
    boardProtocols.push(p);
  }

  // Bootstrap: refit the winner on resampled comps, reprice and re-rank.
  const rng = mulberry32(BOOTSTRAP_SEED);
  const boardFeats = boardProtocols.map((p) => featsOf(p, snapshot.as_of, medAge));
  const samples: number[][] = boardProtocols.map(() => []);
  const rankSamples: number[][] = boardProtocols.map(() => []);
  for (let r = 0; r < BOOTSTRAP_REFITS; r++) {
    const resample: Feats[] = [];
    for (let i = 0; i < comps.length; i++) resample.push(comps[Math.floor(rng() * comps.length)]!);
    const refit = fitWinner(validation.winner, validation.termsKept, resample);
    const values = boardFeats.map((f) => predict(refit, f));
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v || a.i - b.i);
    order.forEach((o, pos) => rankSamples[o.i]!.push(pos + 1));
    values.forEach((v, i) => samples[i]!.push(v));
  }

  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

  const rows: RadarRow[] = boardProtocols.map((p, i) => {
    const f = boardFeats[i]!;
    const p10 = percentile(samples[i]!, 10);
    const p50 = percentile(samples[i]!, 50);
    const p90 = percentile(samples[i]!, 90);
    const calc = farmCalc(p, p10);
    const bd = breakdownOf(full, f, sizeOnly);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      no_token_days: p.listed_at !== null ? Math.max(0, Math.round((dayMs(snapshot.as_of) - dayMs(p.listed_at)) / DAY_MS)) : null,
      watchlist: watch.has(p.slug),
      implied_p10: Math.round(p10),
      implied_p50: Math.round(p50),
      implied_p90: Math.round(p90),
      rank: 0,
      rank_lo: Math.round(percentile(rankSamples[i]!, 10)),
      rank_hi: Math.round(percentile(rankSamples[i]!, 90)),
      deposit: calc.deposit,
      gross_low: Math.round(calc.grossLow),
      fees: Math.round(calc.fees),
      capital_cost: Math.round(calc.capitalCost),
      net: Math.round(calc.net),
      usd_per_hour: round2(calc.usdPerHour),
      break_even: Math.round(calc.breakEven),
      verdict: calc.verdict,
      breakdown: {
        base: Math.round(bd.base),
        cat_factor: round4(bd.cat),
        growth_factor: round4(bd.growth),
        age_factor: round4(bd.age),
        chains_factor: round4(bd.chains),
      },
      farm_steps: farmSteps(p, calc, { p10, p50 }, snapshot.as_of),
    };
  });

  rows.sort((a, b) => b.implied_p50 - a.implied_p50 || (a.slug < b.slug ? -1 : 1));
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  const board: BoardRow[] = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_p50,
    farm_steps: r.farm_steps,
  }));

  const radar: Radar = {
    meta: {
      as_of: snapshot.as_of,
      snapshot_total: snapshot.protocols.length,
      comps_n: comps.length,
      board_n: rows.length,
      anchors_n: anchors,
      excluded: { total: excludedTotal, by_reason: byReason },
      model: {
        name: `Variant ${validation.winner} — ${VARIANT_LABELS[validation.winner]}`,
        formula_text: formulaText(validation.winner, full),
        terms_kept: validation.winner === 'C' ? validation.termsKept : [],
        variants: validation.scores.map((s) => ({
          ...s,
          wf_median_err: round4(s.wf_median_err),
          wf_within2x: round4(s.wf_within2x),
          blind_median_err: round4(s.blind_median_err),
          blind_within2x: round4(s.blind_within2x),
        })),
        bootstrap_refits: BOOTSTRAP_REFITS,
        assumptions: {
          horizon_weeks: HORIZON_WEEKS,
          community_share: COMMUNITY_SHARE,
          capital_apr: CAPITAL_APR,
          fee_per_chain: FEE_PER_CHAIN,
          fee_deposit_rate: FEE_DEPOSIT_RATE,
          hours: BASE_HOURS + HOURS_PER_WEEK * HORIZON_WEEKS,
          participation: { ...PARTICIPATION, default: PARTICIPATION_DEFAULT },
          deposit_tiers: [
            { min_tvl: 250_000_000, deposit: 5_000 },
            { min_tvl: 75_000_000, deposit: 2_500 },
            { min_tvl: 20_000_000, deposit: 1_000 },
            { min_tvl: 0, deposit: 500 },
          ],
        },
      },
    },
    rows,
  };
  return { board, radar };
}

/** A gate-shaped self-check: returns the first problem found, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  let prev = Number.POSITIVE_INFINITY;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (const row of board) {
    if (!slugs.has(row.slug)) return `invented slug ${row.slug}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (!row.name) return `empty name for ${row.slug}`;
    if (!Number.isInteger(row.rank) || row.rank <= 0 || ranks.has(row.rank)) return `bad rank for ${row.slug}`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14)
      return `bad implied value for ${row.slug}`;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12)
      return `farm_steps count for ${row.slug}`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `farm step of ${len} chars for ${row.slug}`;
    }
  }
  for (const row of byRank) {
    if (row.implied_value_usd > prev) return 'implied value rises as rank ascends';
    prev = row.implied_value_usd;
  }
  if (ranks.size !== board.length || Math.max(...ranks) !== board.length) return 'ranks are not exactly 1..N';
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'all implied values are the same';
  return null;
}
