// Bake-off for Token Radar v2: fit the four candidate models on the snapshot's
// traded comps and score each one out of sample, twice over — an expanding
// walk-forward time-split ordered by listing date, and five seeded blind
// 75/25 holdouts. Run: node research/bakeoff.mjs [path/to/snapshot.json]
// Writes research/variant-results.json and prints a summary table.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildComps,
  featsOf,
  medianCompAge,
  parseSnapshot,
  selectTermsC,
  validateVariants,
} from '../lib/model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath =
  process.argv[2] ?? join(here, '..', '..', 'token-radar-01-kit', 'input', 'snapshot.json');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const compsRaw = buildComps(snapshot);
const medAge = medianCompAge(compsRaw, snapshot.as_of);
const comps = compsRaw.map((p) => featsOf(p, snapshot.as_of, medAge));

const rawComps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0).length;
const imputed = comps.filter((f) => f.growthImputed).length;
const dated = comps.filter((f) => f.listed !== null).length;

const result = validateVariants(comps);
const termsKept = selectTermsC(comps);

const out = {
  as_of: snapshot.as_of,
  snapshot_total: snapshot.protocols.length,
  raw_comps: rawComps,
  comps_final: comps.length,
  comps_with_listed_at: dated,
  comps_growth_imputed: imputed,
  median_comp_age_years: medAge,
  terms_kept_for_C: termsKept,
  winner: result.winner,
  wf_test_predictions: result.wfTestN,
  variants: result.scores,
};
writeFileSync(join(here, 'variant-results.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log(`snapshot ${snapshot.as_of}: ${snapshot.protocols.length} protocols, raw comps ${rawComps}, deduped comps ${comps.length} (${dated} dated, ${imputed} growth-imputed)`);
console.log('variant  wf_med_err  wf_within2x  blind_med_err  blind_within2x');
for (const s of result.scores) {
  console.log(
    `${s.id}        ${s.wf_median_err.toFixed(4)}      ${(s.wf_within2x * 100).toFixed(1)}%        ${s.blind_median_err.toFixed(4)}         ${(s.blind_within2x * 100).toFixed(1)}%`,
  );
}
console.log(`terms kept by C selection: [${termsKept.join(', ')}]`);
console.log(`winner: ${result.winner}`);
