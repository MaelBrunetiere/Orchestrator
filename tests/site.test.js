// Tests 0.4.3 : lancement automatique du site de suivi : node --test tests/site.test.js
// Le vrai site n'est jamais lancé : ORCH_SITE_DIR pointe vers un faux server.js qui répond à /api/ping et note ses lancements.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'scripts', 'hooks.js');
const Site = require('../scripts/site');
const L = require('../scripts/lib');

const STUB = `
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')));
const port = Number(process.argv.find(a => a.startsWith('--port=')).split('=')[1]);
const noOpen = process.argv.includes('--no-open');
http.createServer((req, res) => {
  if (req.url === '/api/ping') return res.end(JSON.stringify({ app: 'orchestrateur-site', project: root, pid: process.pid, port }));
  if (req.url === '/quit') { res.end('bye'); return process.exit(0); }
  res.end('x');
}).listen(port, '127.0.0.1', () => {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ root, port, noOpen }) + '\\n');
  if (!noOpen) require('child_process').spawnSync(process.execPath, [process.env.ORCH_SITE_OPENER, 'http://127.0.0.1:' + port + '/']);
});
`;
const OPENER = `require('fs').appendFileSync(process.env.OPENER_LOG, process.argv[2] + '\\n');`;

const lines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const get = (port, p) => new Promise(res => {
  const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 500 }, x => { let b = ''; x.on('data', d => (b += d)); x.on('end', () => res(b)); });
  r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
});
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 80)); } };

// Environnement isolé : faux site, état, logs et projets dans un dossier temporaire.
async function withEnv(fn, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-site-'));
  const siteDir = path.join(tmp, 'site');
  fs.mkdirSync(siteDir);
  fs.writeFileSync(path.join(siteDir, 'server.js'), STUB);
  fs.writeFileSync(path.join(tmp, 'opener.js'), OPENER);
  const env = {
    ...process.env, ORCH_SITE: '', ORCH_SITE_DIR: siteDir, ORCH_SITE_STATE: path.join(tmp, 'state.json'), ORCH_SITE_LOG: path.join(tmp, 'warn.log'),
    ORCH_SITE_OPENER: path.join(tmp, 'opener.js'), STUB_LOG: path.join(tmp, 'stub.log'), OPENER_LOG: path.join(tmp, 'opener.log'), ...extra,
  };
  const projects = [];
  const newProject = () => { const d = path.join(tmp, `projet-${projects.length}`); fs.mkdirSync(d); projects.push(d); return d; };
  const chef = (dir, text = '/orchestrateur:chef essai') => spawnSync('node', [HOOKS, 'prompt-start'],
    { input: JSON.stringify({ prompt: text, cwd: dir, session_id: 's1' }), env: { ...env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  // Port où un faux site de ce projet répond (cherché parmi les ports du projet).
  const siteOf = async dir => until(async () => {
    for (const p of Site.portsFor(dir)) { let j = null; try { j = JSON.parse(await get(p, '/api/ping')); } catch {} if (j && j.project && Site.norm(j.project) === Site.norm(dir)) return p; }
    return null;
  });
  try {
    return await fn({ tmp, env, newProject, chef, siteOf, stubLog: env.STUB_LOG, openerLog: env.OPENER_LOG, warnLog: env.ORCH_SITE_LOG });
  } finally {
    for (const d of projects) for (const p of Site.portsFor(d)) { const b = await get(p, '/api/ping'); let j = null; try { j = JSON.parse(b); } catch {} if (j && Site.norm(j.project).startsWith(Site.norm(tmp))) await get(p, '/quit'); }
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

test('pas de doublon : 2e /chef du même projet ne relance rien ; navigateur ouvert une seule fois par mission', async () => {
  await withEnv(async ({ newProject, chef, siteOf, stubLog, openerLog }) => {
    const dir = newProject();
    const r1 = chef(dir);
    assert.strictEqual(r1.status, 0, r1.stderr);
    const port = await siteOf(dir);
    assert.ok(port, 'le site doit répondre');
    await until(() => lines(openerLog).length >= 1);
    // même mission : /chef de nouveau (cadrage), puis un autre message /chef
    assert.strictEqual(chef(dir, '/orchestrateur:chef encore').status, 0);
    assert.strictEqual(chef(dir, '/chef').status, 0);
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(lines(stubLog).length, 1, 'un seul lancement');
    assert.strictEqual(lines(openerLog).length, 1, 'une seule ouverture du navigateur');
    // nouvelle mission (journal archivé) : site réutilisé, pas relancé, navigateur rouvert une fois
    fs.rmSync(path.join(dir, '.orchestrator', 'events.jsonl'));
    await new Promise(r => setTimeout(r, 20)); // ts du nouveau start différent
    assert.strictEqual(chef(dir).status, 0);
    assert.ok(await until(() => lines(openerLog).length === 2));
    assert.strictEqual(lines(stubLog).length, 1, 'toujours un seul lancement');
    assert.strictEqual(await siteOf(dir), port, 'même port');
  });
});

test('2e projet : second serveur sur un autre port, le premier reste en place', async () => {
  await withEnv(async ({ newProject, chef, siteOf, stubLog }) => {
    const a = newProject(), b = newProject();
    chef(a);
    const pa = await siteOf(a);
    chef(b);
    const pb = await siteOf(b);
    assert.ok(pa && pb, 'deux sites');
    assert.notStrictEqual(pa, pb);
    assert.ok(await get(pa, '/api/ping'), 'le premier répond toujours');
    const roots = lines(stubLog).map(l => Site.norm(JSON.parse(l).root)).sort();
    assert.deepStrictEqual(roots, [Site.norm(a), Site.norm(b)].sort());
    // un port du projet occupé par un autre programme est sauté
    const c = newProject();
    const squatter = http.createServer((q, s) => s.end('autre')).listen(Site.portsFor(c)[0], '127.0.0.1');
    const squatting = await new Promise(r => squatter.once('listening', () => r(true)).once('error', () => r(false)));
    try {
      chef(c);
      const pc = await siteOf(c);
      assert.ok(pc, 'un site pour le projet');
      if (squatting) assert.notStrictEqual(pc, Site.portsFor(c)[0], 'port occupé évité');
    } finally { squatter.close(); }
  });
});

test('site introuvable : le hook réussit, start est écrit, avertissement journalisé', async () => {
  await withEnv(async ({ newProject, chef, stubLog, warnLog }) => {
    const dir = newProject();
    const r = chef(dir);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(L.readEvents(path.join(dir, '.orchestrator'))[0].event, 'start');
    assert.strictEqual(lines(stubLog).length, 0);
    assert.match(fs.readFileSync(warnLog, 'utf8'), /site WARN site de suivi introuvable/);
  }, { ORCH_SITE_DIR: path.join(os.tmpdir(), 'orch-site-inexistant-xyz') });
});

test('ORCH_SITE=off : rien ne se lance, rien ne s\'ouvre, start est quand même écrit', async () => {
  for (const off of ['off', 'OFF', '0', 'false']) {
    await withEnv(async ({ newProject, chef, stubLog, openerLog, warnLog }) => {
      const dir = newProject();
      assert.strictEqual(chef(dir).status, 0);
      assert.strictEqual(L.readEvents(path.join(dir, '.orchestrator'))[0].event, 'start');
      await new Promise(r => setTimeout(r, 400));
      assert.strictEqual(lines(stubLog).length, 0);
      assert.strictEqual(lines(openerLog).length, 0);
      assert.ok(!fs.existsSync(warnLog), 'pas même un avertissement');
    }, { ORCH_SITE: off });
  }
});

test('hors mission : un autre prompt ne lance rien', async () => {
  await withEnv(async ({ newProject, chef, stubLog }) => {
    const dir = newProject();
    chef(dir, 'bonjour');
    chef(dir, 'parle de /orchestrateur:chef');
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(lines(stubLog).length, 0);
    assert.ok(!fs.existsSync(path.join(dir, '.orchestrator')));
  });
});

test('ensureSite ne lève jamais (dossier du site illisible, état non inscriptible)', async () => {
  const warns = [];
  const r = await Site.ensureSite({ root: os.tmpdir(), missionKey: 'k', env: { ORCH_SITE_DIR: '\0bad' }, warn: m => warns.push(m) });
  assert.ok(['missing', 'error'].includes(r.status));
  assert.ok(warns.length >= 1);
  const r2 = await Site.ensureSite({ root: os.tmpdir(), missionKey: 'k', env: { ORCH_SITE: 'off' }, warn: () => { throw new Error('ne doit pas être appelé'); } });
  assert.strictEqual(r2.status, 'disabled');
});

test('port dérivé du chemin : stable, dans 4317-4816, différent d\'un projet à l\'autre', () => {
  const a = Site.portsFor(path.join(os.tmpdir(), 'projet-a')), b = Site.portsFor(path.join(os.tmpdir(), 'projet-b'));
  assert.deepStrictEqual(a, Site.portsFor(path.join(os.tmpdir(), 'projet-a')));
  assert.ok(a.every(p => p >= 4317 && p < 4817));
  assert.notStrictEqual(a[0], b[0]);
  assert.strictEqual(new Set(a).size, a.length);
});
