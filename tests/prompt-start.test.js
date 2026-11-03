// Tests 0.4.1 : hook UserPromptSubmit « prompt-start » : node --test tests/prompt-start.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'scripts', 'hooks.js');
const LOG = path.join(__dirname, '..', 'scripts', 'log-event.js');
const L = require('../scripts/lib');

function project(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-start-'));
  try {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCH_SITE: 'off' }; // pas de vrai site pendant ces tests
    const prompt = text => spawnSync('node', [HOOKS, 'prompt-start'], { input: JSON.stringify({ prompt: text, cwd: dir, session_id: 's1' }), env, encoding: 'utf8' });
    const events = () => L.readEvents(path.join(dir, '.orchestrator'));
    return fn({ dir, env, prompt, events });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('/orchestrateur:chef : crée .orchestrator/ et écrit start tout de suite, mission_id provisoire', () => {
  project(({ dir, prompt, events }) => {
    const r = prompt('/orchestrateur:chef leger corriger le parseur');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(fs.statSync(path.join(dir, '.orchestrator')).isDirectory());
    const [ev, ...more] = events();
    assert.strictEqual(more.length, 0);
    assert.strictEqual(ev.event, 'start');
    assert.match(ev.mission_id, /^cadrage-\d{8}-\d{6}$/);
    assert.strictEqual(ev.agent, 'chef');
    assert.strictEqual(ev.source, 'hook');
    assert.strictEqual(ev.summary, 'cadrage : leger corriger le parseur');
    assert.ok(ev.ts);
  });
});

test('autre prompt : rien n\'est créé ; /chef seul et /orchestrateur:chef sans argument comptent', () => {
  project(({ dir, prompt, events }) => {
    for (const t of ['bonjour', '/orchestrateur:chefs x', '/orchestrateur:reprise m', 'parle de /orchestrateur:chef']) prompt(t);
    assert.ok(!fs.existsSync(path.join(dir, '.orchestrator')));
    prompt('/orchestrateur:chef');
    assert.strictEqual(events()[0].summary, 'cadrage');
  });
});

test('un second /chef pendant le cadrage n\'ajoute pas de start ; pendant une mission, rien', () => {
  project(({ dir, env, prompt, events }) => {
    prompt('/orchestrateur:chef a');
    prompt('/orchestrateur:chef b');
    assert.strictEqual(events().length, 1);
    const plan = spawnSync('node', [LOG, 'plan', '--mission', 'm-20261027', '--summary', 'x'], { cwd: dir, env, encoding: 'utf8' });
    assert.strictEqual(plan.status, 0, plan.stderr);
    prompt('/orchestrateur:chef c');
    assert.deepStrictEqual(events().map(e => e.event), ['start', 'plan']);
  });
});

test('start ne désigne pas la mission : plan passe, la mission active est celle du plan, done clôt', () => {
  project(({ dir, env, prompt }) => {
    prompt('/orchestrateur:chef a');
    const orch = path.join(dir, '.orchestrator');
    assert.strictEqual(L.activeMission(orch), '?'); // cadrage : ni mission ni refus
    const run = (...args) => spawnSync('node', [LOG, ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.strictEqual(run('plan', '--mission', 'vrai-20261027', '--summary', 'x').status, 0);
    assert.strictEqual(L.activeMission(orch), 'vrai-20261027');
    const done = run('done', '--mission', 'vrai-20261027', '--summary', 'ok');
    assert.strictEqual(done.status, 0, done.stderr);
    assert.strictEqual(L.activeMission(orch), null);
  });
});
