// Sightline dashboard: renders window.RADAR (written by main.ts beside this
// page as ../data.js). No framework, no network. Hash routes: #p=<slug>
// opens a protocol's detail, #cat=<category> applies the category filter.

const R = window.RADAR;
const meta = R.meta;
const rows = R.rows;
const main = document.getElementById('board');

const state = { q: '', cat: '', verdict: '', watch: false, sort: 'value', detail: null };

function money(n) {
  if (n === null || n === undefined) return '—';
  const neg = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${neg}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${neg}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${neg}$${(a / 1e3).toFixed(1)}K`;
  return `${neg}$${a.toFixed(0)}`;
}
function moneyFull(n) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function variantRow(v) {
  const win = meta.model.name.startsWith(`Variant ${v.id}`);
  return `<tr class="${win ? 'winner' : ''}"><td class="l"><b>${v.id}</b> — ${esc(v.label)}${win ? ' · selected' : ''}</td>` +
    `<td class="num">${v.wf_median_err.toFixed(3)}</td><td class="num">${pct(v.wf_within2x)}</td>` +
    `<td class="num">${v.blind_median_err.toFixed(3)}</td><td class="num">${pct(v.blind_within2x)}</td></tr>`;
}

function validationPanel() {
  const a = meta.model.variants.find((v) => v.id === 'A');
  const win = meta.model.variants.find((v) => meta.model.name.startsWith(`Variant ${v.id}`));
  const terms = meta.model.terms_kept.length
    ? `Terms the walk-forward selection kept for variant C: <b>${meta.model.terms_kept.join(', ')}</b>. A term stayed only if it cut the time-split median error by at least 0.005.`
    : 'Variant C kept no extra term under the 0.005 improvement rule.';
  return `<section class="panel"><h2>Model validation — tested out of sample, not in sample</h2>
  <p>Four candidate models were fitted on the snapshot's ${meta.comps_n} traded comps and scored two ways:
  an expanding walk-forward time-split ordered by listing date (3 folds), and five seeded blind 75/25 holdouts.
  The winner was picked on walk-forward median |log10 error|; a gap under 0.01 counts as a tie for the simpler model.
  Winner <b>${esc(meta.model.name)}</b> scores ${win.wf_median_err.toFixed(3)} walk-forward against the flat multiple's ${a.wf_median_err.toFixed(3)}.
  ${terms}</p>
  <table><thead><tr><th class="l">Variant</th><th>WF median err</th><th>WF within 2×</th><th>Blind median err</th><th>Blind within 2×</th></tr></thead>
  <tbody>${meta.model.variants.map(variantRow).join('')}</tbody></table>
  <p>Every value band and rank range on this board comes from ${meta.model.bootstrap_refits} bootstrap refits of the winning model on resampled comps.</p></section>`;
}

function categories() {
  return [...new Set(rows.map((r) => r.category ?? '(none)'))].sort();
}

function filtered() {
  let out = rows.filter((r) =>
    (state.cat === '' || (r.category ?? '(none)') === state.cat) &&
    (state.verdict === '' || r.verdict === state.verdict) &&
    (!state.watch || r.watchlist) &&
    (state.q === '' || `${r.name} ${r.slug}`.toLowerCase().includes(state.q.toLowerCase())));
  const by = {
    value: (a, b) => b.implied_p50 - a.implied_p50,
    tvl: (a, b) => b.tvl - a.tvl,
    net: (a, b) => b.net - a.net,
    uph: (a, b) => b.usd_per_hour - a.usd_per_hour,
    range: (a, b) => (a.rank_hi - a.rank_lo) - (b.rank_hi - b.rank_lo),
  };
  return out.sort(by[state.sort] ?? by.value);
}

function rowHtml(r) {
  return `<tr class="click" data-slug="${esc(r.slug)}"><td class="num">${r.rank}<div class="rankrange">${r.rank_lo}–${r.rank_hi}</div></td>` +
    `<td class="l"><b>${esc(r.name)}</b> ${r.watchlist ? '<span class="watch">WATCHLIST</span>' : ''}<div class="band">${esc(r.slug)}</div></td>` +
    `<td class="l hideS">${esc(r.category ?? '(none)')}</td><td class="num">${money(r.tvl)}</td>` +
    `<td class="num"><b>${money(r.implied_p50)}</b><div class="band">${money(r.implied_p10)} – ${money(r.implied_p90)}</div></td>` +
    `<td class="num">${money(r.net)}</td><td><span class="badge ${r.verdict}">${r.verdict}</span></td></tr>`;
}

function detailHtml(r) {
  const b = r.breakdown;
  const factor = (label, v) => `<div class="factor"><span>${label}</span><span>×${v.toFixed(3)}</span></div>`;
  return `<section class="detail" id="detail"><button class="close" id="closeDetail">Close</button>
  <h2>${esc(r.name)}</h2>
  <p class="sub">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.join(', '))} · TVL ${moneyFull(r.tvl)}` +
  `${r.change_7d !== null ? ` · 7d change ${r.change_7d.toFixed(1)}%` : ''}` +
  `${r.no_token_days !== null ? ` · records no token for ${r.no_token_days} days (listed ${esc(r.listed_at)})` : ' · no listing date recorded'}${r.watchlist ? ' · on the house watchlist' : ''}</p>
  <div class="grid">
    <div><h3>How the value is built</h3>
      <div class="factor"><span>Size-curve base</span><span>${moneyFull(b.base)}</span></div>
      ${factor('Category factor', b.cat_factor)}${factor('Growth factor', b.growth_factor)}
      ${factor('Age factor', b.age_factor)}${factor('Chains factor', b.chains_factor)}
      <p>Bootstrap band (200 refits): <b>${money(r.implied_p10)} – ${money(r.implied_p90)}</b>, median ${money(r.implied_p50)}.
      Rank ${r.rank} of ${meta.board_n}, rank range ${r.rank_lo}–${r.rank_hi}.</p></div>
    <div><h3>Farm plan, netted</h3>
      <p>Deposit ${moneyFull(r.deposit)} for ${meta.model.assumptions.horizon_weeks} weeks.
      Gross at the band's low end ${moneyFull(r.gross_low)}, minus fees ${moneyFull(r.fees)} and capital cost ${moneyFull(r.capital_cost)}:
      <b>net ${moneyFull(r.net)}</b>, $${r.usd_per_hour.toFixed(2)}/hour, break-even implied value ${moneyFull(r.break_even)}.
      Verdict: <span class="badge ${r.verdict}">${r.verdict}</span></p></div>
    <div><h3>Steps</h3><ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>
  </div></section>`;
}

function methodology() {
  const ex = meta.excluded.by_reason;
  const reasonText = Object.entries(ex).map(([k, v]) => `${v} ${k}`).join(', ');
  const a = meta.model.assumptions;
  return `<section class="panel method"><h2>Methodology</h2>
  <p><b>Model.</b> <code>${esc(meta.model.formula_text)}</code>, fitted on ${meta.comps_n} traded comps — one per ticker
  (largest TVL per gecko id), each with market cap and TVL above zero — taken from this same snapshot, never from outside data.</p>
  <p><b>Validation.</b> Walk-forward time-split (train on the oldest 50%, test the next 20%; then 70/15 and 85/15) plus five seeded
  blind 75/25 holdouts; the metric is median |log10(predicted / actual)| with the share landing within a factor of two.
  Term selection kept a term only when the walk-forward score improved by 0.005 or more. Bands and rank ranges come from
  ${meta.model.bootstrap_refits} bootstrap refits, seeded, so two runs of the program write identical bytes.</p>
  <p><b>Farm plans.</b> Each plan assumes a ${a.horizon_weeks}-week horizon, a ${(a.community_share * 100).toFixed(0)}% community allocation
  valued at the low end of the band, category farming participation, a $${a.fee_per_chain} fee per chain plus 0.1% of the deposit,
  capital at ${(a.capital_apr * 100).toFixed(0)}% APR and ${a.hours} hours of work. Net = gross − fees − capital cost;
  verdict farm needs net ≥ $200 and ≥ $25/hour, thin is any positive net, otherwise skip.</p>
  <p><b>Coverage.</b> All ${meta.snapshot_total} snapshot protocols are accounted for: ${meta.board_n} pre-token protocols on this board,
  ${meta.anchors_n} protocols that record a token (${meta.comps_n} of them trade with a market cap and form the fitted comps), and
  ${meta.excluded.total} tokenless protocols excluded as wrapped, staked, bridged or exchange products (${reasonText}).
  The house watchlist is covered ${rows.filter((r) => r.watchlist).length}/40.</p></section>`;
}

function render() {
  const list = filtered();
  const detail = state.detail ? rows.find((r) => r.slug === state.detail) : null;
  const win = meta.model.variants.find((v) => meta.model.name.startsWith(`Variant ${v.id}`));
  const flat = meta.model.variants.find((v) => v.id === 'A');
  main.innerHTML = `
  <header class="top"><h1>Sightline <span class="rad">/ pre-token radar</span></h1>
  <p class="tagline">Every protocol that records no token, priced by a model <b>fitted on the tokens that already trade</b> in the same snapshot —
  kept only because it survived a walk-forward time-split and a blind holdout — with a farm plan netted to the dollar on every row.
  Snapshot as of ${esc(meta.as_of)}.</p></header>
  <div class="kpis">
    <div class="kpi"><b>${meta.board_n}</b><span>protocols priced</span></div>
    <div class="kpi"><b>${meta.comps_n}</b><span>traded comps anchors</span></div>
    <div class="kpi"><b>${win.wf_median_err.toFixed(3)} vs ${flat.wf_median_err.toFixed(3)}</b><span>walk-forward error, winner vs flat</span></div>
    <div class="kpi"><b>${rows.filter((r) => r.watchlist).length}/40</b><span>watchlist covered</span></div>
    <div class="kpi"><b>${rows.filter((r) => r.verdict === 'farm').length}</b><span>plans verdict farm</span></div>
  </div>
  ${detail ? detailHtml(detail) : ''}
  ${validationPanel()}
  <div class="controls">
    <input type="search" id="q" placeholder="Search name or slug" value="${esc(state.q)}">
    <select id="cat"><option value="">All categories</option>${categories().map((c) => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="verdict"><option value="">Any verdict</option>${['farm', 'thin', 'skip'].map((v) => `<option ${v === state.verdict ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label><input type="checkbox" id="watch" ${state.watch ? 'checked' : ''}> Watchlist only</label>
    <label>Sort <select id="sort">${[['value', 'Implied value'], ['tvl', 'TVL'], ['net', 'Net $'], ['uph', '$/hour'], ['range', 'Narrowest rank range']].map(([k, l]) => `<option value="${k}" ${k === state.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span class="band">${list.length} of ${meta.board_n} rows</span>
  </div>
  <table><thead><tr><th>Rank</th><th class="l">Protocol</th><th class="l hideS">Category</th><th>TVL</th><th>Implied p50 (band)</th><th>Net $</th><th>Verdict</th></tr></thead>
  <tbody>${list.map(rowHtml).join('')}</tbody></table>
  ${methodology()}
  <footer>Implied values are this board's own model output, not a prediction that a token will launch. Farm at your own risk.</footer>`;
  main.setAttribute('aria-busy', 'false');
  bind();
}

function bind() {
  const q = document.getElementById('q');
  q.addEventListener('input', () => { state.q = q.value; refreshTable(); });
  document.getElementById('cat').addEventListener('change', (e) => { state.cat = e.target.value; refreshTable(); });
  document.getElementById('verdict').addEventListener('change', (e) => { state.verdict = e.target.value; refreshTable(); });
  document.getElementById('watch').addEventListener('change', (e) => { state.watch = e.target.checked; refreshTable(); });
  document.getElementById('sort').addEventListener('change', (e) => { state.sort = e.target.value; refreshTable(); });
  const close = document.getElementById('closeDetail');
  if (close) close.addEventListener('click', () => { state.detail = null; try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file URLs */ } render(); });
}

function refreshTable() { render(); const q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }

document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr.click');
  if (tr) { location.hash = `p=${tr.dataset.slug}`; }
});

function applyHash() {
  const h = location.hash.slice(1);
  const params = new URLSearchParams(h);
  if (params.has('p')) { state.detail = params.get('p'); }
  else if (params.has('cat')) { state.cat = params.get('cat'); state.detail = null; }
  render();
}
window.addEventListener('hashchange', applyHash);
applyHash();
