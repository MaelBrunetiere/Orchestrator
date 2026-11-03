import { expect, test } from 'claude-code/testing'

type Test = Parameters<typeof test>[1]
type Dollar = Parameters<Test>[0]
type On = Parameters<Test>[1]
type SpawnArgs = Parameters<Dollar['agent']['spawn']>[0]

let n = 0
let tu = 0

// Même kit que garde.test.ts : un tool_use_id unique par lancement, un moteur qui accepte tout et sert un journal vide.
const spawn = ($: Dollar, args: SpawnArgs) => $.agent.spawn({ ...args, tool_use_id: `toolu_e${++tu}` } as SpawnArgs)
const engine = (on: On) => {
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-x', agentId: `e${++n}` }))
  on('fs.read', (_, e) => {
    throw Object.assign(new Error(`ENOENT: ${e.path}`), { code: 'ENOENT' })
  })
}

// Si l'événement agent.spawn expose `effort`, le garde-fou applique le plancher ; sinon c'est le hook
// PreToolUse(Agent) de scripts/hooks.js (testé dans tests/hooks-guard.test.js) qui le fait.
test('effort exposé par agent.spawn : sous le plancher refusé « garde-fou : », sinon accepté', async ($, on) => {
  engine(on)
  const low = await spawn($, { prompt: '[mission:ef1 task:T1] relis', subagentType: 'orchestrateur:relecteur', effort: 'medium' } as SpawnArgs)
  expect(low.deny).toMatch(/^garde-fou : relecteur ne descend pas sous l'effort high/)
  const crit = await spawn($, { prompt: '[mission:ef1 task:T2] x', subagentType: 'dev-critique', effort: 'low' } as SpawnArgs)
  expect(crit.deny).toMatch(/^garde-fou : .*effort high/)
  const dev = await spawn($, { prompt: '[mission:ef1 task:T3] x', subagentType: 'dev', effort: 'low' } as SpawnArgs)
  expect(dev.deny).toMatch(/^garde-fou : dev ne descend pas sous l'effort medium/)
  const high = await spawn($, { prompt: '[mission:ef1 task:T5] x', subagentType: 'dev', effort: 'high' } as SpawnArgs)
  expect(high.deny).toMatch(/^garde-fou : dev reste en effort medium/)
  const unknown = await spawn($, { prompt: '[mission:ef1 task:T4] x', subagentType: 'dev', effort: 'turbo' } as SpawnArgs)
  expect(unknown.deny).toMatch(/^garde-fou : .*non reconnu/)
  const ok = await spawn($, { prompt: '[mission:ef2 task:T1] x', subagentType: 'orchestrateur:relecteur', effort: 'xhigh' } as SpawnArgs)
  expect(ok.deny).toBeUndefined()
})

test('effort absent : le frontmatter s\'applique, aucun refus', async ($, on) => {
  engine(on)
  const none = await spawn($, { prompt: '[mission:ef3 task:T1] relis', subagentType: 'orchestrateur:relecteur' })
  expect(none.deny).toBeUndefined()
})

// 0.4.2 : le porte-parole n'existe plus, le rapport final est écrit par un script (log-event done).
test('porte-parole supprimé : plus de rôle connu du garde-fou, plus de limite « une fois par mission »', async ($, on) => {
  engine(on)
  const a = await spawn($, { prompt: '[mission:pp1 task:T9] rapport', subagentType: 'orchestrateur:porte-parole' })
  const b = await spawn($, { prompt: '[mission:pp1 task:T10] rapport', subagentType: 'porte-parole' })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
})
