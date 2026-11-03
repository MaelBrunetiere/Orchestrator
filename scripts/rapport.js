// Rapport final d'une mission, sans agent : lit events.jsonl + plan.json et écrit out/<mission>/rapport-final.md.
// Appelé par `log-event done` (0 token). Usage direct : node rapport.js --mission <id> [--a-faire "texte"]
// Cinq lignes, la 1re est ce que Maël doit faire :
//   À faire / Résultat / Attention / Fichiers / Coût
// Les tâches sont désignées par leur titre (plan.json), jamais par leur identifiant.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const one = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (one(s).length > n ? one(s).slice(0, n - 1) + '…' : one(s));
const fr = x => String(x).replace('.', ',');

function tokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/d';
  if (n >= 1e6) return `${fr((n / 1e6).toFixed(1))} M`;
  if (n >= 1e5) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${fr((n / 1e3).toFixed(1))}k`;
  return String(n);
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'durée inconnue';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

const modelTier = m => (/(haiku|sonnet|opus|fable)/i.exec(m || '') || [null, null])[1];
const isCapRefusal = e => e.event === 'worker_fail' && /^lancement refusé : .*déjà \d+ workers/.test(e.summary || '');
const isLaunchRefusal = e => e.event === 'worker_fail' && /^lancement refusé/.test(e.summary || '');

// Chemins de livrables lus dans les lignes FICHIERS des workers (hors .orchestrator/).
function deliverables(evs) {
  const seen = new Set();
  for (const e of evs) {
    if (!['worker_done', 'worker_fail'].includes(e.event) || !e.fichiers) continue;
    for (let tok of String(e.fichiers).split(/[,;]/)) {
      tok = tok.replace(/\([^)]*\)?\s*$/, '').replace(/^[\s`'"*-]+|[\s`'"*]+$/g, '').replace(/\\/g, '/');
      if (!tok || tok.length > 200 || !/[/.]/.test(tok) || /^\.?\/?\.orchestrator\//.test(tok)) continue;
      seen.add(tok);
    }
  }
  return [...seen];
}

// Construit les cinq lignes. evs = événements du journal (toute mission confondue), aFaire = texte libre du chef.
function buildReport({ orch, mission, evs, aFaire, journal }) {
  const mine = evs.filter(e => e.mission_id === mission);
  const planFile = path.join(orch, 'out', mission, 'plan.json');
  const plan = L.readJSON(planFile, null);
  const titles = new Map(((plan && Array.isArray(plan.taches)) ? plan.taches : []).map(t => [t.id, t.titre]));
  const titre = id => titles.get(id) || (/^A\d+$/.test(id || '') ? 'avis du conseiller' : id || 'tâche inconnue');

  // État par tâche, dans l'ordre du journal.
  const tasks = new Map();
  const row = id => { if (!tasks.has(id)) tasks.set(id, { id, final: null, cause: '', fails: 0, escalations: [], blocked: [], open: null }); return tasks.get(id); };
  for (const e of mine) {
    if (!e.task_id) continue;
    const r = row(e.task_id);
    if (e.event !== 'blocked') r.open = null; // un blocage tombe à l'événement suivant de la même tâche (comme le dash)
    if (e.event === 'worker_done' || (e.event === 'worker_fail' && !isLaunchRefusal(e))) {
      const m = /^STATUT: (ok|partiel|échec)/.exec(e.summary || '');
      r.final = e.event === 'worker_fail' ? 'échec' : m ? m[1] : 'illisible';
      r.cause = cut(((/\| FAIT: (.*)$/.exec(e.summary || '') || [])[1]) || e.summary, 90);
      if (e.event === 'worker_fail') r.fails++;
    } else if (isLaunchRefusal(e) && !isCapRefusal(e)) {
      r.fails++;
      r.cause = cut(e.summary.replace(/^lancement refusé : (Subagent spawn denied by a plugin: )?/, ''), 90);
    } else if (e.event === 'escalate') {
      r.escalations.push({ model: modelTier(e.model) || e.model, cause: cut(e.summary, 70) });
    } else if (e.event === 'blocked') {
      const b = { motif: cut(e.summary, 90) };
      r.blocked.push(b);
      r.open = b;
    }
  }

  const planned = [...titles.keys()];
  const scope = planned.length ? planned : [...tasks.keys()].filter(id => !/^A\d+$/.test(id));
  const okCount = scope.filter(id => (tasks.get(id) || {}).final === 'ok').length;
  const openBlocked = [...tasks.values()].filter(r => r.open);

  // Attention : blocages encore ouverts, tâches non abouties, puis incidents rattrapés (escalade, échec, blocage levé).
  const items = [];
  for (const r of openBlocked) items.push(`${titre(r.id)} bloquée : ${r.open.motif}`);
  for (const id of scope) {
    const r = tasks.get(id);
    if (r && r.open) continue;
    if (!r) items.push(`${titre(id)} jamais lancée`);
    else if (r.final === null) items.push(`${titre(id)} jamais terminée`);
    else if (r.final !== 'ok') items.push(`${titre(id)} : ${r.final}${r.cause ? ` (${r.cause})` : ''}`);
  }
  for (const r of tasks.values()) {
    if (r.open || (scope.includes(r.id) && r.final !== 'ok')) continue;
    const parts = [];
    const esc = r.escalations[r.escalations.length - 1];
    if (esc) parts.push(`escaladée vers ${esc.model} (${esc.cause})`);
    else if (r.fails) parts.push(`relancée après échec${r.cause ? ` (${r.cause})` : ''}`);
    if (r.blocked.length) parts.push(`blocage levé :${r.blocked[r.blocked.length - 1].motif}`);
    if (parts.length) items.push(`${titre(r.id)} ${parts.join(', ')}`);
  }
  const shown = items.length > 3 ? [...items.slice(0, 2), `+${items.length - 2} autres points (journal)`] : items;

  // À faire : le texte du chef (livrable Icam noté), puis les blocages à trancher.
  const todo = [one(aFaire), ...openBlocked.map(r => `trancher « ${titre(r.id)} »`)].filter(Boolean);

  // Résultat : synthèse du chef, tâches abouties, mode.
  const done = [...mine].reverse().find(e => e.event === 'done');
  const plans = mine.filter(e => e.event === 'plan');
  const planEv = plans[plans.length - 1] || {};
  const reviewers = mine.filter(e => e.agent === 'relecteur' && e.model && ['worker_start', 'worker_done'].includes(e.event));
  const relModel = reviewers.length ? modelTier(reviewers[reviewers.length - 1].model) : null;
  const mode = planEv.mode === 'leger'
    ? `, mode léger (sans conseiller${relModel ? `, relecture ${relModel}` : ''})`
    : '';
  const resume = cut((done && done.summary) || 'mission terminée', 160);
  const total = scope.length ? `${okCount}/${scope.length} tâches ok` : 'aucune tâche au plan';

  // Fichiers : livrables cités par les workers, puis le dossier des sorties.
  const files = deliverables(mine);
  const fshown = files.length > 8 ? [...files.slice(0, 8), `+${files.length - 8}`] : files;
  const outputs = `sorties .orchestrator/out/${mission}/${journal ? `, journal ${journal}` : ''}`;

  // Coût : durée plan→fin, tokens mesurés des workers (par rôle) et du chef.
  const start = plans.length ? Date.parse(plans[0].ts) : Date.parse((mine[0] || {}).ts);
  const end = done ? Date.parse(done.ts) : Date.parse((mine[mine.length - 1] || {}).ts);
  const ends = mine.filter(e => ['worker_done', 'worker_fail'].includes(e.event) && typeof e.tokens === 'number');
  const byRole = new Map();
  let wTokens = 0, wCache = 0;
  for (const e of ends) {
    wTokens += e.tokens;
    wCache += e.tokens_cache_read || 0;
    byRole.set(e.agent, (byRole.get(e.agent) || 0) + e.tokens);
  }
  const roles = [...byRole].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, t]) => `${a} ${tokens(t)}`).join(', ');
  const chefBy = done && done.tokens_by_model
    ? Object.entries(done.tokens_by_model).sort((a, b) => b[1] - a[1]).map(([m, t]) => `${modelTier(m) || m} ${tokens(t)}`).join(', ')
    : '';
  const chef = done && typeof done.tokens === 'number' ? `${tokens(done.tokens)}${chefBy ? ` (${chefBy})` : ''}` : 'n/d';
  const cout = `exécution ${duration(end - start)} ; workers ${tokens(wTokens)}${roles ? ` (${roles})` : ''}, cache lu ${tokens(wCache)} ; chef ${chef}`;

  return [
    `À faire : ${todo.length ? todo.join(' ; ') : 'Rien à faire'}`,
    `Résultat : ${resume} — ${total}${mode}`,
    `Attention : ${shown.length ? shown.join(' ; ') : 'rien à signaler'}`,
    `Fichiers : ${fshown.length ? fshown.join(', ') + ' ; ' : ''}${outputs}`,
    `Coût : ${cout}`,
  ].join('\n') + '\n';
}

// Écrit out/<mission>/rapport-final.md et renvoie son texte.
function writeReport(opts) {
  const text = buildReport(opts);
  const dir = path.join(opts.orch, 'out', opts.mission);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rapport-final.md'), text);
  return text;
}

module.exports = { buildReport, writeReport, tokens, duration };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const mission = get('mission');
  const orch = L.findOrchDir([process.cwd()]);
  if (!mission || !orch) { process.stderr.write('usage : node rapport.js --mission <id> [--a-faire "texte"] (depuis la racine du projet)\n'); process.exit(1); }
  const evs = L.readEvents(orch) || [];
  process.stdout.write(writeReport({ orch, mission, evs, aFaire: get('a-faire') }));
}
