// Tests de scripts/log-event.js : node --test tests/log-event.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'log-event.js');

// Projet jetable ; log() lance log-event depuis sa racine.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  const orch = path.join(root, '.orchestrator');
  const log = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
  // Même chose, avec le renommage de tmp/<mission>/ qui échoue (code : EBUSY, EPERM…).
  const logFailingRename = (code, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, FAIL_RENAME_CODE: code, NODE_OPTIONS: `--require "${path.join(__dirname, 'fail-rename.js').split(path.sep).join('/')}"` },
  });
  // Dossier temporaire d'une mission : .orchestrator/tmp/<mission>/
  const tmp = (mission, ...sub) => path.join(orch, 'tmp', mission, ...sub);
  return { root, orch, log, logFailingRename, tmp, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const events = orch => fs.readFileSync(path.join(orch, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('done déplace .orchestrator/tmp/<mission>/ dans archive/<mission>.tmp/', () => {
  const p = project();
  try {
    assert.strictEqual(p.log('plan', '--mission', 'm1').status, 0);
    fs.mkdirSync(p.tmp('m1', 'sous'), { recursive: true });
    fs.writeFileSync(p.tmp('m1', 'a.txt'), 'contenu A');
    fs.writeFileSync(p.tmp('m1', 'sous', 'b.txt'), 'contenu B');
    const r = p.log('done', '--mission', 'm1', '--summary', 'ok');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /tmp archivé/);
    assert.ok(!fs.existsSync(p.tmp('m1')));
    assert.ok(!fs.existsSync(path.join(p.orch, 'tmp')), 'tmp/ vide : supprimé');
    assert.ok(fs.existsSync(path.join(p.orch, 'archive', 'm1.jsonl')));
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'archive', 'm1.tmp', 'a.txt'), 'utf8'), 'contenu A');
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'archive', 'm1.tmp', 'sous', 'b.txt'), 'utf8'), 'contenu B');
  } finally { p.clean(); }
});

test('done n\'archive que le dossier de sa mission : les autres missions et les fichiers à plat restent', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm1b');
    fs.mkdirSync(p.tmp('m1b'), { recursive: true });
    fs.writeFileSync(p.tmp('m1b', 'a.txt'), 'à archiver');
    fs.mkdirSync(p.tmp('autre'), { recursive: true });
    fs.writeFileSync(p.tmp('autre', 'b.txt'), 'autre mission');
    fs.writeFileSync(path.join(p.orch, 'tmp', 'plat.txt'), 'ancien format');
    const r = p.log('done', '--mission', 'm1b');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'archive', 'm1b.tmp', 'a.txt'), 'utf8'), 'à archiver');
    assert.ok(!fs.existsSync(p.tmp('m1b')));
    assert.strictEqual(fs.readFileSync(p.tmp('autre', 'b.txt'), 'utf8'), 'autre mission');
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'tmp', 'plat.txt'), 'utf8'), 'ancien format');
    assert.ok(!fs.existsSync(path.join(p.orch, 'archive', 'autre.tmp')));
  } finally { p.clean(); }
});

test('done sans tmp : rien à déplacer, pas d\'erreur', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm2');
    const r = p.log('done', '--mission', 'm2');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(p.orch, 'archive', 'm2.tmp')));
    assert.ok(fs.existsSync(path.join(p.orch, 'archive', 'm2.jsonl')));
  } finally { p.clean(); }
});

test('done avec tmp/<mission>/ vide : le dossier est supprimé, pas archivé', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm3');
    fs.mkdirSync(p.tmp('m3'), { recursive: true });
    const r = p.log('done', '--mission', 'm3');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(p.tmp('m3')));
    assert.ok(!fs.existsSync(path.join(p.orch, 'archive', 'm3.tmp')));
  } finally { p.clean(); }
});

test('même mission archivée deux fois : le tmp suit le suffixe -2', () => {
  const p = project();
  try {
    for (const txt of ['premier', 'second']) {
      p.log('plan', '--mission', 'm4');
      fs.mkdirSync(p.tmp('m4'), { recursive: true });
      fs.writeFileSync(p.tmp('m4', 'f.txt'), txt);
      assert.strictEqual(p.log('done', '--mission', 'm4').status, 0);
    }
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'archive', 'm4.tmp', 'f.txt'), 'utf8'), 'premier');
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'archive', 'm4-2.tmp', 'f.txt'), 'utf8'), 'second');
    assert.ok(fs.existsSync(path.join(p.orch, 'archive', 'm4-2.jsonl')));
  } finally { p.clean(); }
});

test('--mission : un identifiant qui sort de tmp/ ou d\'archive/ est refusé', () => {
  const p = project();
  try {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '.cache', 'a..b', '-x']) {
      const r = p.log('plan', '--mission', bad);
      assert.notStrictEqual(r.status, 0, bad);
      assert.match(r.stderr, /invalide/, bad);
    }
    assert.ok(!fs.existsSync(path.join(p.orch, 'events.jsonl')));
    assert.strictEqual(p.log('plan', '--mission', 'test-util_2.1-20261027').status, 0);
  } finally { p.clean(); }
});

test('plan --mode leger : mode (et sensible) dans l\'événement plan', () => {
  const p = project();
  try {
    assert.strictEqual(p.log('plan', '--mission', 'm5', '--mode', 'léger', '--sensible', 'oui').status, 0);
    const [ev] = events(p.orch);
    assert.strictEqual(ev.mode, 'leger');
    assert.strictEqual(ev.sensible, true);
  } finally { p.clean(); }
});

test('plan --mode leger sans --sensible : pas de champ sensible', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm6', '--mode', 'leger');
    const [ev] = events(p.orch);
    assert.strictEqual(ev.mode, 'leger');
    assert.ok(!('sensible' in ev));
  } finally { p.clean(); }
});

test('plan en mode normal : événement identique à avant (aucun champ en plus)', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm7');
    p.log('done', '--mission', 'm7');
    const [ev] = fs.readFileSync(path.join(p.orch, 'archive', 'm7.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(!('mode' in ev) && !('sensible' in ev));
    p.log('plan', '--mission', 'm8', '--mode', 'normal');
    assert.ok(!('mode' in events(p.orch)[0]));
  } finally { p.clean(); }
});

test('--mode invalide, --sensible mal formé ou hors plan : refusés', () => {
  const p = project();
  try {
    assert.notStrictEqual(p.log('plan', '--mission', 'm9', '--mode', 'turbo').status, 0);
    assert.notStrictEqual(p.log('plan', '--mission', 'm9', '--mode', 'leger', '--sensible', 'peut-être').status, 0);
    assert.notStrictEqual(p.log('plan', '--mission', 'm9', '--sensible', 'oui').status, 0);
    assert.strictEqual(p.log('plan', '--mission', 'm9').status, 0);
    assert.notStrictEqual(p.log('review', '--mission', 'm9', '--mode', 'leger').status, 0);
  } finally { p.clean(); }
});

for (const code of ['EBUSY', 'EPERM']) {
  test(`done : déplacement de tmp/<mission>/ refusé (${code}) → done non bloqué, avertissement dans le summary et la sortie`, () => {
    const p = project();
    try {
      p.log('plan', '--mission', 'm10');
      fs.mkdirSync(p.tmp('m10'), { recursive: true });
      fs.writeFileSync(p.tmp('m10', 'a.txt'), 'à garder');
      const r = p.logFailingRename(code, 'done', '--mission', 'm10', '--summary', 'terminé');
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /AVERTISSEMENT : tmp non archivé/);
      assert.match(r.stdout, new RegExp(code));
      assert.match(r.stdout, /archivé : /);
      // le journal est archivé, l'état du chef remis à zéro, tmp/<mission>/ reste en place
      const [done] = fs.readFileSync(path.join(p.orch, 'archive', 'm10.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'done');
      assert.match(done.summary, /^terminé \[AVERTISSEMENT : tmp non archivé \(/);
      assert.match(done.summary, new RegExp(code));
      assert.ok(!fs.existsSync(path.join(p.orch, 'events.jsonl')));
      assert.strictEqual(fs.readFileSync(p.tmp('m10', 'a.txt'), 'utf8'), 'à garder');
      assert.ok(!fs.existsSync(path.join(p.orch, 'archive', 'm10.tmp')));
    } finally { p.clean(); }
  });
}

// --- .chef.json : purge au plan, tokens du chef au done ---
const chefJson = (orch) => JSON.parse(fs.readFileSync(path.join(orch, '.chef.json'), 'utf8'));
const writeChef = (p, obj) => { fs.mkdirSync(p.orch, { recursive: true }); fs.writeFileSync(path.join(p.orch, '.chef.json'), JSON.stringify(obj)); };
const ago = s => new Date(Date.now() - s * 1000).toISOString();
// Transcript : prompt de lancement, appel du skill, puis n messages assistant de 15 tokens (5 + 4 + 6).
function chefTranscript(p, name, model, { start, n }) {
  const entries = [
    { type: 'user', timestamp: ago(start), message: { role: 'user', content: 'brief' } },
    { type: 'assistant', timestamp: ago(start - 1), message: { id: `${name}-skill`, model, usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'orchestrateur:chef' } }] } },
  ];
  for (let i = 0; i < n; i++) entries.push({ type: 'assistant', timestamp: ago(start - 2 - i), message: { id: `${name}-${i}`, model, usage: { input_tokens: 5, cache_creation_input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'x' }] } });
  const file = path.join(p.root, `${name}.jsonl`);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('plan d\'une nouvelle mission : purge les inscriptions antérieures, garde la dernière appelante', () => {
  const p = project();
  try {
    writeChef(p, {
      sessions: ['vieille', 'neuve'], transcripts: { vieille: '/t/v.jsonl', neuve: '/t/n.jsonl' },
      registered: { vieille: ago(3600), neuve: ago(1) }, seen: { vieille: ago(1800), neuve: ago(1) },
    });
    assert.strictEqual(p.log('plan', '--mission', 'm20').status, 0);
    const c = chefJson(p.orch);
    assert.deepStrictEqual(c.sessions, ['neuve']);
    assert.deepStrictEqual(Object.keys(c.transcripts), ['neuve']);
    assert.deepStrictEqual(Object.keys(c.registered), ['neuve']);
  } finally { p.clean(); }
});

test('plan vers un autre mission_id pendant une mission active : refusé, .chef.json et journal intacts', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm23');
    const chef = { sessions: ['chef', 'autre'], transcripts: { chef: '/t/c', autre: '/t/a' }, registered: { chef: ago(60), autre: ago(5) }, seen: { chef: ago(60), autre: ago(5) } };
    writeChef(p, chef);
    const avant = fs.readFileSync(path.join(p.orch, 'events.jsonl'), 'utf8');
    const r = p.log('plan', '--mission', 'm24');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /m23 est encore active/);
    assert.deepStrictEqual(chefJson(p.orch), chef, 'aucune inscription purgée');
    assert.strictEqual(fs.readFileSync(path.join(p.orch, 'events.jsonl'), 'utf8'), avant);
  } finally { p.clean(); }
});

test('replan de la mission en cours : aucune inscription n\'est purgée', () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm21');
    writeChef(p, { sessions: ['a', 'b'], transcripts: { a: '/t/a', b: '/t/b' }, registered: { a: ago(60), b: ago(30) }, seen: { a: ago(60), b: ago(30) } });
    assert.strictEqual(p.log('plan', '--mission', 'm21', '--summary', 'replan').status, 0);
    assert.deepStrictEqual(chefJson(p.orch).sessions, ['a', 'b']);
  } finally { p.clean(); }
});

test('done : les tokens du chef ne comptent pas une session obsolète (Opus) purgée au plan', () => {
  const p = project();
  try {
    const obsolete = chefTranscript(p, 'obsolete', 'claude-opus-5-5', { start: 900, n: 40 });
    const chef = chefTranscript(p, 'chef', 'claude-sonnet-5-5', { start: 300, n: 3 });
    writeChef(p, {
      sessions: ['obsolete', 'chef'], transcripts: { obsolete, chef },
      registered: { obsolete: ago(800), chef: ago(250) }, seen: { obsolete: ago(790), chef: ago(250) },
    });
    p.log('plan', '--mission', 'm22');
    const r = p.log('done', '--mission', 'm22', '--summary', 'ok');
    assert.strictEqual(r.status, 0, r.stderr);
    const done = fs.readFileSync(path.join(p.orch, 'archive', 'm22.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).pop();
    assert.strictEqual(done.tokens, 10 + 3 * 15);
    assert.strictEqual(done.tokens_cache_read, 300);
    assert.deepStrictEqual(done.tokens_by_model, { 'claude-sonnet-5-5': 55 });
    assert.strictEqual(done.tokens_source, 'mesuré');
  } finally { p.clean(); }
});

test("done : sans --summary, l'avertissement devient le summary", () => {
  const p = project();
  try {
    p.log('plan', '--mission', 'm11');
    fs.mkdirSync(p.tmp('m11'), { recursive: true });
    fs.writeFileSync(p.tmp('m11', 'a.txt'), 'x');
    assert.strictEqual(p.logFailingRename('EBUSY', 'done', '--mission', 'm11').status, 0);
    const evs = fs.readFileSync(path.join(p.orch, 'archive', 'm11.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.match(evs.at(-1).summary, /^AVERTISSEMENT : tmp non archivé \(EBUSY\)/);
  } finally { p.clean(); }
});
