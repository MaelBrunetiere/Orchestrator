import { expect, test } from 'claude-code/testing'

type Test = Parameters<typeof test>[1]
type Dollar = Parameters<Test>[0]
type On = Parameters<Test>[1]
type SpawnArgs = Parameters<Dollar['agent']['spawn']>[0]

let n = 0
let tu = 0

// Chaque lancement reçoit un tool_use_id unique, comme en production (le kit de test
// n'en met pas, il vaut null). `withoutId` reproduit le repli sans tool_use_id.
const spawn = ($: Dollar, args: SpawnArgs, withoutId = false) =>
  $.agent.spawn(withoutId ? args : ({ ...args, tool_use_id: `toolu_${++tu}` } as SpawnArgs))

// Le moteur sous le mod : lance l'agent, et sert .orchestrator/events.jsonl (journal = son texte,
// absent par défaut). `reads` compte les lectures du journal.
const engine = (on: On, journal?: string) => {
  const reads = { count: 0 }
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-x', agentId: `a${++n}` }))
  on('fs.read', (_, e) => {
    reads.count++
    if (journal === undefined || !/(^|\/)\.orchestrator\/events\.jsonl$/.test(e.path.replace(/\\/g, '/'))) {
      throw Object.assign(new Error(`ENOENT: ${e.path}`), { code: 'ENOENT' })
    }
    return { value: journal }
  })
  return reads
}
const lines = (...evs: object[]) => evs.map(e => JSON.stringify(e)).join('\n') + '\n'

test('relecteur et dev-critique : Opus obligatoire', async ($, on) => {
  engine(on)
  const r1 = await spawn($, { prompt: '[mission:m1 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(r1.deny).toMatch(/Opus/)
  const r2 = await spawn($, { prompt: 'x', subagentType: 'orchestrateur:dev-critique', model: 'haiku' })
  expect(r2.deny).toMatch(/Opus/)
  const r3 = await spawn($, { prompt: '[mission:m1 task:T9] relis', subagentType: 'relecteur', model: 'opus' })
  expect(r3.deny).toBeUndefined()
})

test('conseiller : Opus obligatoire, sur Sonnet comme sur Haiku', async ($, on) => {
  engine(on)
  const sonnet = await spawn($, { prompt: '[mission:m5 task:A1] plan à critiquer', subagentType: 'orchestrateur:conseiller', model: 'sonnet' })
  expect(sonnet.deny).toMatch(/conseiller tourne obligatoirement sur Opus/)
  const haiku = await spawn($, { prompt: '[mission:m5 task:A1] plan à critiquer', subagentType: 'conseiller', model: 'haiku' })
  expect(haiku.deny).toMatch(/Opus/)
  const dflt = await spawn($, { prompt: '[mission:m5 task:A1] plan à critiquer', subagentType: 'orchestrateur:conseiller' })
  expect(dflt.deny).toBeUndefined()
})

test('jamais sous le défaut, escalade vers le haut OK', async ($, on) => {
  engine(on)
  const down = await spawn($, { prompt: '[mission:m2 task:T1] x', subagentType: 'dev', model: 'haiku' })
  expect(down.deny).toMatch(/sous sonnet/)
  const up = await spawn($, { prompt: '[mission:m2 task:T1] x', subagentType: 'explorateur', model: 'sonnet' })
  expect(up.deny).toBeUndefined()
})

const plan = ($: Dollar, on: On, args: string) => {
  on('tool.call', () => ({ result: {} }))
  return $.tool.call({ tool: 'Bash', command: `node "x/scripts/log-event.js" plan ${args}` })
}

test('mode léger : relecteur Sonnet permis, Haiku refusé, pas de conseiller, dev-critique Opus', async ($, on) => {
  engine(on)
  await plan($, on, '--mission lg1 --mode leger --summary "2 tâches"')
  const sonnet = await spawn($, { prompt: '[mission:lg1 task:T9] relis', subagentType: 'orchestrateur:relecteur', model: 'sonnet' })
  expect(sonnet.deny).toBeUndefined()
  const haiku = await spawn($, { prompt: '[mission:lg1 task:T9] relis', subagentType: 'relecteur', model: 'haiku' })
  expect(haiku.deny).toMatch(/Opus/)
  const conseiller = await spawn($, { prompt: '[mission:lg1 task:A1] plan', subagentType: 'conseiller' })
  expect(conseiller.deny).toMatch(/pas de conseiller en mode léger/)
  const crit = await spawn($, { prompt: '[mission:lg1 task:T2] x', subagentType: 'dev-critique', model: 'sonnet' })
  expect(crit.deny).toMatch(/Opus/)
})

test('mode léger sensible : relecteur Opus obligatoire', async ($, on) => {
  engine(on)
  await plan($, on, '--mission lg2 --mode léger --sensible oui')
  const r = await spawn($, { prompt: '[mission:lg2 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(r.deny).toMatch(/Mission sensible/)
  const ok = await spawn($, { prompt: '[mission:lg2 task:T9] relis', subagentType: 'relecteur' })
  expect(ok.deny).toBeUndefined()
})

test('mode léger : un dev-critique lancé rend la mission sensible', async ($, on) => {
  engine(on)
  await plan($, on, '--mission lg3 --mode leger')
  const crit = await spawn($, { prompt: '[mission:lg3 task:T1] x', subagentType: 'dev-critique' })
  expect(crit.deny).toBeUndefined()
  const r = await spawn($, { prompt: '[mission:lg3 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(r.deny).toMatch(/Mission sensible/)
})

test('mode normal : le relecteur Sonnet reste refusé, conseiller permis', async ($, on) => {
  engine(on)
  await plan($, on, '--mission nm1 --summary "1 tâche"')
  const r = await spawn($, { prompt: '[mission:nm1 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(r.deny).toMatch(/Opus/)
  const c = await spawn($, { prompt: '[mission:nm1 task:A1] plan', subagentType: 'conseiller' })
  expect(c.deny).toBeUndefined()
})

// Mod rechargé en pleine mission : ses ensembles sont vides (aucun « plan » vu par tool.call,
// ce que ces missions de test reproduisent), le mode vient du journal.
test('mod rechargé en pleine mission légère : le mode est relu dans events.jsonl', async ($, on) => {
  const reads = engine(on, lines(
    { mission_id: 'rl1', event: 'plan', agent: 'chef', source: 'chef', mode: 'leger' },
    { mission_id: 'rl1', event: 'worker_start', agent: 'dev', source: 'hook' },
    { mission_id: 'rl1', event: 'worker_done', agent: 'dev', source: 'hook' },
  ))
  const sonnet = await spawn($, { prompt: '[mission:rl1 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(sonnet.deny).toBeUndefined()
  const haiku = await spawn($, { prompt: '[mission:rl1 task:T9] relis', subagentType: 'relecteur', model: 'haiku' })
  expect(haiku.deny).toMatch(/Opus/)
  const conseiller = await spawn($, { prompt: '[mission:rl1 task:A1] plan', subagentType: 'conseiller' })
  expect(conseiller.deny).toMatch(/pas de conseiller en mode léger/)
  expect(reads.count).toBe(1) // le journal n'est relu qu'une fois par mission
})

test('mod rechargé : plan sensible ou dev-critique déjà lancé → relecteur Opus', async ($, on) => {
  engine(on, lines(
    { mission_id: 'rl2', event: 'plan', agent: 'chef', source: 'chef', mode: 'leger', sensible: true },
    { mission_id: 'rl3', event: 'plan', agent: 'chef', source: 'chef', mode: 'leger' },
    { mission_id: 'rl3', event: 'worker_done', agent: 'dev-critique', source: 'hook' },
  ))
  const sensible = await spawn($, { prompt: '[mission:rl2 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(sensible.deny).toMatch(/Mission sensible/)
  const critique = await spawn($, { prompt: '[mission:rl3 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(critique.deny).toMatch(/Mission sensible/)
})

test('mod rechargé : la dernière ligne plan de la mission fait foi', async ($, on) => {
  engine(on, lines(
    { mission_id: 'rl4', event: 'plan', agent: 'chef', source: 'chef', mode: 'leger' },
    { mission_id: 'rl4', event: 'plan', agent: 'chef', source: 'chef' },
  ))
  const r = await spawn($, { prompt: '[mission:rl4 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(r.deny).toMatch(/Opus/)
})

test('mod rechargé : mission normale, mission terminée ou journal absent → mode normal', async ($, on) => {
  engine(on, lines(
    { mission_id: 'rl5', event: 'plan', agent: 'chef', source: 'chef' },
    { mission_id: 'rl6', event: 'plan', agent: 'chef', source: 'chef', mode: 'leger' },
    { mission_id: 'rl6', event: 'done', agent: 'chef', source: 'chef' },
    'pas du json',
  ) as unknown as string)
  const normale = await spawn($, { prompt: '[mission:rl5 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(normale.deny).toMatch(/Opus/)
  const terminee = await spawn($, { prompt: '[mission:rl6 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(terminee.deny).toMatch(/Opus/)
  const sansJournal = await spawn($, { prompt: '[mission:rl7 task:T9] relis', subagentType: 'relecteur', model: 'sonnet' })
  expect(sansJournal.deny).toMatch(/Opus/)
  const conseiller = await spawn($, { prompt: '[mission:rl5 task:A1] plan', subagentType: 'conseiller' })
  expect(conseiller.deny).toBeUndefined()
})

test('3 lancements dans le même message : le 3e est refusé', async ($, on) => {
  on('agent.spawn', async (_, e) => {
    await new Promise(r => setTimeout(r, 20))
    return { model: e.model ?? 'claude-x', agentId: `p${++n}` }
  })
  on('fs.read', () => { throw new Error('ENOENT') })
  const res = await Promise.all(['T1', 'T2', 'T3'].map(t =>
    spawn($, { prompt: `[mission:m9 task:${t}] x`, subagentType: 'explorateur' })))
  expect(res.filter(r => r.deny !== undefined).length).toBe(1)
})

test('sans tool_use_id (null), le compteur de repli sépare les réservations', async ($, on) => {
  on('agent.spawn', async (_, e) => {
    await new Promise(r => setTimeout(r, 20))
    return { model: e.model ?? 'claude-x', agentId: `q${++n}` }
  })
  on('fs.read', () => { throw new Error('ENOENT') })
  const res = await Promise.all(['T1', 'T2', 'T3'].map(t =>
    spawn($, { prompt: `[mission:m10 task:${t}] x`, subagentType: 'explorateur' }, true)))
  expect(res.filter(r => r.deny !== undefined).length).toBe(1)
})

test('la réservation est libérée après le lancement, avec ou sans tool_use_id', async ($, on) => {
  engine(on)
  // Une réservation qui fuirait (clé tool_use_id ou compteur) ferait compter 2 places pour un seul
  // worker : le 2e lancement serait refusé à tort, et le 3e le serait avec plus de 2 workers.
  const a = await spawn($, { prompt: '[mission:m11 task:T1] x', subagentType: 'explorateur' })
  const b = await spawn($, { prompt: '[mission:m11 task:T2] x', subagentType: 'explorateur' }, true)
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  const c = await spawn($, { prompt: '[mission:m11 task:T3] x', subagentType: 'explorateur' }, true)
  expect(c.deny).toMatch(/déjà 2 workers/)
})

// Contrat avec scripts/hooks.js (post-agent-fail) : un lancement refusé par le garde-fou est journalisé
// en événement blocked parce que son message commence par « garde-fou : ». Tous les refus doivent le porter.
test('tout refus du garde-fou commence par « garde-fou : » (journalisé blocked par le hook)', async ($, on) => {
  engine(on)
  await plan($, on, '--mission gf1 --mode leger')
  const denies = [
    // Opus obligatoire
    await spawn($, { prompt: '[mission:gf2 task:T1] x', subagentType: 'relecteur', model: 'sonnet' }),
    // sous le défaut
    await spawn($, { prompt: '[mission:gf2 task:T2] x', subagentType: 'dev', model: 'haiku' }),
    // modèle inconnu
    await spawn($, { prompt: '[mission:gf2 task:T3] x', subagentType: 'dev', model: 'gpt-9' }),
    // pas de conseiller en mode léger
    await spawn($, { prompt: '[mission:gf1 task:A1] plan', subagentType: 'conseiller' }),
  ]
  // plafond de 2 workers (la mission gf3 vient en dernier : ses deux premiers lancements sont acceptés)
  await spawn($, { prompt: '[mission:gf3 task:T1] x', subagentType: 'explorateur' })
  await spawn($, { prompt: '[mission:gf3 task:T2] x', subagentType: 'explorateur' })
  denies.push(await spawn($, { prompt: '[mission:gf3 task:T3] x', subagentType: 'explorateur' }))
  expect(denies.length).toBe(5)
  for (const d of denies) expect(d.deny).toMatch(/^garde-fou : /)
})

test('2 workers de mission au maximum, compteur remis à zéro par nouvelle mission', async ($, on) => {
  engine(on)
  const a = await spawn($, { prompt: '[mission:m3 task:T1] x', subagentType: 'explorateur' })
  const b = await spawn($, { prompt: '[mission:m3 task:T2] x', subagentType: 'explorateur' })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  const c = await spawn($, { prompt: '[mission:m3 task:T3] x', subagentType: 'executant' })
  expect(c.deny).toMatch(/max 2/)
  const other = await spawn($, { prompt: 'sans balise', subagentType: 'general-purpose' })
  expect(other.deny).toBeUndefined()
  const d = await spawn($, { prompt: '[mission:m4 task:T1] x', subagentType: 'executant' })
  expect(d.deny).toBeUndefined()
})
