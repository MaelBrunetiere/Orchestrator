// Tests du hook guard (scripts/hooks.js guard) pour l'explorateur : node --test tests/hooks-guard.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'scripts', 'hooks.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guard-'));
fs.mkdirSync(path.join(root, '.orchestrator'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// Renvoie la raison du refus, ou null si le hook laisse passer.
function explorateur(command, tool = 'Bash') {
  const r = spawnSync(process.execPath, [HOOKS, 'guard'], {
    cwd: root, encoding: 'utf8',
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, agent_id: 'agent-x', agent_type: 'orchestrateur:explorateur', cwd: root, session_id: 's1' }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
}

test('explorateur : pwd et echo sans redirection sont permis', () => {
  assert.strictEqual(explorateur('pwd'), null);
  assert.strictEqual(explorateur('echo bonjour'), null);
  assert.strictEqual(explorateur('echo "a > b"'), null); // > entre guillemets : texte, pas une redirection
  assert.strictEqual(explorateur('pwd && ls'), null);
  assert.strictEqual(explorateur('echo "---" && find . -name "*.js" | wc -l'), null);
  assert.strictEqual(explorateur('pwd', 'PowerShell'), null);
  assert.strictEqual(explorateur('echo bonjour', 'PowerShell'), null);
});

test('explorateur : echo avec redirection reste refusé', () => {
  for (const cmd of ['echo x > f.txt', 'echo x >> f.txt', 'echo x>f.txt', 'echo x 2> f.txt', 'echo x 1>f.txt', 'pwd > out.txt', 'echo "ok" > "f.txt"']) {
    assert.match(explorateur(cmd) || '', /redirection > interdite/, cmd);
  }
});

test('explorateur : pas de contournement de la redirection par substitution ou chaînage', () => {
  assert.match(explorateur('echo $(pwd)') || '', /substitution/);
  assert.match(explorateur('echo `pwd`') || '', /substitution/);
  assert.match(explorateur('echo x | tee f.txt') || '', /tee/);
  assert.match(explorateur('pwd; echo x > f.txt') || '', /redirection/);
  assert.match(explorateur('echo x && rm f.txt') || '', /rm|suppression/);
});

test('explorateur : le message de refus liste pwd et echo', () => {
  assert.match(explorateur('touch f.txt') || '', /pwd.*echo|echo.*pwd/);
});

// Projet à part pour les refus journalisés : mission « mt » active, état des workers à la demande.
function missionProject(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-blocked-'));
  const orch = path.join(dir, '.orchestrator');
  fs.mkdirSync(orch);
  if (state) fs.writeFileSync(path.join(orch, '.agents.json'), JSON.stringify(state.agents || {}));
  if (state && state.chef) fs.writeFileSync(path.join(orch, '.chef.json'), JSON.stringify({ sessions: ['chef1'] }));
  if (!state || state.plan !== false) fs.writeFileSync(path.join(orch, 'events.jsonl'), JSON.stringify({ ts: 'x', mission_id: 'mt', event: 'plan', source: 'chef' }) + '\n');
  const run = payload => {
    const r = spawnSync(process.execPath, [HOOKS, 'guard'], { cwd: dir, encoding: 'utf8', input: JSON.stringify({ cwd: dir, session_id: 's9', ...payload }) });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const blocked = () => {
    try { return fs.readFileSync(path.join(orch, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'blocked'); } catch { return null; }
  };
  return { dir, orch, run, blocked, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('refus d\'un worker : événement blocked (source hook, agent, task_id, outil, motif)', () => {
  const p = missionProject({ agents: { agents: { x: { mission_id: 'mt', task_id: 'T4', agent: 'dev' } } } });
  try {
    const out = p.run({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, agent_id: 'agent-x', agent_type: 'orchestrateur:dev' });
    assert.strictEqual(out.permissionDecision, 'deny');
    const [ev, ...more] = p.blocked();
    assert.strictEqual(more.length, 0);
    assert.deepStrictEqual({ mission_id: ev.mission_id, agent: ev.agent, task_id: ev.task_id, source: ev.source, tool: ev.tool }, { mission_id: 'mt', agent: 'dev', task_id: 'T4', source: 'hook', tool: 'Bash' });
    assert.match(ev.summary, /suppression de fichiers/);
    assert.ok(ev.ts);
  } finally { p.clean(); }
});

test('refus d\'un worker en avant-plan : la tâche vient du lancement en attente (rôle unique)', () => {
  const p = missionProject({ agents: { pending: { tu1: { mission_id: 'mt', task_id: 'T2', agent: 'explorateur' } } } });
  try {
    p.run({ tool_name: 'Bash', tool_input: { command: 'touch f.txt' }, agent_id: 'agent-y', agent_type: 'orchestrateur:explorateur' });
    const [ev] = p.blocked();
    assert.strictEqual(ev.task_id, 'T2');
    assert.strictEqual(ev.agent, 'explorateur');
    assert.match(ev.summary, /lecture seule/);
  } finally { p.clean(); }
});

test('refus d\'un worker de tâche inconnue : blocked quand même, task_id null', () => {
  const p = missionProject({ agents: {} });
  try {
    p.run({ tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'hors-projet.txt') }, agent_id: 'agent-z', agent_type: 'orchestrateur:relecteur' });
    const [ev] = p.blocked();
    assert.strictEqual(ev.task_id, null);
    assert.strictEqual(ev.agent, 'relecteur');
    assert.strictEqual(ev.tool, 'Write');
    assert.strictEqual(ev.mission_id, 'mt');
  } finally { p.clean(); }
});

test('refus du chef pendant la mission : blocked, agent chef', () => {
  const p = missionProject({ chef: true });
  try {
    const out = p.run({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'chef1' });
    assert.strictEqual(out.permissionDecision, 'deny');
    const [ev] = p.blocked();
    assert.strictEqual(ev.agent, 'chef');
    assert.strictEqual(ev.task_id, null);
    assert.strictEqual(ev.source, 'hook');
    assert.match(ev.summary, /log-event/);
  } finally { p.clean(); }
});

test('refus hors mission : le refus part, mais aucun événement (pas de mission fantôme)', () => {
  const p = missionProject({ agents: {}, plan: false });
  try {
    const out = p.run({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, agent_id: 'agent-x', agent_type: 'orchestrateur:dev' });
    assert.strictEqual(out.permissionDecision, 'deny');
    assert.strictEqual(p.blocked(), null);
    assert.ok(!fs.existsSync(path.join(p.orch, 'events.jsonl')));
  } finally { p.clean(); }
});

test('commande permise : aucun événement blocked', () => {
  const p = missionProject({ agents: { agents: { x: { mission_id: 'mt', task_id: 'T1', agent: 'explorateur' } } } });
  try {
    assert.strictEqual(p.run({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'agent-x', agent_type: 'orchestrateur:explorateur' }), null);
    assert.deepStrictEqual(p.blocked(), []);
  } finally { p.clean(); }
});

// --- SubagentStop : STATUT ok sans fichier SORTIE → worker_fail « sortie absente » ---
function stopProject(agent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stop-'));
  const orch = path.join(dir, '.orchestrator');
  fs.mkdirSync(path.join(orch, 'out', 'mt'), { recursive: true });
  fs.writeFileSync(path.join(orch, 'events.jsonl'), JSON.stringify({ ts: 'x', mission_id: 'mt', event: 'plan', source: 'chef' }) + '\n');
  fs.writeFileSync(path.join(orch, '.agents.json'), JSON.stringify({ agents: { x: { mission_id: 'mt', task_id: 'T2', agent, model: 'm', start_logged: true } } }));
  const stop = last_assistant_message => {
    const r = spawnSync(process.execPath, [HOOKS, 'subagent-stop'], { cwd: dir, encoding: 'utf8', input: JSON.stringify({ cwd: dir, agent_id: 'agent-x', last_assistant_message }) });
    assert.strictEqual(r.status, 0, r.stderr);
    return { stdout: r.stdout, ev: fs.readFileSync(path.join(orch, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).pop() };
  };
  return { orch, stop, out: (name, text = 'sortie') => fs.writeFileSync(path.join(orch, 'out', 'mt', name), text), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('SubagentStop : STATUT ok sans fichier SORTIE → worker_fail « sortie absente » + alerte', () => {
  const p = stopProject('dev');
  try {
    const { ev, stdout } = p.stop('STATUT: ok\nFAIT: créé test_x.py');
    assert.strictEqual(ev.event, 'worker_fail');
    assert.match(ev.summary, /^sortie absente : out\/mt\/T2-dev\.md/);
    assert.strictEqual(ev.task_id, 'T2');
    assert.match(JSON.parse(stdout).systemMessage, /n'existe pas/);
  } finally { p.clean(); }
});

test('SubagentStop : sortie présente (nom exact ou suffixé) → worker_done', () => {
  for (const name of ['T2-dev.md', 'T2-dev-haiku.md']) {
    const p = stopProject('dev');
    try {
      p.out(name);
      const { ev, stdout } = p.stop('STATUT: ok\nFAIT: fait');
      assert.strictEqual(ev.event, 'worker_done', name);
      assert.strictEqual(stdout.trim(), '', name);
    } finally { p.clean(); }
  }
});

test('SubagentStop : la sortie d\'une autre tâche ne compte pas ; STATUT échec ne vérifie rien', () => {
  const p = stopProject('dev');
  try {
    p.out('T3-dev.md');
    assert.strictEqual(p.stop('STATUT: ok\nFAIT: x').ev.event, 'worker_fail');
  } finally { p.clean(); }
  const q = stopProject('dev');
  try {
    const fail = q.stop('STATUT: échec\nFAIT: rien').ev;
    assert.strictEqual(fail.event, 'worker_fail');
    assert.ok(!/sortie absente/.test(fail.summary));
  } finally { q.clean(); }
});

// --- PostToolUseFailure(Agent) : refus du garde-fou → blocked ; autre erreur → worker_fail ---
test('lancement refusé par le garde-fou → blocked ; plafond de workers et pannes → worker_fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fail-'));
  fs.mkdirSync(path.join(dir, '.orchestrator'));
  try {
    const fail = (error, task) => {
      const r = spawnSync(process.execPath, [HOOKS, 'post-agent-fail'], {
        cwd: dir, encoding: 'utf8',
        input: JSON.stringify({ cwd: dir, tool_use_id: `tu_${task}`, error, tool_input: { subagent_type: 'orchestrateur:relecteur', model: 'sonnet', prompt: `[mission:mt task:${task}] relis` } }),
      });
      assert.strictEqual(r.status, 0, r.stderr);
    };
    fail('Subagent spawn denied by a plugin: garde-fou : relecteur tourne obligatoirement sur Opus (demandé : sonnet).', 'T1');
    fail('Subagent spawn denied by a plugin: garde-fou : déjà 2 workers de mission en cours (max 2). Attends.', 'T2');
    fail('connexion perdue', 'T3');
    const evs = fs.readFileSync(path.join(dir, '.orchestrator', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.deepStrictEqual(evs.map(e => e.event), ['blocked', 'worker_fail', 'worker_fail']);
    assert.strictEqual(evs[0].agent, 'relecteur');
    assert.strictEqual(evs[0].task_id, 'T1');
    assert.strictEqual(evs[0].tool, 'Agent');
    assert.strictEqual(evs[0].source, 'hook');
    assert.match(evs[0].summary, /^lancement refusé par le garde-fou : relecteur tourne obligatoirement sur Opus/);
    assert.match(evs[1].summary, /^lancement refusé : .*déjà 2 workers/);
    assert.ok(!('tool' in evs[1]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refus « plafond de 2 workers » : jamais blocked (pas de toast du dash), worker_fail « lancement refusé » comme le lit le dash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cap-'));
  fs.mkdirSync(path.join(dir, '.orchestrator'));
  try {
    for (const [i, error] of [
      'Subagent spawn denied by a plugin: garde-fou : déjà 2 workers de mission en cours (max 2). Attends un compte rendu avant d\'en lancer un autre.',
      'garde-fou : déjà 3 workers de mission en cours (max 2).',
    ].entries()) {
      const r = spawnSync(process.execPath, [HOOKS, 'post-agent-fail'], {
        cwd: dir, encoding: 'utf8',
        input: JSON.stringify({ cwd: dir, tool_use_id: `tu_cap${i}`, error, tool_input: { subagent_type: 'orchestrateur:dev', prompt: '[mission:mt task:T5] x' } }),
      });
      assert.strictEqual(r.status, 0, r.stderr);
    }
    const evs = fs.readFileSync(path.join(dir, '.orchestrator', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.strictEqual(evs.length, 2);
    for (const e of evs) {
      assert.strictEqual(e.event, 'worker_fail');
      assert.match(e.summary, /^lancement refusé : /); // le dash (isRefusal) range cette forme en « refusé »
      assert.ok(!('tool' in e));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- Inscription des sessions « chef » dans .chef.json (appels de log-event) ---
const LOG = 'node "x/scripts/log-event.js"';
function chefCall(p, session, args) {
  p.run({ tool_name: 'Bash', tool_input: { command: `${LOG} ${args}` }, session_id: session, transcript_path: `/t/${session}.jsonl` });
  try { return JSON.parse(fs.readFileSync(path.join(p.orch, '.chef.json'), 'utf8')); } catch { return null; }
}

test('inscription : plan, reprise et mission active inscrivent la session (heure de 1re inscription conservée)', () => {
  const p = missionProject({ agents: {} });
  try {
    const c1 = chefCall(p, 'sA', 'plan --mission mt --summary "x"');
    assert.deepStrictEqual(c1.sessions, ['sA']);
    assert.strictEqual(c1.transcripts.sA, '/t/sA.jsonl');
    assert.ok(c1.registered.sA && c1.seen.sA);
    const first = c1.registered.sA;
    const c2 = chefCall(p, 'sB', 'review --mission mt --task T1 --summary "mission active"');
    assert.deepStrictEqual(c2.sessions, ['sA', 'sB']);
    const c3 = chefCall(p, 'sA', 'review --mission mt --summary "encore"');
    assert.strictEqual(c3.registered.sA, first, 'la 1re inscription ne bouge pas');
    const c4 = chefCall(p, 'sC', 'reprise --mission mt');
    assert.ok(c4.sessions.includes('sC'));
  } finally { p.clean(); }
});

test('inscription : un plan vers une autre mission pendant une mission active n\'inscrit rien (log-event le refuse)', () => {
  const p = missionProject({ agents: {} }); // mission « mt » active
  try {
    fs.writeFileSync(path.join(p.orch, '.chef.json'), JSON.stringify({ sessions: ['sChef'], transcripts: { sChef: '/t/sChef.jsonl' } }));
    const after = chefCall(p, 'sIntrus', 'plan --mission autre --summary "x"');
    assert.deepStrictEqual(after, { sessions: ['sChef'], transcripts: { sChef: '/t/sChef.jsonl' } }, '.chef.json inchangé');
    // un replan de la mission en cours, lui, inscrit sa session
    assert.ok(chefCall(p, 'sReplan', 'plan --mission mt --summary "replan"').sessions.includes('sReplan'));
  } finally { p.clean(); }
});

test('inscription : un plan sans mission active (journal absent ou clos) inscrit la session ; reprise d\'une mission close non', () => {
  const p = missionProject({ agents: {}, plan: false });
  try {
    assert.deepStrictEqual(chefCall(p, 'sNew', 'plan --mission neuve --summary "x"').sessions, ['sNew']);
    fs.rmSync(path.join(p.orch, '.chef.json'));
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), [{ mission_id: 'old', event: 'plan' }, { mission_id: 'old', event: 'done' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    assert.strictEqual(chefCall(p, 'sRep', 'reprise --mission old'), null, 'reprise d\'une mission close : rien');
    assert.deepStrictEqual(chefCall(p, 'sNew2', 'plan --mission suivante').sessions, ['sNew2']);
  } finally { p.clean(); }
});

test('inscription : une session obsolète qui parle d\'une mission close ou inconnue n\'inscrit rien', () => {
  const p = missionProject({ agents: {} });
  try {
    // mission « old » close, puis plus rien d'actif
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), [{ mission_id: 'old', event: 'plan' }, { mission_id: 'old', event: 'done' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    assert.strictEqual(chefCall(p, 'sOld', 'review --mission old --summary "trop tard"'), null, 'mission close : .chef.json non créé');
    assert.strictEqual(chefCall(p, 'sOld', 'review --mission autre --summary "x"'), null);
    // mission active « mt » : une session qui vise une autre mission n'est pas inscrite non plus
    fs.writeFileSync(path.join(p.orch, 'events.jsonl'), JSON.stringify({ mission_id: 'mt', event: 'plan' }) + '\n');
    fs.writeFileSync(path.join(p.orch, '.chef.json'), JSON.stringify({ sessions: ['sChef'], transcripts: { sChef: '/t/sChef.jsonl' } }));
    const after = chefCall(p, 'sOld', 'review --mission old --summary "trop tard"');
    assert.deepStrictEqual(after, { sessions: ['sChef'], transcripts: { sChef: '/t/sChef.jsonl' } }, '.chef.json inchangé');
    assert.deepStrictEqual(chefCall(p, 'sOld', 'review --summary "sans --mission"').sessions, ['sChef']);
  } finally { p.clean(); }
});
