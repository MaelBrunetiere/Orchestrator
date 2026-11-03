// Outils communs aux hooks et à log-event. Node pur, aucune dépendance.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TAG_RE = /^\s*\[mission:([^\s\]]+)\s+task:([^\s\]]+)\]/;
const FIELDS = ['ts', 'mission_id', 'event', 'agent', 'model', 'task_id', 'summary', 'tokens', 'tokens_source', 'source'];

// ISO 8601 en heure locale avec fuseau, ex. 2026-10-26T21:03:12.345+01:00
function nowISO(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

function parseTag(text) {
  const m = TAG_RE.exec(text || '');
  return m ? { mission_id: m[1], task_id: m[2] } : null;
}

// Remonte depuis chaque point de départ jusqu'à trouver un dossier .orchestrator/.
function findOrchDir(starts) {
  const home = path.resolve(os.homedir());
  for (const s of starts.filter(Boolean)) {
    let dir = path.resolve(s);
    for (;;) {
      const cand = path.join(dir, '.orchestrator');
      if (dir !== home && fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function ensureOrchDir(starts) {
  const found = findOrchDir(starts);
  if (found) return found;
  const base = starts.filter(Boolean)[0];
  if (!base) return null;
  const dir = path.join(path.resolve(base), '.orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Verrou par mkdir (atomique) : deux workers parallèles ne s'écrasent pas.
function withLock(orchDir, fn) {
  const lock = path.join(orchDir, '.lock');
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() - start > 5000) break; // on écrit quand même plutôt que perdre l'événement
      sleep(50);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

function readJSON(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// Écrit une ligne au schéma exact, champs optionnels à la fin.
function appendEvent(orchDir, ev, extra = {}) {
  const rec = {};
  for (const k of FIELDS) rec[k] = ev[k] === undefined ? null : ev[k];
  if (rec.tokens === null) rec.tokens_source = null;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) rec[k] = v;
  fs.appendFileSync(path.join(orchDir, 'events.jsonl'), JSON.stringify(rec) + '\n');
}

function readEvents(orchDir) {
  try {
    return fs.readFileSync(path.join(orchDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

// Mission active = events.jsonl existe et ne contient pas d'événement done.
// Un événement `start` (écrit par le hook UserPromptSubmit au lancement de /chef, avec un
// mission_id provisoire) annonce seulement le cadrage : il ne désigne pas la mission.
function activeMission(orchDir) {
  const evs = readEvents(orchDir);
  if (!evs || evs.some(e => e.event === 'done')) return null;
  const real = evs.filter(e => e.event !== 'start');
  return real.length ? real[0].mission_id : '?';
}

function readTranscript(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Tokens d'un worker : somme par message API unique (le transcript répète
// chaque message par bloc de contenu, la dernière occurrence est complète).
function sumUsage(entries) {
  const byId = new Map();
  let model = null;
  for (const e of entries) {
    const m = e.type === 'assistant' && e.message;
    if (!m || !m.usage) continue;
    byId.set(m.id || `${byId.size}`, m.usage);
    if (m.model && !String(m.model).startsWith('<')) model = m.model;
  }
  if (!byId.size) return null;
  let tokens = 0, cacheRead = 0;
  for (const u of byId.values()) {
    tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    cacheRead += u.cache_read_input_tokens || 0;
  }
  return { tokens, cacheRead, model };
}

function firstPrompt(entries) {
  for (const e of entries) {
    if (e.type !== 'user' || !e.message) continue;
    const c = e.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) { const t = c.find(b => b.type === 'text'); if (t) return t.text; }
  }
  return '';
}

// Compte rendu : dans Desktop il part par l'outil SubagentHandback, sinon c'est le dernier texte.
function reportText(entries, lastMessage) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const c = entries[i].type === 'assistant' && entries[i].message && entries[i].message.content;
    if (!Array.isArray(c)) continue;
    const h = c.find(b => b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input && b.input.message);
    if (h) return h.input.message;
  }
  if (lastMessage) return lastMessage;
  for (let i = entries.length - 1; i >= 0; i--) {
    const c = entries[i].type === 'assistant' && entries[i].message && entries[i].message.content;
    const t = Array.isArray(c) && c.find(b => b.type === 'text' && b.text);
    if (t) return t.text;
  }
  return '';
}

// Retire la mise en forme Markdown autour d'une ligne de compte rendu, sans toucher au contenu :
// les « _ » (test_dedup_phase2.py), les « * » isolés (*.py) et les `code` en ligne restent.
// Retirés : le gras ** (partout), la puce « * » de tête, l'emphase ou le code collés au libellé
// (**STATUT**:, __FAIT__:, `STATUT`:) et un code qui entoure toute la ligne.
function cleanReportLine(l) {
  return l
    .replace(/\*\*/g, '')
    .replace(/^\*\s+/, '')
    .replace(/^[*_`]{1,2}(STATUT|FAIT|AVIS)[*_`]{1,2}(?=\s*:)/i, '$1')
    .replace(/^`+|`+$/g, '')
    .trim();
}

// Lit STATUT et FAIT (AVIS pour le conseiller). Sans ligne STATUT lisible en tête,
// on ne devine pas : statut « illisible » (journalisé en worker_done) et alerte au chef.
function parseReport(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const clean = cleanReportLine;
  const m = lines.length ? /^STATUT\s*:\s*(ok|partiel|échec|echec)(?![\p{L}\p{N}])/iu.exec(clean(lines[0])) : null;
  const fait = lines.map(clean).find(l => /^FAIT\s*:/i.test(l)) || lines.map(clean).find(l => /^AVIS\s*:/i.test(l));
  if (!m) {
    const head = lines.length ? clean(lines[0]).slice(0, 80) : '(compte rendu vide)';
    return { status: 'illisible', summary: `statut illisible : ${head}` };
  }
  const status = m[1].toLowerCase().replace('echec', 'échec');
  const s = `STATUT: ${status}` + (fait ? ` | ${fait}` : '');
  const f = lines.map(clean).find(l => /^FICHIERS\s*:/i.test(l));
  const fichiers = f ? f.replace(/^FICHIERS\s*:\s*/i, '').slice(0, 400) : null;
  return { status, summary: s.length > 240 ? s.slice(0, 237) + '...' : s, fichiers };
}

// Alias → ID complet. On préfère l'ID réellement vu chez un worker de la mission,
// la table ne sert qu'en repli (à mettre à jour quand les modèles changent).
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
function fullModelId(model, seen = []) {
  if (!model || /^claude-/.test(model)) return model || null;
  const alias = model.toLowerCase();
  const hit = seen.filter(Boolean).reverse().find(m => m.includes(alias));
  return hit || MODEL_IDS[alias] || model;
}

const isUserPrompt = e => {
  const c = e.message && e.message.content;
  return e.type === 'user' && !e.isMeta && !e.isSidechain &&
    (typeof c === 'string' || (Array.isArray(c) && c.some(b => b.type === 'text')));
};
// Entrée qui lance une mission : le skill chef/reprise appelé par le modèle (outil Skill) ou tapé par Maël (balise de commande).
const launchesMission = e => {
  const c = e.message && e.message.content;
  if (e.type === 'user') return typeof c === 'string' && /<command-name>\/?(?:orchestrateur:)?(chef|reprise)</.test(c);
  return e.type === 'assistant' && Array.isArray(c) &&
    c.some(b => b.type === 'tool_use' && b.name === 'Skill' && /(^|:)(chef|reprise)$/.test(String(b.input && b.input.skill)));
};

// Tokens du chef : pour chaque session inscrite dans .chef.json ({ transcripts, registered }), ses messages
// assistant (hors sidechain) entre le prompt qui a lancé la mission et endTs (par défaut maintenant).
// « Prompt qui a lancé la mission » = le dernier vrai prompt qui précède l'appel du skill chef/reprise le plus récent
// avant l'inscription de la session : une réponse « oui » en cours de planification ne coupe pas le départ.
// Sans appel de skill retrouvé, la fenêtre part de l'heure d'inscription (planTs si elle manque, vieux .chef.json).
function chefUsage(chef, { planTs, endTs } = {}) {
  const endMs = Date.parse(endTs || nowISO());
  const byId = new Map();
  for (const [sid, file] of Object.entries((chef && chef.transcripts) || {})) {
    const regMs = Date.parse(((chef.registered || {})[sid])) || Date.parse(planTs);
    const entries = readTranscript(file);
    let launch = -1;
    entries.forEach((e, i) => { if (Date.parse(e.timestamp) <= regMs && launchesMission(e)) launch = i; });
    let fromMs = regMs;
    for (let i = launch; i >= 0; i--) if (isUserPrompt(entries[i])) { fromMs = Date.parse(entries[i].timestamp); break; }
    for (const e of entries) {
      const m = e.type === 'assistant' && !e.isSidechain && e.message;
      const t = Date.parse(e.timestamp);
      if (m && m.usage && t >= fromMs && t <= endMs) byId.set(m.id || `${file}:${byId.size}`, { u: m.usage, model: m.model });
    }
  }
  if (!byId.size) return null;
  const out = { tokens: 0, cacheRead: 0, byModel: {} };
  for (const { u, model } of byId.values()) {
    const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    out.tokens += t;
    out.cacheRead += u.cache_read_input_tokens || 0;
    if (model && !String(model).startsWith('<')) out.byModel[model] = (out.byModel[model] || 0) + t;
  }
  return out;
}

// Fichier SORTIE d'une tâche : .orchestrator/out/<mission>/<tâche>-<agent>.md, ou à défaut tout
// fichier de ce dossier qui commence par « <tâche>- » (le chef peut suffixer le nom). null si absent.
function findOutput(orchDir, mission, task, agent) {
  if (!mission || !task) return null;
  const dir = path.join(orchDir, 'out', mission);
  const exact = path.join(dir, `${task}-${agent}.md`);
  if (fs.existsSync(exact)) return exact;
  try {
    const hit = fs.readdirSync(dir).find(f => f.startsWith(`${task}-`));
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
}

const stripPrefix = t => (t ? String(t).replace(/^.*:/, '') : null);
const normId = id => (id ? String(id).replace(/^agent-/, '') : null);

// Effort. EFFORT_DEFAULT = champ `effort` du frontmatter de chaque agent (un test vérifie la concordance) :
// il s'applique quand le chef ne passe pas `effort` à l'appel, donc il est au moins égal au plancher.
// Doublé dans hooks/register.ts (le mod ne peut pas charger ce fichier).
// 0.4.2 : medium par défaut pour dev et executant ; high seulement là où le plancher l'impose.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_PLAN = ['medium', 'high', 'xhigh']; // valeurs permises dans plan.json
const EFFORT_DEFAULT = { explorateur: 'medium', executant: 'medium', dev: 'medium', 'dev-critique': 'high', relecteur: 'high', conseiller: 'high' };
const EFFORT_HIGH_ONLY = ['dev-critique', 'relecteur', 'conseiller']; // architecture, sécurité, matériel, relecture, conseiller
const effortFloor = role => (EFFORT_HIGH_ONLY.includes(role) ? 'high' : 'medium');
// Raison du refus d'un effort demandé à l'appel (null = accepté ; absent = le frontmatter s'applique).
function effortRefusal(role, effort) {
  if (effort === undefined || effort === null || !EFFORT_DEFAULT[role]) return null;
  const e = String(effort).toLowerCase();
  if (!EFFORTS.includes(e)) return `effort « ${effort} » non reconnu pour ${role} (${EFFORTS.join(', ')}).`;
  const floor = effortFloor(role);
  if (EFFORTS.indexOf(e) < EFFORTS.indexOf(floor)) return `${role} ne descend pas sous l'effort ${floor} (demandé : ${effort}).`;
  // Plafond : dev, executant et explorateur restent en medium (regles-chef.md §1, Effort). Une tâche plus dure se découpe ou passe en dev-critique.
  if (!EFFORT_HIGH_ONLY.includes(role) && EFFORTS.indexOf(e) > EFFORTS.indexOf('medium')) return `${role} reste en effort medium (demandé : ${effort}) : découpe la tâche, ou prends dev-critique pour l'architecture, la sécurité ou le matériel.`;
  return null;
}

module.exports = {
  EFFORTS, EFFORT_PLAN, EFFORT_DEFAULT, effortFloor, effortRefusal,
  nowISO, parseTag, findOrchDir, ensureOrchDir, withLock, readJSON, writeJSON,
  appendEvent, readEvents, activeMission, readTranscript, sumUsage, firstPrompt,
  reportText, parseReport, cleanReportLine, findOutput, stripPrefix, normId, fullModelId, chefUsage, sleep,
};
