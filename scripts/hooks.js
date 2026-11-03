// Hooks déterministes de l'orchestrateur. Usage : node hooks.js <pre-agent|post-agent|post-agent-fail|subagent-stop|guard>
// Ne bloque jamais la session sur une erreur interne : on journalise dans errors.log et on sort 0.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const Site = require('./site');

const HERE = __dirname;
const sub = process.argv[2];
const READ_ONLY_AGENTS = ['explorateur', 'relecteur', 'conseiller'];
const ROLES = ['explorateur', 'executant', 'dev', 'dev-critique', 'relecteur', 'conseiller'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];

function debug(p) {
  if (!fs.existsSync(path.join(HERE, 'debug.on'))) return;
  const r = p.tool_response;
  fs.appendFileSync(path.join(HERE, 'debug.log'), JSON.stringify({
    ts: L.nowISO(), sub, hook: p.hook_event_name, tool: p.tool_name, session_id: p.session_id,
    agent_id: p.agent_id, agent_type: p.agent_type, cwd: p.cwd, keys: Object.keys(p),
    tool_input_keys: p.tool_input && Object.keys(p.tool_input),
    tool_response: r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'object' ? '[obj]' : v]).filter(([k]) => k !== 'content' && k !== 'prompt')) : typeof r,
    last_msg: p.last_assistant_message && String(p.last_assistant_message).slice(0, 80),
  }) + '\n');
}

const starts = p => [process.env.CLAUDE_PROJECT_DIR, p.cwd];
const agentsFile = orch => path.join(orch, '.agents.json');
const loadState = orch => {
  const s = L.readJSON(agentsFile(orch), {});
  return { pending: s.pending || {}, agents: s.agents || {}, stopped: s.stopped || {} };
};

// Sortie du hook : avertissement visible quand un compte rendu n'a pas de STATUT lisible.
let alert = null;

function writeEnd(orch, info, stop, extra = {}) {
  // Un STATUT ok dont le fichier SORTIE n'existe pas n'est pas un succès : worker_fail « sortie absente ».
  if (stop.status === 'ok' && !L.findOutput(orch, info.mission_id, info.task_id, info.agent)) {
    const want = `out/${info.mission_id}/${info.task_id}-${info.agent}.md`;
    stop = { ...stop, status: 'échec', summary: `sortie absente : ${want} (STATUT ok annoncé)` };
    alert = `Orchestrateur : ${info.task_id} (${info.agent}) a rendu STATUT ok mais ${want} n'existe pas. Chef : sortie manquante, une relance sur le même modèle (règles §3).`;
  }
  if (stop.status === 'illisible') {
    alert = `Orchestrateur : ${info.task_id} (${info.agent}) a rendu un compte rendu sans ligne STATUT lisible. Chef : traite-le comme insuffisant et vérifie la sortie.`;
  }
  L.appendEvent(orch, {
    ts: stop.ts, mission_id: info.mission_id, event: stop.status === 'échec' ? 'worker_fail' : 'worker_done',
    agent: info.agent, model: info.model || stop.model_seen, task_id: info.task_id, summary: stop.summary,
    tokens: stop.tokens, tokens_source: stop.tokens === null ? null : 'mesuré', source: 'hook',
  }, { tokens_cache_read: stop.cacheRead, fichiers: stop.fichiers, ...extra }); // fichiers : lu par scripts/rapport.js
}

// Effort réel d'un lancement : celui demandé à l'appel, sinon le défaut du frontmatter de l'agent.
const effortOf = (agent, requested) => requested || L.EFFORT_DEFAULT[agent] || null;

// PreToolUse(Agent) : refuse un effort sous le plancher du rôle (préfixe « garde-fou : », comme register.ts),
// puis mémorise le lancement (heure réelle) pour PostToolUse.
function preAgent(p) {
  const ti = p.tool_input || {};
  const tag = L.parseTag(ti.prompt);
  const role = L.stripPrefix(ti.subagent_type);
  const why = L.effortRefusal(role, ti.effort);
  if (why) {
    try {
      const o = tag && L.findOrchDir(starts(p));
      if (o) L.withLock(o, () => L.appendEvent(o, {
        ts: L.nowISO(), mission_id: tag.mission_id, event: 'blocked', agent: role, model: ti.model || null, task_id: tag.task_id,
        summary: `lancement refusé par le garde-fou : ${why}`.slice(0, 240), tokens: null, source: 'hook',
      }, { tool: 'Agent', tool_use_id: p.tool_use_id }));
    } finally { deny(`garde-fou : ${why}`); }
    return;
  }
  if (!tag) return;
  const orch = L.ensureOrchDir(starts(p));
  L.withLock(orch, () => {
    const st = loadState(orch);
    const agent = role || 'general-purpose';
    st.pending[p.tool_use_id] = {
      ...tag, agent, model_requested: ti.model || null, effort: effortOf(agent, ti.effort),
      description: ti.description || null, ts_start: L.nowISO(),
    };
    L.writeJSON(agentsFile(orch), st);
  });
}

// PostToolUse(Agent) : arrière-plan = au lancement ; premier plan = à la fin du worker.
function postAgent(p) {
  const ti = p.tool_input || {};
  const r = p.tool_response && typeof p.tool_response === 'object' && !Array.isArray(p.tool_response) ? p.tool_response : {};
  const orch = L.findOrchDir(starts(p));
  if (!orch) return;
  L.withLock(orch, () => {
    const st = loadState(orch);
    let pend = st.pending[p.tool_use_id];
    if (!pend) {
      const tag = L.parseTag(ti.prompt || r.prompt);
      if (!tag) return;
      const agent = L.stripPrefix(ti.subagent_type) || 'general-purpose';
      pend = { ...tag, agent, model_requested: ti.model || null, effort: effortOf(agent, ti.effort), description: ti.description || null, ts_start: L.nowISO() };
    }
    delete st.pending[p.tool_use_id];
    const agentId = L.normId(r.agentId) || `tool-${p.tool_use_id}`;
    const info = st.agents[agentId] || { ...pend, tool_use_id: p.tool_use_id };
    info.model = r.resolvedModel || info.model || pend.model_requested || null;
    st.agents[agentId] = info;

    if (!info.start_logged) {
      L.appendEvent(orch, {
        ts: pend.ts_start, mission_id: info.mission_id, event: 'worker_start', agent: info.agent,
        model: info.model, task_id: info.task_id, summary: pend.description, tokens: null, source: 'hook',
      }, { effort: info.effort });
      info.start_logged = true;
    }

    const stop = st.stopped[agentId];
    const finished = r.status === 'completed' || stop;
    if (finished && !info.done_logged) {
      const extra = typeof r.totalTokens === 'number' ? { total_tokens: r.totalTokens } : {};
      if (stop) {
        writeEnd(orch, info, stop, extra);
      } else {
        // SubagentStop n'a pas tourné : repli sur le résultat de l'outil.
        const text = Array.isArray(r.content) ? r.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
        const rep = L.parseReport(text);
        const u = r.usage || {};
        const tokens = r.usage ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : null;
        writeEnd(orch, info, { ts: L.nowISO(), ...rep, tokens, cacheRead: r.usage ? u.cache_read_input_tokens || 0 : undefined }, extra);
      }
      info.done_logged = true;
      delete st.stopped[agentId];
    }
    L.writeJSON(agentsFile(orch), st);
  });
}

// PostToolUseFailure(Agent) : lancement refusé (garde-fou) ou erreur de l'outil.
function postAgentFail(p) {
  const ti = p.tool_input || {};
  const tag = L.parseTag(ti.prompt);
  if (!tag) return;
  const orch = L.findOrchDir(starts(p));
  if (!orch) return;
  L.withLock(orch, () => {
    const st = loadState(orch);
    const pend = st.pending[p.tool_use_id] || {};
    delete st.pending[p.tool_use_id];
    const err = String(p.error || 'erreur inconnue').replace(/\s+/g, ' ');
    // Un refus du garde-fou de modèle (mod register.ts, messages « garde-fou : … ») est un refus, pas une
    // panne de lancement : événement blocked (comme un refus du hook guard), le reste reste worker_fail.
    // Le plafond de 2 workers n'en est pas un (le chef attend un compte rendu et relance) : worker_fail.
    const m = /garde-fou\s*:\s*(.*)$/.exec(err);
    const gf = m && !/^déjà \d+ workers/.test(m[1]) ? m : null;
    // Un refus d'effort déjà journalisé par preAgent (même tool_use_id) ne l'est pas deux fois.
    if (gf && (L.readEvents(orch) || []).some(e => e.event === 'blocked' && e.tool_use_id === p.tool_use_id)) return L.writeJSON(agentsFile(orch), st);
    L.appendEvent(orch, {
      ts: L.nowISO(), mission_id: tag.mission_id, event: gf ? 'blocked' : 'worker_fail', agent: L.stripPrefix(ti.subagent_type) || pend.agent || null,
      model: ti.model || null, task_id: tag.task_id,
      summary: (gf ? `lancement refusé par le garde-fou : ${gf[1]}` : `lancement refusé : ${err}`).slice(0, 240), tokens: null, source: 'hook',
    }, gf ? { tool: 'Agent' } : {});
    L.writeJSON(agentsFile(orch), st);
  });
}

// SubagentStop : lit le compte rendu et les tokens dans le transcript du worker.
function subagentStop(p) {
  const orch = L.findOrchDir(starts(p));
  if (!orch) return;
  const agentId = L.normId(p.agent_id);
  // Le hook peut tourner avant que la dernière ligne du transcript (le compte rendu)
  // soit écrite : on relit jusqu'à 3 s tant que la ligne STATUT n'apparaît pas.
  let entries = L.readTranscript(p.agent_transcript_path);
  for (let i = 0; i < 15 && L.parseReport(L.reportText(entries, p.last_assistant_message)).status === 'illisible'; i++) {
    L.sleep(200);
    entries = L.readTranscript(p.agent_transcript_path);
  }
  L.withLock(orch, () => {
    const st = loadState(orch);
    let info = st.agents[agentId];
    if (info && info.done_logged) return;
    if (!info) {
      const meta = L.readJSON(String(p.agent_transcript_path || '').replace(/\.jsonl$/, '.meta.json'), {});
      const pend = meta.toolUseId && st.pending[meta.toolUseId];
      const tag = pend || L.parseTag(L.firstPrompt(entries));
      if (!tag) return;
    }
    const rep = L.parseReport(L.reportText(entries, p.last_assistant_message));
    const u = L.sumUsage(entries);
    const stop = { ts: L.nowISO(), ...rep, tokens: u ? u.tokens : null, cacheRead: u ? u.cacheRead : undefined, model_seen: u && u.model };
    if (info && info.start_logged) {
      writeEnd(orch, info, stop);
      info.done_logged = true;
    } else {
      st.stopped[agentId] = stop; // premier plan : PostToolUse écrira start puis fin, dans l'ordre
    }
    L.writeJSON(agentsFile(orch), st);
  });
}

// Appel de log-event seul sur la ligne : renvoie { event, mission } (mission = valeur de --mission, ou null),
// ou null si la commande n'est pas exactement un appel de log-event.
function logEventCall(cmd) {
  if (/`|\$\(/.test(cmd)) return null;
  // Un « cd <dossier> && » en tête est toléré (le chef se place à la racine du projet).
  const m = /^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*)?(?:&\s*)?node(?:\.exe)?\s+("[^"]*log-event\.js"|'[^']*log-event\.js'|[^\s"']*log-event\.js)(?=\s|$)/i.exec(cmd);
  if (!m) return null;
  const rest = cmd.slice(m[0].length);
  if (/[;&|<>\r\n]/.test(rest.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""'))) return null;
  const toks = (rest.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
  const i = toks.indexOf('--mission');
  return { event: toks[0] || null, mission: i >= 0 ? toks[i + 1] || null : null };
}

// Shell de l'explorateur : liste blanche de commandes en lecture seule. Chaque
// morceau d'un pipeline ou d'une suite (&&, ;, |) doit y être. Renvoie la raison d'un refus.
const READ_CMDS = new Set(['ls', 'dir', 'find', 'wc', 'cat', 'head', 'tail', 'grep', 'rg', 'tree', 'du',
  'git', 'get-childitem', 'get-content', 'measure-object', 'gci', 'gc', 'measure', 'pwd', 'echo']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show']);
const FORBIDDEN_ARGS = { find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/, tree: /^-o$/, rg: /^--pre/, git: /^--output/ };
function readOnlyShellRefusal(cmd) {
  if (/`|\$\(|<\(|>\(/.test(cmd)) return 'substitution de commande interdite';
  const masked = cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, m => 'Q'.repeat(m.length));
  if (/>/.test(masked)) return 'redirection > interdite';
  const parts = [];
  let last = 0;
  masked.replace(/\|\||&&|[;|&\r\n]/g, (m, i) => { parts.push(cmd.slice(last, i)); last = i + m.length; return m; });
  parts.push(cmd.slice(last));
  for (const part of parts.map(s => s.trim()).filter(Boolean)) {
    const toks = part.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const name = path.basename(toks[0].replace(/["']/g, '')).toLowerCase().replace(/\.exe$/, '');
    if (!READ_CMDS.has(name)) return `« ${name} » n'est pas dans la liste blanche`;
    const args = toks.slice(1);
    if (name === 'git' && !GIT_READ.has((args.find(a => !a.startsWith('-')) || '').toLowerCase())) return 'git : seuls status, log, diff et show';
    if (args.some(a => a === '--in-place' || a.startsWith('--in-place='))) return '--in-place interdit';
    // -i ne veut dire « sur place » que pour sed/perl (hors liste) ; grep -i et rg -i restent permis.
    if (!['grep', 'rg'].includes(name) && args.includes('-i')) return '-i interdit';
    const bad = FORBIDDEN_ARGS[name];
    if (bad && args.some(a => bad.test(a))) return `option interdite pour ${name}`;
  }
  return null;
}

// Commandes jamais permises à un worker du mode chef (les règles « ask » ne
// tiennent pas en mode auto de Desktop : le classifieur tranche à leur place).
const WORKER_FORBIDDEN = [
  [/^git$/, /^(commit|push)$|^reset$|^clean$|^checkout$/, 'git commit/push/reset/clean/checkout'],
  [/^(rm|rmdir|del|erase|rd|remove-item|ri)$/, null, 'suppression de fichiers'],
  [/^(npm|pnpm|yarn)$/, /^(install|i|add|ci)$/, 'installation de paquets npm'],
  [/^(pip|pip3)$/, /^install$/, 'installation de paquets pip'],
  [/^(winget|choco|scoop)$/, /^install$/, 'installation de logiciels'],
];
function workerShellRefusal(cmd) {
  const masked = cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, m => 'Q'.repeat(m.length));
  const parts = [];
  let last = 0;
  masked.replace(/\|\||&&|[;|&\r\n]/g, (m, i) => { parts.push(cmd.slice(last, i)); last = i + m.length; return m; });
  parts.push(cmd.slice(last));
  for (const part of parts.map(s => s.trim()).filter(Boolean)) {
    const toks = (part.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/["']/g, ''));
    // « python -m pip install » / « py -m pip install » : on juge la commande après -m.
    const m = toks.findIndex((t, i) => t === '-m' && /^(python3?|py)(\.exe)?$/i.test(path.basename(toks[i - 1] || '')));
    const words = m >= 0 ? toks.slice(m + 1) : toks;
    const name = path.basename(words[0] || '').toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(1);
    const sub = (args.find(a => !a.startsWith('-')) || '').toLowerCase();
    if (name === 'xargs' && args.length) { const r = workerShellRefusal(args.filter(a => !a.startsWith('-')).join(' ')); if (r) return r; }
    if (name === 'find' && (args.includes('-delete') || /(^|\s)-exec(dir)?\s+(rm|del)\b/.test(args.join(' ')))) return 'suppression de fichiers';
    if (name === 'git' && (sub === 'reset' && !args.includes('--hard') || sub === 'checkout' && !args.includes('--'))) continue;
    for (const [cmdRe, subRe, label] of WORKER_FORBIDDEN) {
      if (cmdRe.test(name) && (!subRe || subRe.test(sub))) return label;
    }
  }
  return null;
}

// /orchestrateur:chef tapé : le dossier .orchestrator/ existe et l'événement start est écrit tout de suite,
// avant toute planification, pour que le tableau de bord voie la mission dès le cadrage. Le mission_id est
// provisoire (le chef choisit le vrai au plan) ; lib.activeMission ignore start.
const CHEF_PROMPT = /^\s*\/(?:orchestrateur:)?chef(?:\s|$)/i;
let siteJob = null; // site de suivi à lancer une fois le hook terminé (async), posé par promptStart
function promptStart(p) {
  const prompt = String(p.prompt || '');
  if (!CHEF_PROMPT.test(prompt)) return;
  const orch = L.ensureOrchDir(starts(p));
  if (!orch) return;
  L.withLock(orch, () => {
    const evs = L.readEvents(orch) || [];
    if (evs.some(e => e.event !== 'start')) return; // mission en cours : le skill demande lui-même reprise ou clôture
    if (evs.length) return; // start déjà écrit
    const now = L.nowISO();
    const task = prompt.replace(CHEF_PROMPT, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    L.appendEvent(orch, {
      ts: now, mission_id: `cadrage-${now.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`, event: 'start',
      agent: 'chef', model: null, task_id: null, summary: task ? `cadrage : ${task}` : 'cadrage', tokens: null, source: 'hook',
    });
  });
  // Le site de suivi se lance (ou se retrouve) pour ce projet ; la mission est identifiée par l'heure de son 1er événement.
  const first = (L.readEvents(orch) || [])[0];
  if (first) siteJob = { root: path.dirname(orch), missionKey: first.ts };
}

// Jamais fatal ni bloquant : tout échec laisse une ligne WARN dans errors.log, délai plafonné à 2 s.
async function launchSite() {
  const warn = m => { try { fs.appendFileSync(process.env.ORCH_SITE_LOG || path.join(HERE, 'errors.log'),`${L.nowISO()} site WARN ${m}\n`); } catch {} };
  try {
    let timer;
    const cap = new Promise(r => { timer = setTimeout(() => { warn('site de suivi : délai de 2 s dépassé'); r(); }, 2000); });
    await Promise.race([Site.ensureSite({ ...siteJob, warn }), cap]);
    clearTimeout(timer);
  } catch (e) { warn(String(e && e.stack || e)); }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// Mission, agent et tâche d'un refus. Un worker est retrouvé par son agent_id (.agents.json),
// sinon par son rôle s'il n'y en a qu'un seul en cours, sinon par le tag de son premier prompt.
function blockedContext(orch, p, mission) {
  if (!p.agent_id) return { mission_id: mission, agent: 'chef', task_id: null };
  const role = L.stripPrefix(p.agent_type);
  const st = loadState(orch);
  let info = st.agents[L.normId(p.agent_id)];
  if (!info) {
    const cand = Object.values(st.pending).filter(x => x.agent === role);
    if (cand.length === 1) info = cand[0];
  }
  if (!info) info = L.parseTag(L.firstPrompt(L.readTranscript(p.agent_transcript_path)));
  return { mission_id: (info && info.mission_id) || mission, agent: role, task_id: (info && info.task_id) || null };
}

// Chaque refus du guard laisse un événement blocked (source hook) : outil et motif court.
// Rien n'est écrit hors mission active : un événement seul ferait passer le dossier pour une mission sans plan.
function logBlocked(orch, p, motif) {
  L.withLock(orch, () => {
    const mission = L.activeMission(orch);
    if (!mission) return;
    const c = blockedContext(orch, p, mission);
    L.appendEvent(orch, {
      ts: L.nowISO(), mission_id: c.mission_id, event: 'blocked', agent: c.agent, model: null, task_id: c.task_id,
      summary: String(motif).replace(/\s+/g, ' ').slice(0, 160), tokens: null, source: 'hook',
    }, { tool: p.tool_name });
  });
}

// Journalise le refus puis le renvoie à Claude Code (le refus part même si le journal échoue).
function refuse(orch, p, reason, motif) {
  try { if (orch) logBlocked(orch, p, motif); } finally { deny(reason); }
}

const inside = (dir, file) => {
  const rel = path.relative(dir.toLowerCase(), file.toLowerCase());
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// PreToolUse(Bash|PowerShell|Edit|Write|...) : chef limité pendant une mission ; explorateur/relecteur en lecture seule.
function guard(p) {
  const tool = p.tool_name;
  const ti = p.tool_input || {};
  const orch = L.findOrchDir(starts(p));

  if (p.agent_id) { // un worker
    const role = L.stripPrefix(p.agent_type);
    if (ROLES.includes(role) && SHELL_TOOLS.includes(tool)) {
      const forbidden = workerShellRefusal(ti.command || '');
      if (forbidden) return refuse(orch, p, `REFUS DE SÉCURITÉ (hook, pas un échec) : ${forbidden} interdit aux workers. Arrête-toi et rends STATUT: échec avec « DOUTES: refus hook : ${forbidden} ».`, `${forbidden} interdit aux workers`);
    }
    if (role === 'explorateur' && SHELL_TOOLS.includes(tool)) {
      const why = readOnlyShellRefusal(ti.command || '');
      return why ? refuse(orch, p, `explorateur : shell en lecture seule (${why}). Commandes permises : ${[...READ_CMDS].join(', ')}, git status/log/diff/show.`, `shell en lecture seule : ${why}`) : undefined;
    }
    const f = ti.file_path || ti.notebook_path;
    if (!READ_ONLY_AGENTS.includes(role) || !EDIT_TOOLS.includes(tool)) return;
    if (f && orch && inside(orch, path.resolve(p.cwd || '.', f))) return;
    return refuse(orch, p, `${L.stripPrefix(p.agent_type)} est en lecture seule : écriture autorisée seulement sous .orchestrator/.`, 'écriture hors .orchestrator/ (agent en lecture seule)');
  }
  if (!orch) return;
  const chefFile = path.join(orch, '.chef.json');

  const call = SHELL_TOOLS.includes(tool) ? logEventCall(ti.command || '') : null;
  if (call) {
    // Une session principale devient « chef » de ce projet quand elle ouvre une mission (plan, aucune mission active)
    // ou parle de la mission ACTIVE (replan, reprise, review…). Tout le reste n'inscrit rien, ce que log-event refuse
    // de toute façon : appel vers une mission close ou inconnue (session obsolète), plan d'un autre mission_id pendant
    // une mission active. Sinon le transcript de cette session serait compté dans les tokens du chef au done.
    L.withLock(orch, () => {
      const active = L.activeMission(orch);
      const idle = !active || active === '?';
      const ok = call.event === 'plan' ? (idle ? !!call.mission : call.mission === active) : !idle && call.mission === active;
      if (!ok) return;
      const c = L.readJSON(chefFile, {});
      c.sessions = Array.from(new Set([...(c.sessions || []), p.session_id]));
      c.transcripts = { ...(c.transcripts || {}), [p.session_id]: p.transcript_path }; // pour les tokens du chef au done
      // Heure de la 1re inscription : début de la fenêtre de comptage de cette session (lib.chefUsage).
      c.registered = { ...(c.registered || {}), [p.session_id]: (c.registered || {})[p.session_id] || L.nowISO() };
      c.seen = { ...(c.seen || {}), [p.session_id]: L.nowISO() }; // dernier appel : sert à log-event plan pour garder l'appelant
      L.writeJSON(chefFile, c);
    });
    return;
  }
  if (!L.activeMission(orch)) return;
  if (!(L.readJSON(chefFile, {}).sessions || []).includes(p.session_id)) return;

  if (SHELL_TOOLS.includes(tool)) {
    return refuse(orch, p, 'Mode chef : pendant une mission, le shell est limité à log-event. Délègue cette commande à un worker.', 'shell du chef hors log-event');
  }
  const f = ti.file_path || ti.notebook_path;
  if (f && inside(orch, path.resolve(p.cwd || '.', f))) return;
  refuse(orch, p, 'Mode chef : pendant une mission, tu n\'écris que sous .orchestrator/. Délègue cette modification à un worker.', 'écriture du chef hors .orchestrator/');
}

(async () => {
  try {
    const p = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    debug(p);
    ({ 'prompt-start': promptStart, 'pre-agent': preAgent, 'post-agent': postAgent, 'post-agent-fail': postAgentFail, 'subagent-stop': subagentStop, guard })[sub](p);
    if (alert) process.stdout.write(JSON.stringify({ systemMessage: alert }));
  } catch (e) {
    try { fs.appendFileSync(path.join(HERE, 'errors.log'), `${L.nowISO()} ${sub} ${e && e.stack || e}\n`); } catch {}
  }
  if (siteJob) await launchSite();
  process.exit(0);
})();
