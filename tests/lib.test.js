// Tests de scripts/lib.js (lecture des comptes rendus) : node --test tests/lib.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../scripts/lib');

test('parseReport : les « _ » du summary sont conservés (noms de fichiers, de fonctions)', () => {
  const r = L.parseReport('STATUT: ok\nFAIT: créé test_dedup_phase2.py, lancé avec -m unittest ; __init__ intact\nPAS FAIT: rien');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.summary, 'STATUT: ok | FAIT: créé test_dedup_phase2.py, lancé avec -m unittest ; __init__ intact');
});

test('parseReport : « * » isolés et `code` en ligne conservés', () => {
  const r = L.parseReport('STATUT: ok\nFAIT: glob *.py sur `score_all`, 2*3 = 6');
  assert.strictEqual(r.summary, 'STATUT: ok | FAIT: glob *.py sur `score_all`, 2*3 = 6');
});

test('parseReport : la mise en forme Markdown autour des libellés reste tolérée', () => {
  for (const head of ['**STATUT: ok**', '**STATUT**: ok', '__STATUT__: ok', '`STATUT: ok`', '* STATUT: ok', '*STATUT*: ok', 'STATUT: **ok**']) {
    const r = L.parseReport(`${head}\n**FAIT:** fichier test_x.py\nDOUTES: aucun`);
    assert.strictEqual(r.status, 'ok', head);
    assert.strictEqual(r.summary, 'STATUT: ok | FAIT: fichier test_x.py', head);
  }
});

test('parseReport : AVIS (conseiller), échec sans accent, ligne STATUT absente', () => {
  assert.strictEqual(L.parseReport('STATUT: echec\nFAIT: x_y').status, 'échec');
  assert.strictEqual(L.parseReport('STATUT: ok\nAVIS: garder snake_case').summary, 'STATUT: ok | AVIS: garder snake_case');
  const bad = L.parseReport('Voici mon travail_fini');
  assert.strictEqual(bad.status, 'illisible');
  assert.match(bad.summary, /Voici mon travail_fini/);
});

// --- chefUsage : fenêtre de comptage des tokens du chef ---
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = s => `2026-10-27T08:${s}Z`; // T('47:10.000') = 08:47:10Z
const prompt = (ts, text) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const toolResult = ts => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
const skillCall = (ts, id, skill = 'orchestrateur:chef') => ({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
// Un message assistant de 15 tokens (5 + 4 + 6), 100 en cache.
const asst = (ts, id, model = 'claude-sonnet-5-5') => ({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 5, cache_creation_input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'x' }] } });
function transcript(...entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('chefUsage : un « oui » en cours de planification ne change pas le total', () => {
  const avecOui = transcript(
    prompt(T('47:00.000'), 'brief de la mission'), skillCall(T('47:05.000'), 'm1'), asst(T('47:10.000'), 'm2'), toolResult(T('47:11.000')),
    prompt(T('50:00.000'), 'oui'), asst(T('50:05.000'), 'm3'), asst(T('52:00.000'), 'm4'));
  const sansOui = transcript(
    prompt(T('47:00.000'), 'brief de la mission'), skillCall(T('47:05.000'), 'm1'), asst(T('47:10.000'), 'm2'),
    asst(T('50:05.000'), 'm3'), asst(T('52:00.000'), 'm4'));
  const reg = T('52:12.000'), endTs = T('57:15.000');
  const a = L.chefUsage({ transcripts: { s: avecOui }, registered: { s: reg } }, { endTs });
  const b = L.chefUsage({ transcripts: { s: sansOui }, registered: { s: reg } }, { endTs });
  assert.strictEqual(a.tokens, 10 + 3 * 15); // appel du skill (10) + m2, m3, m4 : m3 et m4 viennent après le « oui »
  assert.strictEqual(a.tokens, b.tokens);
  assert.strictEqual(a.cacheRead, 300);
});

// Commande tapée, telle que Claude Code l'écrit dans le transcript (relevé dans de vrais transcripts) :
// une entrée user dont le contenu est une chaîne à trois balises, suivie d'une entrée isMeta qui porte le texte du skill.
const typed = (ts, name, args) => [
  { type: 'user', timestamp: ts, message: { role: 'user', content: `<command-message>${name.replace(/^\//, '')}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>` } },
  { type: 'user', isMeta: true, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: C:\\x\\skills\\chef\n\nTu passes en MODE CHEF' }] } },
];

test('chefUsage : rien avant le prompt de lancement ni après le done (commande tapée avec arguments)', () => {
  for (const name of ['/orchestrateur:chef', '/chef']) {
    const file = transcript(
      asst(T('05:00.000'), 'avant'), prompt(T('40:00.000'), 'autre sujet'), asst(T('41:00.000'), 'avant2'),
      ...typed(T('47:00.000'), name, 'leger refaire les tests\nsur deux lignes'), asst(T('47:30.000'), 'dans1'),
      asst(T('56:00.000'), 'dans2'), asst(T('58:00.000'), 'apres'));
    const u = L.chefUsage({ transcripts: { s: file }, registered: { s: T('52:12.000') } }, { endTs: T('57:00.000') });
    assert.strictEqual(u.tokens, 30, name); // dans1 + dans2 seulement (commande tapée par Maël = lancement)
  }
});

test('chefUsage : un « oui » après une commande tapée ne coupe pas non plus le départ', () => {
  const file = transcript(
    ...typed(T('47:00.000'), '/orchestrateur:chef', 'leger x'), asst(T('47:30.000'), 'a1'),
    prompt(T('50:00.000'), 'oui'), asst(T('50:30.000'), 'a2'));
  assert.strictEqual(L.chefUsage({ transcripts: { s: file }, registered: { s: T('52:12.000') } }, { endTs: T('57:00.000') }).tokens, 30);
});

test('chefUsage : le skill reprise lance aussi la fenêtre ; sans skill, elle part de l\'inscription', () => {
  const reprise = transcript(asst(T('10:00.000'), 'vieux'), prompt(T('50:00.000'), 'brief de reprise'), skillCall(T('50:01.000'), 'r1', 'orchestrateur:reprise'), asst(T('51:00.000'), 'r2'));
  assert.strictEqual(L.chefUsage({ transcripts: { s: reprise }, registered: { s: T('50:02.000') } }, { endTs: T('57:00.000') }).tokens, 25);
  const nu = transcript(asst(T('10:00.000'), 'vieux'), asst(T('53:00.000'), 'n1'), asst(T('54:00.000'), 'n2'));
  assert.strictEqual(L.chefUsage({ transcripts: { s: nu }, registered: { s: T('52:00.000') } }, { endTs: T('57:00.000') }).tokens, 30);
});

test('chefUsage : un transcript hors fenêtre est ignoré (session obsolète), une session de la mission compte', () => {
  // Session Opus restée inscrite : tous ses messages datent d'avant son inscription, aucun lancement de mission.
  const obsolete = transcript(prompt(T('05:00.000'), 'autre mission'), asst(T('06:00.000'), 'o2', 'claude-opus-5-5'), asst(T('23:20.000'), 'o3', 'claude-opus-5-5'));
  const chef = transcript(prompt(T('47:00.000'), 'brief'), skillCall(T('47:05.000'), 'c1'), asst(T('48:00.000'), 'c2'));
  const reg = { stale: T('52:12.000'), chef: T('52:12.000') };
  const u = L.chefUsage({ transcripts: { stale: obsolete, chef }, registered: reg }, { endTs: T('57:00.000') });
  assert.deepStrictEqual(Object.keys(u.byModel), ['claude-sonnet-5-5'], 'aucun token Opus de la session obsolète');
  assert.strictEqual(u.tokens, 25);
  assert.strictEqual(L.chefUsage({ transcripts: { stale: obsolete }, registered: { stale: T('52:12.000') } }, { endTs: T('57:00.000') }), null);
});

test('parseReport : summary tronqué à 240 caractères, sans toucher au reste', () => {
  const r = L.parseReport(`STATUT: ok\nFAIT: ${'a_b '.repeat(100)}`);
  assert.strictEqual(r.summary.length, 240);
  assert.ok(r.summary.endsWith('...'));
  assert.ok(r.summary.includes('a_b a_b'));
});
