// Token Radar v2 — entry point (Node 22, standard library only).
//
// Reads the sealed snapshot (--input <file|dir>, default /input), builds the
// radar with lib/model.ts — comps fitted from the snapshot's own traded
// tokens, four candidate models scored out of sample, the winner refitted
// and bootstrapped — then writes board.json and data.js to the output
// directory, copies dashboard/ and screenshots/ beside them, and writes
// dossier.json last with the vendored buildDossier, exactly as the scorer
// will rebuild it. Two runs over the same snapshot write the same bytes:
// the model seeds its own PRNG and takes every date from the snapshot.
//
// Local run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** Read `--name value` or `--name=value` from argv, else the fallback. */
function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = readArg('input', '/input');
const snapshotFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(`token-radar-v2: no snapshot at ${snapshotFile} — pass --input <snapshot.json|dir>\n`);
  process.exit(2);
}
const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token-radar-v2: refusing to write a board the gate rejects: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

/** Copy a flat directory of regular files, skipping dotfiles. */
function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    names.push(name);
  }
  return names;
}

const dashFiles = copyFlat(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyFlat(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token-radar-v2: screenshots/ holds ${shots.length} files — the board, a detail and a filtered view are required\n`);
  process.exit(1);
}

// Dossier last: it is rebuilt from the dashboard and screenshots just copied.
const dossier = buildDossier(outDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

process.stdout.write(
  `token-radar-v2: ${snapshot.protocols.length} protocols, ${radar.meta.comps_n} comps, ${board.length} board rows, watchlist ${snapshot.watchlist.length}/${snapshot.watchlist.length}\n` +
    `token-radar-v2: model ${radar.meta.model.name}; wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shots.length}) and dossier.json to ${outDir}\n`,
);
