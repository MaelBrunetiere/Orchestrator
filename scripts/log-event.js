#!/usr/bin/env node
// Journal du chef. Usage :
//   node log-event.js <plan|escalate|blocked|review|handoff|done> --mission <id> [--task T] [--agent A] [--model M]
//                     [--summary "texte"] [--tokens N --tokens-source mesuré|estimé]
//                     [--mode normal|leger [--sensible oui|non]] [--plan-file .orchestrator/out/<id>/plan.json]   (plan seulement)
//                     [--a-faire "texte"]                                                                         (done seulement)
// Ajoute ts et source lui-même. Avec --plan-file, l'événement plan porte toujours le mode choisi (normal ou leger).
// « done » écrit out/<mission>/rapport-final.md (scripts/rapport.js, sans agent) et l'affiche ; --a-faire est la
// partie « ce que Maël doit rédiger lui-même » d'un livrable Icam noté.
// « done » archive events.jsonl dans .orchestrator/archive/<mission>.jsonl
// et déplace .orchestrator/tmp/<mission>/ (fichiers temporaires des workers de CETTE mission) dans
// .orchestrator/archive/<mission>.tmp/. Les dossiers tmp/ des autres missions ne sont pas touchés.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { writeReport } = require('./rapport');

const EVENTS = ['plan', 'escalate', 'blocked', 'review', 'handoff', 'done'];

// Une erreur lève une exception : le verrou est relâché (finally) avant la sortie.
class Refus extends Error {}
function fail(msg) { throw new Refus(msg); }
process.on('uncaughtException', e => {
  process.stderr.write(`log-event: ${e instanceof Refus ? e.message : e.stack}\n`);
  process.exit(1);
});

const [event, ...rest] = process.argv.slice(2);
// « reprise » n'écrit rien dans le journal : l'appel suffit pour que le hook
// guard enregistre la session comme chef (première action après /handoff).
if (event !== 'reprise' && !EVENTS.includes(event)) fail(`événement « ${event} » invalide, attendu : ${EVENTS.join(' | ')} (ou reprise)`);
const a = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (!k.startsWith('--')) fail(`argument inattendu « ${k} »`);
  a[k.slice(2)] = rest[i + 1];
  i++;
}
if (!a.mission) fail('--mission est obligatoire');
// L'identifiant sert de nom de dossier (tmp/<mission>, archive/<mission>) : pas de séparateur ni de « .. ».
if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(a.mission) || a.mission.includes('..')) fail(`--mission « ${a.mission} » invalide : lettres, chiffres, « . », « _ » et « - » seulement`);
let tokens = null, tokensSource = null;
if (a.tokens !== undefined) {
  tokens = Number(a.tokens);
  if (!Number.isFinite(tokens)) fail('--tokens doit être un nombre');
  tokensSource = (a['tokens-source'] || 'estimé').normalize('NFC');
  if (!['mesuré', 'estimé'].includes(tokensSource)) fail('--tokens-source : mesuré ou estimé');
}

if (a['a-faire'] !== undefined && event !== 'done') fail('--a-faire ne va qu\'avec done');

// --mode / --sensible : propres à plan. Seul le mode léger laisse une trace dans l'événement.
let planExtra = {};
if (a.mode !== undefined || a.sensible !== undefined) {
  if (event !== 'plan') fail('--mode et --sensible ne vont qu\'avec plan');
  const mode = (a.mode || 'normal').normalize('NFC').toLowerCase().replace('é', 'e');
  if (!['normal', 'leger'].includes(mode)) fail('--mode : normal ou leger');
  if (a.sensible !== undefined && !['oui', 'non'].includes(a.sensible)) fail('--sensible : oui ou non');
  if (mode === 'normal' && a.sensible !== undefined) fail('--sensible ne va qu\'avec --mode leger');
  if (mode === 'leger') planExtra = { mode, ...(a.sensible === 'oui' ? { sensible: true } : {}) };
}

const orch = event === 'plan' ? L.ensureOrchDir([process.cwd()]) : L.findOrchDir([process.cwd()]);
if (!orch) fail('aucun dossier .orchestrator/ trouvé depuis ' + process.cwd());

// --plan-file : plan hiérarchique .orchestrator/out/<mission>/plan.json, lu par le tableau de bord pour dessiner l'arbre.
//   {mission:{titre}, branches:[{id,titre}], taches:[{id,branche,titre,agent,modele,effort,justif}]}
// Une mission sans plan.json reste valide. Un plan invalide est refusé en entier, avec toutes ses erreurs.
const PLAN_AGENTS = Object.keys(L.EFFORT_DEFAULT);
const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
function checkPlan(file, mission) {
  const full = path.resolve(process.cwd(), file);
  const rel = path.relative(path.join(orch, 'out', mission).toLowerCase(), full.toLowerCase());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail(`--plan-file doit être sous .orchestrator/out/${mission}/ (reçu : ${file})`);
  let plan;
  try { plan = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { fail(`--plan-file illisible : ${e.code || e.message}`); }
  const errs = [];
  const title = (where, s, max) => {
    if (typeof s !== 'string' || !s.trim()) errs.push(`${where} : titre manquant`);
    else if (words(s) > max) errs.push(`${where} : titre de ${words(s)} mots (max ${max})`);
  };
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(plan)) fail('plan.json invalide : objet attendu');
  title('mission', isObj(plan.mission) ? plan.mission.titre : undefined, 6);
  const branches = Array.isArray(plan.branches) ? plan.branches.filter(isObj) : [];
  const taches = Array.isArray(plan.taches) ? plan.taches.filter(isObj) : [];
  if (!branches.length) errs.push('branches : au moins une branche attendue');
  if (!taches.length) errs.push('taches : au moins une tâche attendue');
  const ids = new Set();
  const uniq = (kind, id) => {
    if (typeof id !== 'string' || !id) errs.push(`${kind} sans id`);
    else if (ids.has(`${kind}:${id}`)) errs.push(`${kind} ${id} en double`);
    else ids.add(`${kind}:${id}`);
  };
  for (const b of branches) { uniq('branche', b.id); title(`branche ${b.id}`, b.titre, 5); }
  for (const t of taches) {
    uniq('tâche', t.id);
    const w = `tâche ${t.id}`;
    title(w, t.titre, 6);
    if (!ids.has(`branche:${t.branche}`)) errs.push(`${w} : branche « ${t.branche} » inconnue`);
    if (!PLAN_AGENTS.includes(t.agent)) errs.push(`${w} : agent « ${t.agent} » inconnu (${PLAN_AGENTS.join(', ')})`);
    if (!['haiku', 'sonnet', 'opus'].includes(t.modele)) errs.push(`${w} : modele « ${t.modele} » invalide (haiku, sonnet, opus)`);
    if (!L.EFFORT_PLAN.includes(t.effort)) errs.push(`${w} : effort « ${t.effort} » invalide (${L.EFFORT_PLAN.join(', ')})`);
    else { const why = L.effortRefusal(t.agent, t.effort); if (why) errs.push(`${w} : ${why}`); }
    if (typeof t.justif !== 'string' || !t.justif.trim()) errs.push(`${w} : justif manquante`);
  }
  if (errs.length) fail(`plan.json invalide :\n- ${errs.join('\n- ')}`);
  return { plan_file: path.relative(orch, full).split(path.sep).join('/'), plan_tasks: taches.length };
}
if (a['plan-file'] !== undefined) {
  if (event !== 'plan') fail('--plan-file ne va qu\'avec plan');
  if (!a['plan-file']) fail('--plan-file : chemin manquant');
  Object.assign(planExtra, checkPlan(a['plan-file'], a.mission));
  if (!planExtra.mode) planExtra.mode = 'normal'; // le mode choisi figure toujours dans la ligne plan d'une mission planifiée
}

L.withLock(orch, () => {
  const current = L.activeMission(orch);
  if (current && current !== '?' && current !== a.mission) fail(`la mission ${current} est encore active (pas de done)`);
  if (!current && event !== 'plan') fail('aucune mission active : commence par plan');
  if (event === 'plan' && !current) {
    // Nouvelle mission (aucune mission active) : le hook guard vient d'inscrire la session qui lance ce plan, la dernière
    // à avoir appelé log-event ; les inscriptions antérieures sont des restes d'une autre mission et sortent du calcul
    // des tokens du chef. Un replan de la mission en cours ne purge rien.
    const chefFile = path.join(orch, '.chef.json');
    const c = L.readJSON(chefFile, {});
    const sids = Array.from(new Set([...(c.sessions || []), ...Object.keys(c.transcripts || {})]));
    if (sids.length > 1) {
      const when = s => Date.parse((c.seen || {})[s]) || Date.parse((c.registered || {})[s]) || 0;
      const keep = sids.reduce((a, b) => (when(b) >= when(a) ? b : a));
      L.writeJSON(chefFile, {
        sessions: [keep], transcripts: { [keep]: (c.transcripts || {})[keep] },
        registered: { [keep]: (c.registered || {})[keep] }, seen: { [keep]: (c.seen || {})[keep] },
      });
    }
  }
  if (event === 'reprise') {
    process.stdout.write(`reprise de ${a.mission} : session enregistrée comme chef\n`);
    return;
  }
  const evs = L.readEvents(orch) || [];
  const seen = evs.filter(e => e.source === 'hook').map(e => e.model);
  let extra = {};
  if (event === 'done' && tokens === null) {
    // Consommation du chef, mesurée dans ses transcripts (enregistrés par le hook guard).
    const plan = evs.find(e => e.event === 'plan');
    const c = L.readJSON(path.join(orch, '.chef.json'), {});
    const u = plan && L.chefUsage(c, { planTs: plan.ts });
    if (u) {
      tokens = u.tokens;
      tokensSource = 'mesuré';
      extra = { tokens_cache_read: u.cacheRead, tokens_by_model: u.byModel };
    }
  }
  // done : on range d'abord les fichiers temporaires des workers (archive/<mission>.tmp/), pour que
  // l'avertissement d'un échec figure dans le summary du done. Un échec ne bloque pas le done.
  let summary = a.summary || null;
  let base = null;
  let warning = null;
  if (event === 'done') {
    const archive = path.join(orch, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    base = path.join(archive, a.mission);
    for (let n = 2; fs.existsSync(`${base}.jsonl`) || fs.existsSync(`${base}.tmp`); n++) base = path.join(archive, `${a.mission}-${n}`);
    const tmpRoot = path.join(orch, 'tmp');
    const tmp = path.join(tmpRoot, a.mission);
    if (fs.existsSync(tmp)) {
      try {
        if (fs.readdirSync(tmp).length) { fs.renameSync(tmp, `${base}.tmp`); process.stdout.write(`tmp archivé : ${base}.tmp\n`); }
        else fs.rmdirSync(tmp);
        try { fs.rmdirSync(tmpRoot); } catch {} // ne part que s'il est vide (aucune autre mission dedans)
      } catch (e) {
        warning = `tmp non archivé (${e.code || e.message}) : .orchestrator/tmp/${a.mission}/ reste en place, à déplacer à la main vers ${base}.tmp`;
        summary = summary ? `${summary} [AVERTISSEMENT : ${warning}]` : `AVERTISSEMENT : ${warning}`;
      }
    }
  }
  L.appendEvent(orch, {
    ts: L.nowISO(), mission_id: a.mission, event, agent: a.agent || 'chef', model: L.fullModelId(a.model, seen),
    task_id: a.task || null, summary, tokens, tokens_source: tokensSource, source: 'chef',
  }, { ...extra, ...planExtra });
  if (event === 'plan' && planExtra.mode) {
    const n = planExtra.plan_tasks;
    process.stdout.write(`mode : ${planExtra.mode === 'leger' ? 'léger' : 'normal'}${n !== undefined ? ` (${n} tâche${n > 1 ? 's' : ''})` : ''}\n`);
    if (planExtra.mode === 'normal' && n !== undefined && n <= 3) {
      process.stdout.write('rappel : un plan de 3 tâches ou moins passe en mode léger par défaut, sauf mot « complet » de Maël ou mission d\'architecture, de sécurité ou de matériel.\n');
    }
  }
  if (event !== 'done') return;
  // Rapport final par script, avant l'archivage : il lit encore events.jsonl, done compris. Un échec ne bloque pas le done.
  let report = null;
  try {
    report = writeReport({ orch, mission: a.mission, evs: L.readEvents(orch) || [], aFaire: a['a-faire'], journal: `.orchestrator/archive/${path.basename(base)}.jsonl` });
  } catch (e) {
    process.stdout.write(`AVERTISSEMENT : rapport-final.md non écrit (${e.code || e.message})\n`);
  }
  const dest = `${base}.jsonl`;
  fs.renameSync(path.join(orch, 'events.jsonl'), dest);
  L.writeJSON(path.join(orch, '.agents.json'), {});
  L.writeJSON(path.join(orch, '.chef.json'), {});
  process.stdout.write(`archivé : ${dest}\n`);
  if (warning) process.stdout.write(`AVERTISSEMENT : ${warning}\n`);
  if (report) process.stdout.write(`--- rapport-final.md ---\n${report}`);
});
