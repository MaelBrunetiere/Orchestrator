// Tests 0.4.0 : effort, plan.json (--plan-file) : node --test tests/effort.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../scripts/lib');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const HOOKS = path.join(SCRIPTS, 'hooks.js');
const LOGEVENT = path.join(SCRIPTS, 'log-event.js');

// Projet jetable avec une mission « mt » active.
function project({ plan = true, agents } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-effort-'));
  const orch = path.join(dir, '.orchestrator');
  fs.mkdirSync(orch);
  if (agents) fs.writeFileSync(path.join(orch, '.agents.json'), JSON.stringify(agents));
  if (plan) fs.writeFileSync(path.join(orch, 'events.jsonl'), JSON.stringify({ ts: 'x', mission_id: 'mt', event: 'plan', source: 'chef' }) + '\n');
  const hook = (sub, payload) => {
    const r = spawnSync(process.execPath, [HOOKS, sub], { cwd: dir, encoding: 'utf8', input: JSON.stringify({ cwd: dir, session_id: 's9', ...payload }) });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const log = (...args) => spawnSync(process.execPath, [LOGEVENT, ...args], { cwd: dir, encoding: 'utf8' });
  const events = () => { try { return fs.readFileSync(path.join(orch, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const state = () => JSON.parse(fs.readFileSync(path.join(orch, '.agents.json'), 'utf8'));
  return { dir, orch, hook, log, events, state, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- lib : plancher d'effort ---
test('effortRefusal : plancher high pour dev-critique, relecteur et conseiller, medium pour les autres', () => {
  for (const r of ['dev-critique', 'relecteur', 'conseiller']) {
    assert.match(L.effortRefusal(r, 'medium'), /ne descend pas sous l'effort high/, r);
    assert.match(L.effortRefusal(r, 'low'), /high/, r);
    for (const ok of ['high', 'xhigh', 'max', 'HIGH']) assert.strictEqual(L.effortRefusal(r, ok), null, `${r} ${ok}`);
  }
  for (const r of ['explorateur', 'executant', 'dev']) {
    assert.match(L.effortRefusal(r, 'low'), /ne descend pas sous l'effort medium/, r);
    assert.strictEqual(L.effortRefusal(r, 'medium'), null, r);
  }
  assert.match(L.effortRefusal('dev', 'turbo'), /non reconnu/);
});

// 0.4.4 : plafond. La règle « dev reste en medium » (regles-chef.md §1) était du texte : le chef l'a ignorée (T1/T1b en high).
test('effortRefusal : plafond medium pour dev, executant et explorateur ; high et au-delà permis aux autres', () => {
  for (const r of ['explorateur', 'executant', 'dev']) {
    for (const e of ['high', 'xhigh', 'max', 'HIGH']) assert.match(L.effortRefusal(r, e), /reste en effort medium.*dev-critique/, `${r} ${e}`);
    assert.strictEqual(L.effortRefusal(r, 'medium'), null, r);
  }
  for (const r of ['dev-critique', 'relecteur', 'conseiller']) assert.strictEqual(L.effortRefusal(r, 'high'), null, r);
});

test('effortRefusal : effort absent (le frontmatter s\'applique) ou agent hors mode chef → accepté', () => {
  assert.strictEqual(L.effortRefusal('relecteur', undefined), null);
  assert.strictEqual(L.effortRefusal('relecteur', null), null);
  assert.strictEqual(L.effortRefusal('general-purpose', 'low'), null);
});

test('le champ effort de chaque agent = EFFORT_DEFAULT, jamais sous le plancher', () => {
  const dir = path.join(__dirname, '..', 'agents');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  assert.deepStrictEqual(files.map(f => f.replace(/\.md$/, '')).sort(), Object.keys(L.EFFORT_DEFAULT).sort());
  for (const f of files) {
    const role = f.replace(/\.md$/, '');
    const effort = /^effort:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(effort, `${f} : effort manquant`);
    assert.strictEqual(effort[1], L.EFFORT_DEFAULT[role], role);
    assert.strictEqual(L.effortRefusal(role, effort[1]), null, `${role} : défaut sous le plancher`);
  }
});

test('register.ts et lib.js ont les mêmes agents, modèles et planchers', () => {
  const ts = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'register.ts'), 'utf8');
  const roles = [...ts.slice(ts.indexOf('const DEFAULTS'), ts.indexOf('const EFFORTS')).matchAll(/^\s*'?([a-z-]+)'?: '(haiku|sonnet|opus)',?$/gm)];
  assert.deepStrictEqual(roles.map(m => m[1]).sort(), Object.keys(L.EFFORT_DEFAULT).sort());
  assert.match(ts, /const EFFORT_HIGH_ONLY = \['dev-critique', 'relecteur', 'conseiller'\]/);
  assert.match(ts, /const EFFORTS = \['low', 'medium', 'high', 'xhigh', 'max'\]/);
  assert.deepStrictEqual(L.EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const r of ['dev-critique', 'relecteur', 'conseiller']) assert.strictEqual(L.effortFloor(r), 'high');
});

test('findOutput : plus de raccourci rapport-final.md (le rapport est écrit par un script, pas par un agent)', () => {
  const orch = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-find-'));
  try {
    fs.mkdirSync(path.join(orch, 'out', 'm1'), { recursive: true });
    fs.writeFileSync(path.join(orch, 'out', 'm1', 'rapport-final.md'), 'x');
    assert.strictEqual(L.findOutput(orch, 'm1', 'T9', 'dev'), null);
    fs.writeFileSync(path.join(orch, 'out', 'm1', 'T9-dev.md'), 'x');
    assert.strictEqual(L.findOutput(orch, 'm1', 'T9', 'dev'), path.join(orch, 'out', 'm1', 'T9-dev.md'));
  } finally { fs.rmSync(orch, { recursive: true, force: true }); }
});

// --- PreToolUse(Agent) ---
const spawnInput = (type, effort, task = 'T7') => ({ subagent_type: type, ...(effort ? { effort } : {}), prompt: `[mission:mt task:${task}] x` });

test('pre-agent : effort sous le plancher → refus « garde-fou : » et événement blocked', () => {
  const p = project();
  try {
    for (const [type, effort] of [['orchestrateur:relecteur', 'medium'], ['dev-critique', 'low'], ['orchestrateur:conseiller', 'medium'], ['orchestrateur:dev', 'low']]) {
      const out = p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: `tu_${type}`, tool_input: spawnInput(type, effort) });
      assert.strictEqual(out.permissionDecision, 'deny', type);
      assert.match(out.permissionDecisionReason, /^garde-fou : .*ne descend pas sous l'effort (high|medium)/, type);
    }
    const blocked = p.events().filter(e => e.event === 'blocked');
    assert.strictEqual(blocked.length, 4);
    assert.strictEqual(blocked[0].agent, 'relecteur');
    assert.strictEqual(blocked[0].task_id, 'T7');
    assert.strictEqual(blocked[0].tool, 'Agent');
    assert.strictEqual(blocked[0].source, 'hook');
    assert.match(blocked[0].summary, /^lancement refusé par le garde-fou : relecteur ne descend pas sous l'effort high/);
    assert.ok(!fs.existsSync(path.join(p.orch, '.agents.json')), 'un lancement refusé ne laisse pas de pending');
  } finally { p.clean(); }
});

test('pre-agent : dev en high → refus « garde-fou : » (plafond medium), journalisé blocked', () => {
  const p = project();
  try {
    const out = p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_dh', tool_input: spawnInput('orchestrateur:dev', 'high', 'T1') });
    assert.strictEqual(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^garde-fou : dev reste en effort medium/);
    assert.strictEqual(p.events().filter(e => e.event === 'blocked').length, 1);
    assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_dm', tool_input: spawnInput('orchestrateur:dev', 'medium', 'T1') }), null);
  } finally { p.clean(); }
});

test('pre-agent : effort suffisant ou absent accepté ; effort journalisé dans .agents.json et worker_start', () => {
  const p = project();
  try {
    assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_a', tool_input: spawnInput('orchestrateur:relecteur', 'xhigh', 'T8') }), null);
    assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_b', tool_input: spawnInput('orchestrateur:dev-critique', null, 'T9') }), null);
    assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_c', tool_input: { subagent_type: 'general-purpose', effort: 'low', prompt: 'sans balise' } }), null);
    const st = p.state();
    assert.strictEqual(st.pending.tu_a.effort, 'xhigh');
    assert.strictEqual(st.pending.tu_b.effort, 'high', 'défaut du frontmatter');
    assert.ok(!st.pending.tu_c);
    p.hook('post-agent', { tool_name: 'Agent', tool_use_id: 'tu_a', tool_input: spawnInput('orchestrateur:relecteur', 'xhigh', 'T8'), tool_response: { agentId: 'agent-r1', status: 'async_launched' } });
    const start = p.events().find(e => e.event === 'worker_start');
    assert.strictEqual(start.effort, 'xhigh');
    assert.strictEqual(start.task_id, 'T8');
    assert.strictEqual(p.state().agents.r1.effort, 'xhigh');
  } finally { p.clean(); }
});

test('effort absent : accepté, et worker_start enregistre l\'effort par défaut du frontmatter (jamais undefined)', () => {
  const p = project();
  try {
    const dir = path.join(__dirname, '..', 'agents');
    const fm = role => /^effort:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(dir, `${role}.md`), 'utf8'))[1];
    const roles = ['explorateur', 'executant', 'dev', 'dev-critique', 'relecteur', 'conseiller'];
    roles.forEach((role, i) => {
      const tool_input = spawnInput(`orchestrateur:${role}`, null, `T${i + 1}`);
      assert.strictEqual(p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: `tu_${i}`, tool_input }), null, role);
      p.hook('post-agent', { tool_name: 'Agent', tool_use_id: `tu_${i}`, tool_input, tool_response: { agentId: `agent-w${i}`, status: 'async_launched' } });
    });
    const starts = p.events().filter(e => e.event === 'worker_start');
    assert.strictEqual(starts.length, roles.length);
    starts.forEach((ev, i) => {
      assert.strictEqual(ev.effort, fm(roles[i]), roles[i]);
      assert.ok(['medium', 'high'].includes(ev.effort) && ev.effort !== 'undefined', roles[i]);
    });
    assert.ok(!JSON.stringify(p.state()).includes('undefined'));
    // sans pre-agent (repli de post-agent) : même défaut
    p.hook('post-agent', { tool_name: 'Agent', tool_use_id: 'tu_solo', tool_input: spawnInput('orchestrateur:dev', null, 'T99'), tool_response: { agentId: 'agent-solo', status: 'async_launched' } });
    assert.strictEqual(p.events().filter(e => e.event === 'worker_start').pop().effort, fm('dev'));
  } finally { p.clean(); }
});

test('post-agent-fail : un refus d\'effort déjà journalisé par pre-agent ne l\'est pas deux fois', () => {
  const p = project();
  try {
    const tool_input = spawnInput('orchestrateur:relecteur', 'low');
    p.hook('pre-agent', { tool_name: 'Agent', tool_use_id: 'tu_dup', tool_input });
    p.hook('post-agent-fail', { tool_use_id: 'tu_dup', tool_input, error: 'garde-fou : relecteur ne descend pas sous l\'effort high (demandé : low).' });
    assert.strictEqual(p.events().filter(e => e.event === 'blocked').length, 1);
    p.hook('post-agent-fail', { tool_use_id: 'tu_autre', tool_input, error: 'garde-fou : relecteur tourne obligatoirement sur Opus (demandé : sonnet).' });
    assert.strictEqual(p.events().filter(e => e.event === 'blocked').length, 2, 'un autre refus du garde-fou reste journalisé');
  } finally { p.clean(); }
});

// --- log-event plan --plan-file ---
const goodPlan = () => ({
  mission: { titre: 'Mode chef version 0.4.0' },
  branches: [{ id: 'B1', titre: 'Garde-fou et hooks' }, { id: 'B2', titre: 'Agents' }],
  taches: [
    { id: 'T1', branche: 'B1', titre: 'Plancher d\'effort', agent: 'dev-critique', modele: 'opus', effort: 'high', justif: 'garde-fou = sécurité' },
    { id: 'T2', branche: 'B2', titre: 'Agent de rapport', agent: 'dev', modele: 'sonnet', effort: 'medium', justif: 'standard' },
    { id: 'T3', branche: 'B2', titre: 'Relecture finale', agent: 'relecteur', modele: 'opus', effort: 'xhigh', justif: 'relecture' },
  ],
});
function withPlan(p, mission, edit) {
  const plan = goodPlan();
  if (edit) edit(plan);
  const dir = path.join(p.orch, 'out', mission);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  return `.orchestrator/out/${mission}/plan.json`;
}

test('plan --plan-file : plan.json valide → événement plan avec plan_file et plan_tasks', () => {
  const p = project({ plan: false });
  try {
    const file = withPlan(p, 'pf1');
    const r = p.log('plan', '--mission', 'pf1', '--plan-file', file, '--summary', '3 tâches');
    assert.strictEqual(r.status, 0, r.stderr);
    const [ev] = p.events();
    assert.strictEqual(ev.event, 'plan');
    assert.strictEqual(ev.plan_file, 'out/pf1/plan.json');
    assert.strictEqual(ev.plan_tasks, 3);
  } finally { p.clean(); }
});

test('plan sans --plan-file : mission valide, aucune trace de plan.json (le dash reste lisible)', () => {
  const p = project({ plan: false });
  try {
    assert.strictEqual(p.log('plan', '--mission', 'pf2', '--summary', 'sans arbre').status, 0);
    const [ev] = p.events();
    assert.ok(!('plan_file' in ev) && !('plan_tasks' in ev));
  } finally { p.clean(); }
});

test('plan --plan-file : titres trop longs, branche inconnue, id en double → refus listant toutes les erreurs', () => {
  const p = project({ plan: false });
  try {
    const file = withPlan(p, 'pf3', plan => {
      plan.mission.titre = 'un deux trois quatre cinq six sept';
      plan.branches[0].titre = 'un deux trois quatre cinq six';
      plan.taches[0].titre = 'un deux trois quatre cinq six sept';
      plan.taches[1].branche = 'B9';
      plan.taches[2].id = 'T1';
      plan.taches[2].modele = 'gpt';
    });
    const r = p.log('plan', '--mission', 'pf3', '--plan-file', file);
    assert.notStrictEqual(r.status, 0);
    for (const re of [/mission : titre de 7 mots \(max 6\)/, /branche B1 : titre de 6 mots \(max 5\)/, /tâche T1 : titre de 7 mots/, /branche « B9 » inconnue/, /tâche T1 en double/, /modele « gpt »/]) assert.match(r.stderr, re);
    assert.deepStrictEqual(p.events(), [], 'rien n\'est journalisé');
  } finally { p.clean(); }
});

test('plan --plan-file : effort hors medium/high/xhigh ou sous le plancher → refus', () => {
  const p = project({ plan: false });
  try {
    for (const [agent, effort, re] of [
      ['dev-critique', 'medium', /tâche T1 : dev-critique ne descend pas sous l'effort high/],
      ['relecteur', 'medium', /relecteur ne descend pas sous l'effort high/],
      ['conseiller', 'medium', /conseiller ne descend pas sous l'effort high/],
      ['dev', 'high', /tâche T1 : dev reste en effort medium/],
      ['executant', 'xhigh', /executant reste en effort medium/],
      ['dev', 'low', /effort « low » invalide/],
      ['dev', 'max', /effort « max » invalide/],
    ]) {
      const file = withPlan(p, 'pf4', plan => { plan.taches[0].agent = agent; plan.taches[0].effort = effort; });
      const r = p.log('plan', '--mission', 'pf4', '--plan-file', file);
      assert.notStrictEqual(r.status, 0, `${agent} ${effort}`);
      assert.match(r.stderr, re);
    }
  } finally { p.clean(); }
});

test('plan --plan-file : fichier hors out/<mission>/, JSON illisible, usage hors plan → refus', () => {
  const p = project({ plan: false });
  try {
    withPlan(p, 'pf5');
    fs.mkdirSync(path.join(p.orch, 'out', 'autre'), { recursive: true });
    fs.copyFileSync(path.join(p.orch, 'out', 'pf5', 'plan.json'), path.join(p.orch, 'out', 'autre', 'plan.json'));
    assert.match(p.log('plan', '--mission', 'pf5', '--plan-file', '.orchestrator/out/autre/plan.json').stderr, /doit être sous \.orchestrator\/out\/pf5\//);
    assert.match(p.log('plan', '--mission', 'pf5', '--plan-file', '../../etc/plan.json').stderr, /doit être sous/);
    assert.match(p.log('plan', '--mission', 'pf5', '--plan-file', '.orchestrator/out/pf5/absent.json').stderr, /illisible/);
    fs.writeFileSync(path.join(p.orch, 'out', 'pf5', 'plan.json'), '{pas du json');
    assert.match(p.log('plan', '--mission', 'pf5', '--plan-file', '.orchestrator/out/pf5/plan.json').stderr, /illisible/);
    assert.strictEqual(p.log('plan', '--mission', 'pf5').status, 0);
    assert.match(p.log('review', '--mission', 'pf5', '--plan-file', '.orchestrator/out/pf5/plan.json').stderr, /ne va qu'avec plan/);
  } finally { p.clean(); }
});
