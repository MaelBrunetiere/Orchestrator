// Tests 0.4.2 (moins de tokens, même qualité) : node --test tests/v042.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../scripts/lib');
const R = require('../scripts/rapport');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const HOOKS = path.join(SCRIPTS, 'hooks.js');
const LOGEVENT = path.join(SCRIPTS, 'log-event.js');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RULES = read('scripts', 'regles-chef.md');
const AGENTS = fs.readdirSync(path.join(ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v042-'));
  const orch = path.join(dir, '.orchestrator');
  fs.mkdirSync(orch);
  const log = (...args) => spawnSync(process.execPath, [LOGEVENT, ...args], { cwd: dir, encoding: 'utf8' });
  const hook = (sub, payload) => spawnSync(process.execPath, [HOOKS, sub], { cwd: dir, encoding: 'utf8', input: JSON.stringify({ cwd: dir, session_id: 's9', ...payload }) });
  const events = () => fs.readFileSync(path.join(orch, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const plan = (mission, taches) => {
    fs.mkdirSync(path.join(orch, 'out', mission), { recursive: true });
    fs.writeFileSync(path.join(orch, 'out', mission, 'plan.json'), JSON.stringify({
      mission: { titre: 'Bonjour dans toutes les langues' },
      branches: [{ id: 'B1', titre: 'Tout' }],
      taches: taches.map(([id, titre, agent = 'dev', modele = 'sonnet', effort = 'medium']) => ({ id, branche: 'B1', titre, agent, modele, effort, justif: 'x' })),
    }));
    return `.orchestrator/out/${mission}/plan.json`;
  };
  return { dir, orch, log, hook, events, plan, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ev = (ts, mission, event, extra = {}) => ({ ts, mission_id: mission, event, agent: 'chef', model: null, task_id: null, summary: null, tokens: null, tokens_source: null, source: 'chef', ...extra });

// Journal d'une mission « bonjour » : écriture, escalade, un refus de hook, relecture.
function journal(m) {
  return [
    ev('2026-10-28T10:00:00.000+01:00', m, 'plan', { mode: 'leger', plan_tasks: 3 }),
    ev('2026-10-28T10:00:05.000+01:00', m, 'worker_start', { agent: 'executant', model: 'claude-haiku-5-5', task_id: 'T1', source: 'hook' }),
    ev('2026-10-28T10:02:00.000+01:00', m, 'worker_fail', { agent: 'executant', model: 'claude-haiku-5-5', task_id: 'T1', summary: 'STATUT: échec | FAIT: fichier incomplet', tokens: 30000, tokens_source: 'mesuré', source: 'hook', tokens_cache_read: 100000 }),
    ev('2026-10-28T10:02:10.000+01:00', m, 'escalate', { model: 'sonnet', task_id: 'T1', summary: 'fichier incomplet' }),
    ev('2026-10-28T10:02:20.000+01:00', m, 'worker_done', { agent: 'dev', model: 'claude-sonnet-5-5', task_id: 'T1', summary: 'STATUT: ok | FAIT: 40 langues écrites', tokens: 103000, tokens_source: 'mesuré', source: 'hook', tokens_cache_read: 545000, fichiers: 'bonjour.md, .orchestrator/out/m1/T1-dev.md (sortie)' }),
    ev('2026-10-28T10:05:00.000+01:00', m, 'blocked', { agent: 'dev', task_id: 'T2', summary: 'shell du chef hors log-event', source: 'hook' }),
    ev('2026-10-28T10:06:00.000+01:00', m, 'worker_start', { agent: 'relecteur', model: 'claude-sonnet-5-5', task_id: 'T3', source: 'hook' }),
    ev('2026-10-28T10:07:00.000+01:00', m, 'worker_done', { agent: 'relecteur', model: 'claude-sonnet-5-5', task_id: 'T3', summary: 'STATUT: ok | FAIT: conforme', tokens: 52000, tokens_source: 'mesuré', source: 'hook', tokens_cache_read: 90000 }),
    ev('2026-10-28T10:07:30.000+01:00', m, 'done', { summary: 'bonjour.md créé', tokens: 128000, tokens_source: 'mesuré', tokens_cache_read: 2100000, tokens_by_model: { 'claude-opus-5-5': 52600, 'claude-sonnet-5-5': 75400 } }),
  ];
}

// --- Point 1 : rapport final par script ---
test('1. rapport : 5 lignes, À faire en premier, titres de plan.json (jamais d\'identifiants), points d\'attention', () => {
  const p = project();
  try {
    p.plan('m1', [['T1', 'Écrire le fichier'], ['T2', 'Vérifier les accents'], ['T3', 'Relecture finale', 'relecteur', 'sonnet', 'high']]);
    const text = R.buildReport({ orch: p.orch, mission: 'm1', evs: journal('m1'), aFaire: '', journal: '.orchestrator/archive/m1.jsonl' });
    const lines = text.trimEnd().split('\n');
    assert.strictEqual(lines.length, 5);
    assert.deepStrictEqual(lines.map(l => l.split(' :')[0]), ['À faire', 'Résultat', 'Attention', 'Fichiers', 'Coût']);
    assert.strictEqual(lines[0], 'À faire : trancher « Vérifier les accents »'); // blocage ouvert → à faire de Maël
    assert.match(lines[1], /^Résultat : bonjour\.md créé — 2\/3 tâches ok, mode léger \(sans conseiller, relecture sonnet\)$/);
    assert.match(lines[2], /Vérifier les accents bloquée : shell du chef hors log-event/);
    assert.match(lines[2], /Écrire le fichier escaladée vers sonnet \(fichier incomplet\)/);
    assert.match(lines[3], /^Fichiers : bonjour\.md ; sorties \.orchestrator\/out\/m1\/, journal \.orchestrator\/archive\/m1\.jsonl$/);
    assert.ok(!/\bT\d+\b|\bA\d+\b|\bB\d+\b/.test(text), 'aucun identifiant de tâche dans le rapport');
    // Coût : tokens des workers (somme mesurée), cache lu, tokens du chef par modèle, durée plan → done
    assert.match(lines[4], /exécution 7 min 30/);
    assert.match(lines[4], /workers 185k \(dev 103k, relecteur 52\,0k, executant 30\,0k\), cache lu 735k/);
    assert.match(lines[4], /chef 128k \(sonnet 75,4k, opus 52,6k\)/);
  } finally { p.clean(); }
});

test('1. rapport : « Rien à faire » et « rien à signaler » quand tout est ok ; --a-faire passe en première ligne', () => {
  const p = project();
  try {
    p.plan('m2', [['T1', 'Écrire le fichier']]);
    const evs = [
      ev('2026-10-28T10:00:00.000+01:00', 'm2', 'plan'),
      ev('2026-10-28T10:01:00.000+01:00', 'm2', 'worker_done', { agent: 'dev', task_id: 'T1', summary: 'STATUT: ok | FAIT: fait', tokens: 1200, source: 'hook' }),
      ev('2026-10-28T10:01:30.000+01:00', 'm2', 'done', { summary: 'fait' }),
    ];
    const clean = R.buildReport({ orch: p.orch, mission: 'm2', evs }).split('\n');
    assert.strictEqual(clean[0], 'À faire : Rien à faire');
    assert.strictEqual(clean[2], 'Attention : rien à signaler');
    assert.match(clean[4], /chef n\/d/);
    const icam = R.buildReport({ orch: p.orch, mission: 'm2', evs, aFaire: 'Rédiger\nla conclusion  du rapport' }).split('\n');
    assert.strictEqual(icam[0], 'À faire : Rédiger la conclusion du rapport');
  } finally { p.clean(); }
});

test('1. rapport : le plafond de 2 workers n\'est pas un point d\'attention ; plus de 3 points → résumé', () => {
  const p = project();
  try {
    p.plan('m3', [['T1', 'Un'], ['T2', 'Deux'], ['T3', 'Trois'], ['T4', 'Quatre']]);
    const evs = [
      ev('2026-10-28T10:00:00.000+01:00', 'm3', 'plan'),
      ev('2026-10-28T10:00:10.000+01:00', 'm3', 'worker_fail', { agent: 'dev', task_id: 'T1', summary: 'lancement refusé : Subagent spawn denied by a plugin: garde-fou : déjà 2 workers de mission en cours (max 2).', source: 'hook' }),
      ...['T1', 'T2', 'T3', 'T4'].map((t, i) => ev(`2026-10-28T10:0${i + 1}:00.000+01:00`, 'm3', 'worker_fail', { agent: 'dev', task_id: t, summary: 'STATUT: échec | FAIT: cassé', source: 'hook' })),
      ev('2026-10-28T10:09:00.000+01:00', 'm3', 'done', { summary: 'raté' }),
    ];
    const att = R.buildReport({ orch: p.orch, mission: 'm3', evs }).split('\n')[2];
    assert.ok(!/déjà 2 workers/.test(att));
    assert.match(att, /Un : échec \(cassé\) ; Deux : échec \(cassé\) ; \+2 autres points/);
    assert.strictEqual(att.split(' ; ').length, 3);
  } finally { p.clean(); }
});

test('1. log-event done écrit et affiche rapport-final.md (0 token), --a-faire inclus, sans agent', () => {
  const p = project();
  try {
    const file = p.plan('m4', [['T1', 'Rédiger le support'], ['T2', 'Relecture finale', 'relecteur', 'opus', 'high']]);
    assert.strictEqual(p.log('plan', '--mission', 'm4', '--mode', 'leger', '--plan-file', file).status, 0);
    fs.appendFileSync(path.join(p.orch, 'events.jsonl'), JSON.stringify(ev('2026-10-28T10:01:00.000+01:00', 'm4', 'worker_done', { agent: 'dev', task_id: 'T1', summary: 'STATUT: ok | FAIT: ok', tokens: 5000, source: 'hook', fichiers: 'support.md' })) + '\n');
    const r = p.log('done', '--mission', 'm4', '--summary', 'support prêt', '--a-faire', 'Rédiger toi-même la conclusion');
    assert.strictEqual(r.status, 0, r.stderr);
    const rapport = fs.readFileSync(path.join(p.orch, 'out', 'm4', 'rapport-final.md'), 'utf8');
    assert.strictEqual(rapport.trimEnd().split('\n').length, 5);
    assert.match(rapport, /^À faire : Rédiger toi-même la conclusion\n/);
    assert.match(rapport, /Résultat : support prêt — 1\/2 tâches ok, mode léger/);
    assert.match(rapport, /Attention : Relecture finale jamais lancée/);
    assert.match(rapport, /Fichiers : support\.md ; sorties \.orchestrator\/out\/m4\/, journal \.orchestrator\/archive\/m4\.jsonl/);
    assert.ok(r.stdout.includes('--- rapport-final.md ---\n' + rapport), 'la sortie de LOG est le rapport (le chef n\'a pas à le relire)');
    assert.ok(fs.existsSync(path.join(p.orch, 'archive', 'm4.jsonl')));
  } finally { p.clean(); }
});

test('1. --a-faire hors done refusé ; un rapport impossible à écrire ne bloque pas le done', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm5');
    assert.match(p.log('review', '--mission', 'm5', '--a-faire', 'x').stderr, /ne va qu'avec done/);
    fs.mkdirSync(path.join(p.orch, 'out'), { recursive: true });
    fs.writeFileSync(path.join(p.orch, 'out', 'm5'), 'un fichier à la place du dossier');
    const r = p.log('done', '--mission', 'm5', '--summary', 'ok');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /AVERTISSEMENT : rapport-final\.md non écrit/);
    assert.ok(fs.existsSync(path.join(p.orch, 'archive', 'm5.jsonl')));
  } finally { p.clean(); }
});

test('1. porte-parole retiré : plus d\'agent, plus de garde-fou, plus de règle « 2 workers » qui le concerne', () => {
  assert.ok(!AGENTS.includes('porte-parole'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'agents', 'porte-parole.md')));
  for (const f of [['scripts', 'lib.js'], ['scripts', 'hooks.js'], ['scripts', 'regles-chef.md'], ['hooks', 'register.ts'], ['skills', 'chef', 'SKILL.md']]) {
    assert.ok(!/porte-parole|spoke/.test(read(...f)), f.join('/'));
  }
  assert.ok(!('porte-parole' in L.EFFORT_DEFAULT));
  assert.match(RULES, /Pas d'agent de rapport/);
  assert.match(RULES, /1re ligne|1re ligne = ce qu'il doit faire|ce qu'il doit faire/); // le contrat de format reste
  assert.match(RULES, /5 lignes maximum au total/);
});

// --- Point 2 : moins d'écritures du chef ---
test('2. STATUT ok + sortie présente : le hook écrit worker_done, aucune ligne review n\'est nécessaire ni écrite', () => {
  const p = project();
  try {
    fs.mkdirSync(path.join(p.orch, 'out', 'mt'), { recursive: true });
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), JSON.stringify(ev('x', 'mt', 'plan')) + '\n');
    fs.writeFileSync(path.join(p.orch, '.agents.json'), JSON.stringify({ agents: { x: { mission_id: 'mt', task_id: 'T1', agent: 'dev', model: 'm', start_logged: true } } }));
    fs.writeFileSync(path.join(p.orch, 'out', 'mt', 'T1-dev.md'), 'sortie');
    const r = p.hook('subagent-stop', { agent_id: 'agent-x', last_assistant_message: 'STATUT: ok\nFAIT: fait\nFICHIERS: src/a.py, .orchestrator/out/mt/T1-dev.md\nDOUTES: aucun' });
    assert.strictEqual(r.status, 0, r.stderr);
    const evs = p.events();
    assert.deepStrictEqual(evs.map(e => e.event), ['plan', 'worker_done']);
    assert.strictEqual(evs[1].source, 'hook');
    assert.match(evs[1].summary, /^STATUT: ok/);
    assert.strictEqual(evs[1].fichiers, 'src/a.py, .orchestrator/out/mt/T1-dev.md');
  } finally { p.clean(); }
});

test('2. le dash ne lit pas review comme un état « relu » : review ne sert qu\'à lever un blocage et aux notes du chef', () => {
  // Vérification de la dépendance (orchestrateur-dash/hooks/journal.ts, non modifié) : voir README 0.4.2.
  const dash = path.join(ROOT, '..', 'orchestrateur-dash', 'hooks', 'journal.ts');
  if (!fs.existsSync(dash)) return;
  const src = fs.readFileSync(dash, 'utf8');
  assert.ok(!/case 'review'/.test(src) && !/'relu'/.test(src), 'le dash a-t-il changé ? revoir la règle 2');
});

test('2. règles : le chef n\'écrit review que pour un vrai jugement', () => {
  assert.match(RULES, /tu n'écris PAS de ligne `review`/);
  assert.match(RULES, /N'écris `LOG review` que pour un vrai jugement : travail à corriger, relance, escalade, décision/);
  assert.match(RULES, /Son verdict ok ne s'écrit pas dans le journal/);
  assert.ok(!/puis `LOG review --mission <id> --task <T> --summary "<verdict>"`/.test(RULES), 'plus de review systématique après le relecteur');
  assert.match(RULES, /Quand Maël a tranché, `LOG review/); // la décision lève encore le blocage du dash
});

// --- Point 3 : moins de lectures, comptes rendus courts ---
test('3. règles : STATUT ok = pas de relecture de la sortie ; lecture par Read, jamais par Bash', () => {
  assert.match(RULES, /Tu NE relis PAS le fichier de sortie/);
  assert.match(RULES, /Tu lis donc avec l'outil Read, jamais avec Bash/);
  assert.match(RULES, /tout autre Bash \(cat, type, ls, node…\) est refusé et te fait perdre un tour/);
  assert.match(RULES, /\(Read, jamais Bash\) seulement si le STATUT n'est pas ok/);
  assert.ok(!/en lisant les fichiers de sortie référencés/.test(RULES), 'l\'ancienne lecture systématique est retirée');
});

test('3. agents : compte rendu de 5 lignes maximum qui pointe vers le fichier de sortie, sans ligne TOKENS', () => {
  for (const a of AGENTS) {
    const md = read('agents', `${a}.md`);
    const block = /## Compte rendu final[\s\S]*?```\n([\s\S]*?)```/.exec(md);
    assert.ok(block, a);
    const lines = block[1].trim().split('\n');
    assert.ok(lines.length <= 5, `${a} : ${lines.length} lignes`);
    assert.match(lines[0], /^STATUT:/, a);
    assert.match(md, /fait 5 lignes maximum/, a);
    assert.match(md, /pointe vers/, a);
    assert.ok(!/10 lignes maximum/.test(md) && !/^TOKENS:/m.test(md), a);
  }
});

test('3. parseReport lit la ligne FICHIERS (livrables du rapport), sans changer STATUT ni summary', () => {
  const r = L.parseReport('STATUT: ok\nFAIT: fait\nFICHIERS: a.md, b/c.py\nDOUTES: aucun');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.summary, 'STATUT: ok | FAIT: fait');
  assert.strictEqual(r.fichiers, 'a.md, b/c.py');
  assert.strictEqual(L.parseReport('STATUT: ok\nFAIT: x').fichiers, null);
});

// --- Point 4 : enchaînement ---
test('4. règles : tâche suivante déjà au plan → lancée dans le même tour, une phrase', () => {
  assert.match(RULES, /Enchaînement : quand un retour est ok et que la tâche suivante est déjà dans plan\.json/);
  assert.match(RULES, /dans CE MÊME tour, avec une seule phrase de commentaire/);
});

// --- Point 5 : SubagentStop ne renvoie rien au chef (non implémenté, voir README) ---
test('5. non implémenté : SubagentStop n\'écrit aucun additionalContext ni decision (il garderait le sous-agent en vie)', () => {
  const p = project();
  try {
    fs.mkdirSync(path.join(p.orch, 'out', 'mt'), { recursive: true });
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), JSON.stringify(ev('x', 'mt', 'plan')) + '\n');
    fs.writeFileSync(path.join(p.orch, '.agents.json'), JSON.stringify({ agents: { x: { mission_id: 'mt', task_id: 'T1', agent: 'dev', model: 'm', start_logged: true } } }));
    fs.writeFileSync(path.join(p.orch, 'out', 'mt', 'T1-dev.md'), 'sortie');
    const r = p.hook('subagent-stop', { agent_id: 'agent-x', last_assistant_message: 'STATUT: ok\nFAIT: fait' });
    assert.strictEqual(r.stdout.trim(), '');
    for (const f of ['scripts/hooks.js', 'scripts/rapport.js']) assert.ok(!/additionalContext/.test(read(...f.split('/'))), f);
  } finally { p.clean(); }
});

// --- Point 6 : petites missions en mode léger par défaut ---
test('6. plan ≤ 3 tâches : le mode choisi est écrit dans la ligne plan et rappelé au chef', () => {
  const p = project();
  try {
    const file = p.plan('pm1', [['T1', 'Un'], ['T2', 'Deux'], ['T3', 'Trois']]);
    const light = p.log('plan', '--mission', 'pm1', '--mode', 'leger', '--plan-file', file);
    assert.strictEqual(light.status, 0, light.stderr);
    assert.strictEqual(p.events()[0].mode, 'leger');
    assert.match(light.stdout, /^mode : léger \(3 tâches\)$/m);
    assert.ok(!/rappel/.test(light.stdout));
    fs.rmSync(path.join(p.orch, 'events.jsonl'));
    const normal = p.log('plan', '--mission', 'pm1', '--mode', 'normal', '--plan-file', file);
    assert.strictEqual(p.events()[0].mode, 'normal', 'normal aussi est écrit dans la ligne plan');
    assert.match(normal.stdout, /^mode : normal \(3 tâches\)$/m);
    assert.match(normal.stdout, /rappel : un plan de 3 tâches ou moins passe en mode léger par défaut, sauf mot « complet »/);
    fs.rmSync(path.join(p.orch, 'events.jsonl'));
    const omitted = p.log('plan', '--mission', 'pm1', '--plan-file', file);
    assert.strictEqual(p.events()[0].mode, 'normal', 'mode omis : normal enregistré, jamais de champ absent');
    assert.match(omitted.stdout, /rappel/);
  } finally { p.clean(); }
});

test('6. plan de 4 tâches : mode normal sans rappel ; sans --plan-file, la ligne plan reste inchangée', () => {
  const p = project();
  try {
    const file = p.plan('pm2', [['T1', 'Un'], ['T2', 'Deux'], ['T3', 'Trois'], ['T4', 'Quatre']]);
    const r = p.log('plan', '--mission', 'pm2', '--mode', 'normal', '--plan-file', file);
    assert.match(r.stdout, /^mode : normal \(4 tâches\)$/m);
    assert.ok(!/rappel/.test(r.stdout));
    fs.rmSync(path.join(p.orch, 'events.jsonl'));
    p.log('plan', '--mission', 'pm2');
    assert.ok(!('mode' in p.events()[0]));
  } finally { p.clean(); }
});

test('6. règles et skill : seuil de 3 tâches, mot « complet », exceptions architecture/sécurité/matériel, message en une ligne', () => {
  assert.match(RULES, /plan de 3 tâches ou moins[\s\S]*?mode léger par défaut, SAUF si la mission touche à l'architecture, la sécurité ou le matériel \(alors mode normal\)/);
  assert.match(RULES, /premier mot `complet` → mode normal/);
  assert.match(RULES, /Tu le dis à Maël en une ligne/);
  const skill = read('skills', 'chef', 'SKILL.md');
  assert.match(skill, /argument-hint: "\[complet\|leger\] <mission>"/);
  assert.match(skill, /premier mot de la mission est `complet`/);
});

// --- Point 7 : effort ---
test('7. effort : medium par défaut pour dev et executant, high seulement pour les rôles à plancher, plancher inchangé', () => {
  const fm = role => /^effort:\s*(\S+)\s*$/m.exec(read('agents', `${role}.md`))[1];
  assert.strictEqual(fm('dev'), 'medium');
  assert.strictEqual(fm('executant'), 'medium');
  assert.strictEqual(L.EFFORT_DEFAULT.dev, 'medium');
  const high = AGENTS.filter(a => fm(a) === 'high').sort();
  assert.deepStrictEqual(high, ['conseiller', 'dev-critique', 'relecteur']);
  for (const r of ['dev-critique', 'relecteur', 'conseiller']) {
    assert.match(L.effortRefusal(r, 'medium'), /ne descend pas sous l'effort high/, r);
  }
  assert.match(L.effortRefusal('dev', 'low'), /ne descend pas sous l'effort medium/);
  assert.strictEqual(L.effortRefusal('dev', 'medium'), null);
  assert.match(RULES, /`medium` par défaut, pour `dev`, `executant` et `explorateur`\. `high` seulement pour l'architecture\/design, la sécurité, le matériel, le conseiller et la relecture finale/);
});

test('7. le hook journalise l\'effort medium d\'un dev lancé sans effort (défaut du frontmatter)', () => {
  const p = project();
  try {
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), JSON.stringify(ev('x', 'mt', 'plan')) + '\n');
    const tool_input = { subagent_type: 'orchestrateur:dev', prompt: '[mission:mt task:T1] x' };
    assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input }).stdout.trim(), '');
    p.hook('post-agent', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input, tool_response: { agentId: 'agent-d', status: 'async_launched' } });
    assert.strictEqual(p.events().find(e => e.event === 'worker_start').effort, 'medium');
  } finally { p.clean(); }
});

// --- Point 8 : règles des workers ---
test('8. workers : une seule écriture de la SORTIE, un seul script de contrôle, pas de vérification refaite', () => {
  for (const a of ['dev', 'dev-critique', 'executant']) {
    const md = read('agents', `${a}.md`);
    assert.match(md, /Écris la SORTIE en UN seul Write/, a);
    assert.match(md, /Lance UN seul script de contrôle/, a);
    assert.match(md, /ne relance pas des vérifications déjà faites/, a);
  }
  for (const a of ['explorateur', 'relecteur', 'conseiller']) {
    const md = read('agents', `${a}.md`);
    assert.match(md, /UN seul Write/, a);
    assert.match(md, /ne refais pas une? vérification déjà faite|ne refais pas des vérifications déjà faites/, a);
  }
});

test('8. code testable : le dev lance le contrôle et rend la sortie brute ; la vérif séparée seulement si indépendante', () => {
  const dev = read('agents', 'dev.md');
  assert.match(dev, /Code testable : tu lances toi-même le contrôle/);
  assert.match(dev, /la sortie brute complète \(stdout et stderr\), puis `RC=<code de retour>`/);
  assert.match(RULES, /par défaut le `dev` le fait lui-même/);
  assert.match(RULES, /Pas de tâche vérif séparée dans ce cas/);
  assert.match(RULES, /seulement quand le contrôle doit être indépendant/);
  assert.match(read('agents', 'relecteur.md'), /sortie brute du dev avec lignes lancées et codes de retour/);
});

// --- Point 10 : langage du chef ---
test('10. règles : le chef désigne les tâches par leur titre, jamais par T1/A1, sauf prompts, journaux et fichiers', () => {
  assert.match(RULES, /Tu désignes toujours une tâche par son TITRE \(celui de plan\.json[^)]*\), jamais par T1, A1, B1…/);
  assert.match(RULES, /Les identifiants restent dans les prompts de workers, les LOG, les journaux et les fichiers/);
  assert.match(RULES, /les comptes rendus des workers peuvent en contenir \(tu les lis, pas Maël\) mais tu ne les répètes pas/);
  assert.match(RULES, /Une ligne par worker terminé au plus : `Écrire le fichier · executant \(haiku\)/);
  assert.ok(!/Une ligne par worker terminé au plus : `T2/.test(RULES), 'l\'ancien exemple avec identifiant est retiré');
  assert.match(read('skills', 'chef', 'SKILL.md'), /par leur titre, jamais par T1, A1/);
});

// --- Point 9 : version ---
test('9. version 0.4.4 dans plugin.json, sections 0.4.2, 0.4.3 et 0.4.4 dans le README', () => {
  assert.strictEqual(JSON.parse(read('.claude-plugin', 'plugin.json')).version, '0.4.4');
  assert.match(read('README.md'), /## 0\.4\.2/);
  assert.match(read('README.md'), /## 0\.4\.3/);
  assert.match(read('README.md'), /## 0\.4\.4/);
});

test('rapport : formats (tokens, durée)', () => {
  assert.strictEqual(R.tokens(52600), '52,6k');
  assert.strictEqual(R.tokens(274000), '274k');
  assert.strictEqual(R.tokens(3300000), '3,3 M');
  assert.strictEqual(R.tokens(950), '950');
  assert.strictEqual(R.duration(915000), '15 min 15');
  assert.strictEqual(R.duration(42000), '42 s');
  assert.strictEqual(R.duration(3900000), '1 h 05');
});
