// Lancement automatique du site de suivi (orchestrateur-site) au début d'une mission /chef.
// Ne lève jamais : ensureSite renvoie un statut et laisse un avertissement via `warn`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BASE_PORT = 4317;   // le port par défaut du site ; le port d'un projet en dérive
const PORT_SPAN = 500;
const TRIES = 8;          // ports essayés à partir de celui du projet
const PROBE_MS = 400;

const disabled = env => /^(off|0|false|non|no)$/i.test(String(env.ORCH_SITE || '').trim());
const siteDir = env => env.ORCH_SITE_DIR || path.join(os.homedir(), '.claude', 'plugins-src', 'orchestrateur-site');
// Mémoire « navigateur déjà ouvert pour cette mission », hors .orchestrator/ et hors du cache du plugin.
const stateFile = env => env.ORCH_SITE_STATE || path.join(os.homedir(), '.claude', 'orchestrateur-site-state.json');

function norm(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// FNV-1a du chemin : même projet, même port de départ.
function basePort(root) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(norm(root))) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return h % PORT_SPAN;
}
const portsFor = root => Array.from({ length: TRIES }, (_, i) => BASE_PORT + (basePort(root) + i) % PORT_SPAN);

// 'same' : un site de CE projet répond ; 'free' : rien n'écoute ; 'busy' : autre chose (autre projet, autre programme).
function probe(port, root) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: PROBE_MS, headers: { host: `127.0.0.1:${port}` } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (body.length < 4096) body += d; });
      res.on('error', () => resolve('busy'));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.app === 'orchestrateur-site' && norm(String(j.project)) === norm(root) ? 'same' : 'busy');
        } catch { resolve('busy'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('busy'); });
    req.on('error', e => resolve(e && e.code === 'ECONNREFUSED' ? 'free' : 'busy'));
  });
}

// Un site déjà là pour ce projet (n'importe lequel des ports essayés) prime sur un port libre.
async function findPort(root) {
  const ports = portsFor(root);
  const res = await Promise.all(ports.map(p => probe(p, root)));
  const i = res.indexOf('same');
  if (i >= 0) return { port: ports[i], running: true };
  const j = res.indexOf('free');
  return j >= 0 ? { port: ports[j], running: false } : null;
}

function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.on('error', () => {}); // ENOENT arrive en asynchrone : ne doit pas faire tomber le hook
  child.unref();
  return child;
}

// ORCH_SITE_OPENER : script Node appelé avec l'URL à la place du navigateur (tests).
function openUrl(url, env) {
  if (env.ORCH_SITE_OPENER) return detached(process.execPath, [env.ORCH_SITE_OPENER, url]);
  if (process.platform === 'win32') return detached('rundll32', ['url.dll,FileProtocolHandler', url]);
  return detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

const readState = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

// root : racine du projet ; missionKey : identifiant stable de la mission (ts de son 1er événement).
// Le navigateur s'ouvre une fois par (projet, mission) ; un site déjà lancé n'est jamais relancé.
async function ensureSite({ root, missionKey, env = process.env, warn = () => {} }) {
  try {
    if (disabled(env)) return { status: 'disabled' };
    const server = path.join(siteDir(env), 'server.js');
    if (!fs.existsSync(server)) {
      warn(`site de suivi introuvable : ${server}`);
      return { status: 'missing' };
    }
    const found = await findPort(root);
    if (!found) {
      warn(`site de suivi : aucun port libre parmi ${portsFor(root).join(', ')}`);
      return { status: 'no-port' };
    }
    const url = `http://127.0.0.1:${found.port}/`;
    const file = stateFile(env);
    const state = readState(file);
    const key = norm(root);
    const opened = !!missionKey && !!state[key] && state[key].mission === missionKey;
    if (found.running) {
      if (!opened) openUrl(url, env);
    } else {
      // Le site s'ouvre lui-même dans le navigateur quand il est prêt ; --no-open si c'est déjà fait pour cette mission.
      detached(process.execPath, [server, path.resolve(root), `--port=${found.port}`, ...(opened ? ['--no-open'] : [])], { cwd: path.dirname(server) });
    }
    if (!opened && missionKey) {
      try { writeState(file, { ...state, [key]: { mission: missionKey, port: found.port } }); } catch (e) { warn(`site de suivi : état non écrit (${e.code || e.message})`); }
    }
    return { status: found.running ? 'reused' : 'launched', port: found.port, opened: !opened };
  } catch (e) {
    try { warn(`site de suivi : ${e && e.stack || e}`); } catch {}
    return { status: 'error' };
  }
}

module.exports = { ensureSite, probe, findPort, portsFor, norm, disabled };
