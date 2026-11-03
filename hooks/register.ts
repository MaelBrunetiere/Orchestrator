import type { Register } from 'claude-code'

// Modèle par défaut de chaque agent du mode chef (préfixe de plugin ignoré).
const DEFAULTS: Record<string, string> = {
  explorateur: 'haiku',
  executant: 'haiku',
  dev: 'sonnet',
  'dev-critique': 'opus',
  relecteur: 'opus',
  conseiller: 'opus',
}
// Effort : doublé de scripts/lib.js (le mod ne peut pas le charger). L'effort n'est vérifié ici que si
// l'événement agent.spawn l'expose ; le hook PreToolUse(Agent) de scripts/hooks.js vérifie tool_input.effort dans tous les cas.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_HIGH_ONLY = ['dev-critique', 'relecteur', 'conseiller']
const OPUS_ONLY = ['dev-critique', 'relecteur', 'conseiller']
const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 }
const MAX_PARALLEL = 2
const EXPIRY_MS = 30 * 60 * 1000
const TAG = /^\s*\[mission:([^\s\]]+)\s+task:([^\s\]]+)\]/

// Tout refus du garde-fou commence par « garde-fou : » : le hook post-agent-fail (scripts/hooks.js) s'y fie
// pour journaliser un événement blocked (et non worker_fail) quand le lancement est refusé.
const refuse = (msg: string) => ({ deny: `garde-fou : ${msg}` })

function effortRefusal(r: string, effort: unknown): string | undefined {
  if (effort === undefined || effort === null) return undefined
  const e = String(effort).toLowerCase()
  if (!EFFORTS.includes(e)) return `effort « ${String(effort)} » non reconnu pour ${r} (${EFFORTS.join(', ')}).`
  const floor = EFFORT_HIGH_ONLY.includes(r) ? 'high' : 'medium'
  if (EFFORTS.indexOf(e) < EFFORTS.indexOf(floor)) return `${r} ne descend pas sous l'effort ${floor} (demandé : ${String(effort)}).`
  if (!EFFORT_HIGH_ONLY.includes(r) && EFFORTS.indexOf(e) > EFFORTS.indexOf('medium')) return `${r} reste en effort medium (demandé : ${String(effort)}) : découpe la tâche, ou prends dev-critique pour l'architecture, la sécurité ou le matériel.`
  return undefined
}

const role = (type: string) => type.replace(/^.*:/, '')
const tier = (model: string) => Object.keys(RANK).find(k => model.toLowerCase().includes(k))

// Workers de mission en cours : agentId -> heure de lancement. Remis à zéro
// à chaque nouvelle mission (log-event plan ou mission_id différent).
const running = new Map<string, number>()
let missionId: string | undefined
let slotSeq = 0

// Missions en mode léger (log-event plan --mode leger) et, parmi elles, les
// « sensibles » (--sensible oui, ou dev-critique lancé : sécurité/matériel).
// Un rechargement du mod efface ces ensembles : au premier lancement d'une
// mission, le mode est relu dans .orchestrator/events.jsonl (restore).
const light = new Set<string>()
const sensitive = new Set<string>()
const restored = new Map<string, Promise<boolean>>()
const EVENTS_FILES = ['.orchestrator/events.jsonl', '../.orchestrator/events.jsonl']

// Relit le mode de la mission active : dernière ligne « plan » de la mission (champs
// mode et sensible écrits par --mode / --sensible) ; un dev-critique déjà lancé rend
// la mission sensible. Mission terminée (done) ou journal illisible : rien n'est restauré,
// donc mode normal (côté sûr). Résout false quand le journal n'a pas pu être lu : on réessaiera.
function restore(mission: string, read: (file: string) => Promise<string>): Promise<boolean> {
  let p = restored.get(mission)
  if (p === undefined) {
    p = (async () => {
      for (const file of EVENTS_FILES) {
        const text = await read(file).catch(() => undefined)
        if (text === undefined) continue
        const evs = text.split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } })
          .filter(ev => ev.mission_id === mission)
        if (evs.some(ev => ev.event === 'done')) return true
        const plan = evs.filter(ev => ev.event === 'plan').pop()
        if (plan?.mode === 'leger') {
          light.add(mission)
          if (plan.sensible === true) sensitive.add(mission)
        }
        if (evs.some(ev => ev.agent === 'dev-critique')) sensitive.add(mission)
        return true
      }
      return false
    })()
    restored.set(mission, p)
    p.then(ok => { if (!ok) restored.delete(mission) }, () => restored.delete(mission))
  }
  return p
}

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const r = role(e.subagentType)
    const dflt = DEFAULTS[r]
    const tag = TAG.exec(e.prompt)
    if (e.resume || e.fork || (dflt === undefined && !tag)) return next(e)

    const mission = tag?.[1]
    if (mission !== undefined) await restore(mission, f => $.fs.read(f))
    const isLight = mission !== undefined && light.has(mission)
    if (r === 'dev-critique' && mission !== undefined) sensitive.add(mission)
    if (isLight && r === 'conseiller') return refuse('pas de conseiller en mode léger.')
    if (dflt !== undefined) {
      const why = effortRefusal(r, (e as { effort?: unknown }).effort)
      if (why !== undefined) return refuse(why)
    }

    if (dflt !== undefined && e.model !== undefined) {
      const t = tier(e.model)
      if (t === undefined) return refuse(`modèle « ${e.model} » non reconnu pour ${r} (haiku, sonnet ou opus).`)
      // Mode léger : le relecteur final peut tourner sur Sonnet, sauf mission sensible.
      const lightReview = isLight && r === 'relecteur' && !sensitive.has(mission!)
      if (OPUS_ONLY.includes(r) && t !== 'opus' && !(lightReview && t === 'sonnet')) {
        const why = isLight && r === 'relecteur' ? ' Mission sensible (sécurité/matériel) : pas de relecture Sonnet.' : ''
        return refuse(`${r} tourne obligatoirement sur Opus (demandé : ${e.model}).${why}`)
      }
      const floor = lightReview ? 'sonnet' : dflt
      if (RANK[t] < RANK[floor]) return refuse(`${r} ne descend pas sous ${floor} (demandé : ${e.model}). Escalade vers le haut seulement.`)
    }

    if (!tag) return next(e)
    if (tag[1] !== missionId) {
      missionId = tag[1]
      running.clear()
    }
    const now = Date.now()
    for (const [id, t0] of running) if (now - t0 > EXPIRY_MS) running.delete(id)
    if (running.size >= MAX_PARALLEL) {
      return refuse(`déjà ${running.size} workers de mission en cours (max ${MAX_PARALLEL}). Attends un compte rendu avant d'en lancer un autre.`)
    }
    // La place est réservée avant d'attendre le lancement : des Agent lancés
    // dans le même message passent ici en parallèle.
    // tool_use_id identifie le lancement ; le compteur ne sert que s'il manque.
    const slot = `reserve:${e.tool_use_id ?? 'seq' + (++slotSeq)}:${now}`
    running.set(slot, now)
    try {
      const res = await next(e)
      if (res.deny === undefined && res.agentId !== undefined) running.set(res.agentId, now)
      return res
    } finally {
      running.delete(slot)
    }
  }).catch(($, e, next) => {
    // Une panne du garde-fou ne bloque pas tous les lancements d'agents.
    $.ui.log(`${$.plugin.name}: garde-fou en panne, lancement laissé passer`)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) running.delete(e.agentId)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    const cmd = (e as { command?: unknown }).command
    if (typeof cmd === 'string' && /log-event\.js["']?\s+plan\b/.test(cmd)) {
      running.clear()
      const m = /--mission\s+["']?([^\s"']+)/.exec(cmd)
      // Un nouveau plan fait foi sur ce qui était connu de cette mission.
      if (m) { light.delete(m[1]); sensitive.delete(m[1]); restored.delete(m[1]) }
      if (m && /--mode\s+["']?l[eé]ger\b/.test(cmd)) {
        light.add(m[1])
        if (/--sensible\s+["']?oui\b/.test(cmd)) sensitive.add(m[1])
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
