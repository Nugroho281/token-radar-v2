// Local gate check for a built output directory (default ../out1):
// validates board.json against the snapshot, the dashboard caps and the
// no-network rule, screenshot dimensions/sizes, and the dossier's presence.
// Run: node research/gate-check.mjs [outDir] [snapshot.json]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, '..', 'out1');
const snapshotPath = process.argv[3] ?? join(here, '..', '..', 'token-radar-01-kit', 'input', 'snapshot.json');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// ---- board.json
const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
const rows = board.rows;
check(Array.isArray(rows), 'board.rows is not an array');
check(rows.length >= 100 && rows.length <= 4000, `rows ${rows.length} outside 100..4000`);
const slugs = new Set(snapshot.protocols.map((p) => p.slug));
const seen = new Set();
const ranks = new Set();
for (const r of rows) {
  check(slugs.has(r.slug), `invented slug ${r.slug}`);
  check(!seen.has(r.slug), `duplicate slug ${r.slug}`);
  seen.add(r.slug);
  check(typeof r.name === 'string' && r.name.length > 0, `empty name ${r.slug}`);
  check(Number.isInteger(r.rank) && r.rank > 0, `bad rank ${r.slug}`);
  ranks.add(r.rank);
  check(Number.isInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14, `bad implied ${r.slug}`);
  check(Array.isArray(r.farm_steps) && r.farm_steps.length >= 3 && r.farm_steps.length <= 12, `farm_steps count ${r.slug}`);
  for (const s of r.farm_steps ?? []) {
    const len = s.trim().length;
    check(len >= 20 && len <= 600, `farm step ${len} chars for ${r.slug}: ${s.slice(0, 60)}`);
  }
}
check(ranks.size === rows.length && Math.min(...ranks) === 1 && Math.max(...ranks) === rows.length, 'ranks not exactly 1..N');
const byRank = [...rows].sort((a, b) => a.rank - b.rank);
for (let i = 1; i < byRank.length; i++) check(byRank[i].implied_value_usd <= byRank[i - 1].implied_value_usd, `implied rises at rank ${byRank[i].rank}`);
check(new Set(rows.map((r) => r.implied_value_usd)).size > 1, 'all implied values identical');
for (const slug of snapshot.watchlist) check(seen.has(slug), `watchlist missing ${slug}`);
console.log(`board: ${rows.length} rows, watchlist ${snapshot.watchlist.filter((s) => seen.has(s)).length}/${snapshot.watchlist.length}`);

// ---- dashboard
const dashDir = join(out, 'dashboard');
const dashFiles = readdirSync(dashDir);
check(dashFiles.includes('index.html'), 'dashboard/index.html missing');
const totalBytes = dashFiles.reduce((n, f) => n + statSync(join(dashDir, f)).size, 0);
check(totalBytes < 60_000, `dashboard source ${totalBytes} bytes >= 60000`);
console.log(`dashboard: ${dashFiles.length} files, ${totalBytes} bytes`);
for (const f of dashFiles) {
  const text = readFileSync(join(dashDir, f), 'utf8');
  if (f.endsWith('.css')) check(!/https?:\/\//.test(text), `${f}: URL in CSS`);
  if (f.endsWith('.js')) check(!/(?:import|export|require)[^'"\n]*['"]https?:\/\//.test(text), `${f}: URL in JS import/require`);
  if (f.endsWith('.html')) {
    for (const m of text.matchAll(/<[^>]+\s[\w-]+="([^"]*)"/g)) check(!/https?:\/\//.test(m[1]), `${f}: URL in attribute ${m[1]}`);
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) check(!/https?:\/\//.test(m[1]), `${f}: URL in <style>`);
  }
}

// ---- screenshots
function pngSize(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'jpeg' };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
const shotsDir = join(out, 'screenshots');
const shots = readdirSync(shotsDir).filter((f) => !f.startsWith('.'));
check(shots.length >= 3 && shots.length <= 4, `screenshots count ${shots.length}`);
for (const f of shots) {
  const buf = readFileSync(join(shotsDir, f));
  check(buf.length <= 512 * 1024, `${f}: ${buf.length} bytes > 512 KiB`);
  const dim = pngSize(buf);
  check(dim !== null, `${f}: not a whole PNG/JPEG`);
  if (dim) {
    const long = Math.max(dim.w, dim.h);
    const short = Math.min(dim.w, dim.h);
    check(long <= 1440, `${f}: long side ${long} > 1440`);
    check(short >= 800, `${f}: short side ${short} < 800`);
    console.log(`screenshot ${f}: ${buf.length} bytes, ${dim.w}x${dim.h} ${dim.type}`);
  }
}

// ---- dossier + data.js
check(existsSync(join(out, 'dossier.json')), 'dossier.json missing');
if (existsSync(join(out, 'dossier.json'))) {
  const size = statSync(join(out, 'dossier.json')).size;
  check(size <= 1.5 * 1024 * 1024, `dossier ${size} bytes > 1.5 MiB`);
  console.log(`dossier: ${size} bytes`);
}
check(existsSync(join(out, 'data.js')), 'data.js missing');

if (failures.length > 0) {
  console.error(`GATE FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 30)) console.error(` - ${f}`);
  process.exit(1);
}
console.log('GATE OK');
