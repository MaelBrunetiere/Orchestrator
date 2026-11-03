# orchestrateur

Mode chef d'orchestre pour Claude Code. `/orchestrateur:chef <mission>` planifie la mission sur Opus, puis délègue chaque tâche à un worker
(explorateur et executant sur Haiku, dev sur Sonnet, dev-critique, relecteur et conseiller sur Opus). Des hooks Node écrivent le journal
`.orchestrator/events.jsonl` du projet (worker_start, worker_done, worker_fail, tokens mesurés), le chef écrit ses propres événements
avec `scripts/log-event.js`, et `/orchestrateur:handoff` passe la mission à une nouvelle session. Un mod refuse les lancements
sous le modèle par défaut d'un agent, impose Opus au relecteur, au dev-critique et au conseiller, et limite à deux workers de mission en parallèle.
`/orchestrateur:chef leger <mission>` lance le mode léger : pas de conseiller, relecture finale sur Sonnet, Opus gardé pour le dev-critique
et pour les missions sensibles (sécurité, matériel). `log-event done` range les fichiers temporaires des workers
de la mission (`.orchestrator/tmp/<mission>/`, les autres missions ne sont pas touchées) dans `.orchestrator/archive/<mission>.tmp/` ; si le déplacement échoue (EBUSY/EPERM), le done passe quand même et
un avertissement figure dans son summary et dans la sortie. Chaque refus du hook guard est journalisé (`blocked`, source hook, avec agent, task_id et motif dans `summary`) ; le champ optionnel `tool` (hors des 10 champs du schéma) y donne l'outil refusé (`Bash`, `Write`…, ou `Agent` pour un lancement refusé par le garde-fou de modèle, hors plafond de 2 workers qui reste un `worker_fail`). Dans un événement `escalate`, `model` est le modèle CIBLE de l'escalade (celui du prochain lancement), pas le modèle du chef, qui n'est pas journalisé. Un `worker_done` avec STATUT ok dont le fichier `out/<mission>/<tâche>-<agent>.md` n'existe pas devient un `worker_fail` « sortie absente ». Les tokens du chef au `done` viennent des sessions inscrites dans `.chef.json` (par un `plan` quand aucune mission n'est active, ou un appel visant la mission active ; un plan vers un autre mission_id pendant une mission active est refusé et n'inscrit ni ne purge rien ; `plan` d'une nouvelle mission purge les anciennes inscriptions), comptés du prompt qui a lancé la mission jusqu'au `done`. Le contrôle du code est fait par le dev lui-même (sortie brute et codes de retour dans sa sortie) ; une tâche « vérif » séparée (executant Haiku) ne sert que pour un contrôle indépendant. Après un rechargement du mod, le mode de la mission en cours est relu dans
`events.jsonl` (dernière ligne `plan`). Tests : `claude plugin test .` et `node --test tests/*.test.js`.
Node 18 ou plus est nécessaire.

## 0.4.4 (plafond d'effort)

- `dev`, `executant` et `explorateur` restent en effort `medium` : un lancement ou un `plan.json` demandant `high`, `xhigh` ou `max` pour eux est refusé (« garde-fou : dev reste en effort medium… »), journalisé `blocked`. Une tâche plus dure se découpe ou passe en `dev-critique` (architecture, sécurité, matériel). Jusque-là seul le plancher était contrôlé : la règle n'était que du texte, et le chef l'avait ignorée. Code : `effortRefusal` dans `scripts/lib.js`, doublé dans `hooks/register.ts`.

## 0.4.3 (site de suivi lancé tout seul)

- Au `/orchestrateur:chef`, le hook `prompt-start` (juste après l'événement `start`) lance le site local `orchestrateur-site` pour le projet courant et l'ouvre dans le navigateur, sans rien taper. Rien ne se lance hors `/chef`. Code : `scripts/site.js`.
- Pas de doublon : le port de départ dérive du chemin du projet (de 4317 à 4816 ; le site répond à `/api/ping` avec son projet). Un site déjà actif pour ce projet est réutilisé, jamais relancé ; un site d'un autre projet n'est pas touché, le projet courant prend un autre port libre. Le navigateur s'ouvre une seule fois par mission (mémoire dans `~/.claude/orchestrateur-site-state.json`, hors `.orchestrator/`) ; ouvrir le site de nouveau ouvre un nouvel onglet, le navigateur ne permet pas de réutiliser l'ancien.
- Processus détaché (`detached`, stdio ignoré, `windowsHide`, `unref`) : il survit à la session. Le hook ne bloque pas (délai plafonné à 2 s) et ne peut pas échouer : site introuvable, port introuvable ou lancement impossible laissent une ligne `site WARN` dans `scripts/errors.log` et la mission continue.
- Le site vit dans `~/.claude/plugins-src/orchestrateur-site` (hors du cache). Il s'arrête seul après 30 minutes sans page ouverte ni mission active (journal sans `done`, modifié depuis moins de 6 h). `ORCH_SITE_IDLE_MS` change ce délai (`0` : jamais d'arrêt).
- Désactiver : variable d'environnement `ORCH_SITE=off` (aussi `0`, `false`, `no`, `non`). Pour tous les projets, dans `~/.claude/settings.json` : `{ "env": { "ORCH_SITE": "off" } }`, puis redémarrer Claude Code. Autres variables (tests) : `ORCH_SITE_DIR` (dossier du site), `ORCH_SITE_STATE` (fichier de mémoire), `ORCH_SITE_OPENER` (script Node appelé avec l'URL à la place du navigateur).
- Le site reste en lecture seule, sur 127.0.0.1 ; rien n'est écrit dans `.orchestrator/` par lui.
- Tests : `tests/site.test.js`.

## 0.4.2 (moins de tokens et de temps, même qualité)

- Rapport final par script : `log-event done` écrit `out/<mission>/rapport-final.md` depuis `events.jsonl` + `plan.json` (`scripts/rapport.js`, 0 token) et l'affiche. 5 lignes : À faire, Résultat (tâches ok, mode), Attention (blocked, worker_fail, escalate ; les titres de plan.json, jamais d'identifiants), Fichiers (lignes FICHIERS des workers, enregistrées par le hook dans le champ `fichiers` de worker_done), Coût (durée plan→fin, tokens workers et chef). Le chef ajoute seulement `--a-faire "…"` pour un livrable Icam noté. L'agent `porte-parole`, son entrée dans le garde-fou (limite « une fois par mission »), son cas dans le hook guard et sa règle de plafond sont retirés.
- Le chef n'écrit plus de ligne `review` quand un worker rend STATUT ok et que sa sortie existe (le hook SubagentStop a déjà écrit `worker_done`). `review` reste pour un vrai jugement : correction, relance, escalade, décision de Maël, avis du conseiller. Vérifié : le tableau de bord (orchestrateur-dash, non modifié) ne lit pas `review` comme un état « relu » ; il s'en sert seulement pour lever un blocage et pour les notes du chef. Aucune écriture à reprendre par le hook.
- Moins de lectures : comptes rendus de 5 lignes maximum (STATUT, FAIT, FICHIERS, DOUTES ; plus de ligne TOKENS, les tokens sont mesurés), qui pointent vers le fichier de sortie. STATUT ok : le chef ne relit pas la sortie. Quand il lit, c'est avec Read, jamais avec Bash (refusé par le hook).
- Enchaînement : retour ok et tâche suivante déjà au plan → lancée dans le même tour, une phrase de commentaire.
- Démarrage par le hook : NON implémenté. Doc des hooks (code.claude.com/docs/en/hooks) : le `additionalContext` d'un SubagentStop va au sous-agent (il le garde en vie), pas au chef ; pour injecter du contexte dans la session parente la doc renvoie à PostToolUse sur l'outil Agent, qui ne voit que le lancement (`async_launched`) pour un agent en arrière-plan. Un test garantit que SubagentStop n'écrit rien.
- Petites missions : plan de 3 tâches ou moins → mode léger par défaut, sauf mot `complet` en premier mot ou mission d'architecture, de sécurité ou de matériel. Avec `--plan-file`, la ligne plan porte toujours le mode (`normal` ou `leger`) ; `log-event plan` l'affiche et rappelle la règle pour un plan normal de 3 tâches ou moins.
- Effort : `medium` par défaut pour dev et executant (frontmatter et `EFFORT_DEFAULT`) ; `high` seulement pour dev-critique, relecteur et conseiller, dont le plancher reste vérifié.
- Workers : « une seule écriture de la SORTIE, un seul script de contrôle, pas de vérification refaite ». Le dev lance lui-même le contrôle du code testable et rend la sortie brute (ligne lancée, sortie, `RC=`) ; la tâche vérif séparée ne sert que pour un contrôle indépendant. Le relecteur lit cette preuve.
- Langage du chef : tâches désignées par leur titre (plan.json) dans tous ses messages à Maël, jamais par T1, A1. Les identifiants restent dans les prompts, les journaux et les fichiers.
- Tests : les tests du porte-parole (tests/effort.test.js, hooks/garde-effort.test.ts) sont retirés ou remplacés avec l'agent ; nouveaux tests dans tests/v042.test.js.

## 0.4.0

- Cadrage : le chef pose ses questions avec AskUserQuestion uniquement (1 à 4 questions, 2 à 4 options, recommandée en premier), puis récap de 3 lignes et validation avant le plan. Ses messages à Maël tiennent en 5 lignes, la 1re dit ce qu'il y a à faire (ou « Rien à faire »).
- Plan hiérarchique : `.orchestrator/out/<mission>/plan.json` (`mission`, `branches`, `taches` avec agent, modèle, effort, justification), validé par `log-event plan --plan-file` (événement `plan` avec `plan_file` et `plan_tasks`). Une mission sans plan.json reste valide.
- Effort par tâche (`medium`, `high`, `xhigh`), passé en paramètre `effort` de l'outil Agent (Claude Code 2.1.292 ou plus ; Haiku 5.5 : 2.1.293 ou plus). Plancher `high` pour dev-critique, relecteur et conseiller, `medium` ailleurs : refusé avec le préfixe « garde-fou : » par le hook PreToolUse(Agent) (`tool_input.effort`) et par le mod si `agent.spawn` expose l'effort. Le champ `effort` du frontmatter de chaque agent est le défaut quand le chef l'oublie. L'effort figure dans `worker_start` et `.agents.json`. `CLAUDE_CODE_EFFORT_LEVEL` écraserait tout (paramètre compris) : ne pas la définir.
- Agent `porte-parole` (Haiku, effort medium) : écrit `out/<mission>/rapport-final.md` (4 lignes : À faire, Résultat, Attention, Fichiers), lancé une seule fois avant le `done`, compté dans les 2 workers ; le chef affiche ce rapport tel quel. Son Write est limité à ce fichier par le hook guard ; sa lecture reste sur out/<mission>/ par consigne seulement (un hook sur Read coûterait un processus Node à chaque lecture de toutes les sessions).
- L'effort par défaut de l'explorateur passe de `low` à `medium` (plus bas que le plancher des plans).

## Limites connues

- Plusieurs missions dans une même session : si la session lance une 2e mission sans rappeler le skill chef ou reprise, le comptage des tokens
  du chef part du 1er lancement (le skill appelé en dernier avant l'inscription fait foi).
- Replan d'une mission en cours : un `plan` avec le même mission_id ne purge aucune inscription de `.chef.json`. Une session obsolète déjà
  inscrite à ce moment reste donc comptée jusqu'au `done`.
- Mission abandonnée sans `done` : tant que `.orchestrator/events.jsonl` n'a pas de ligne `done`, la mission reste active et tout `plan`
  vers un autre mission_id est refusé. Pour la clore à la main, depuis la racine du projet (l'identifiant est le `mission_id` de la
  première ligne de `events.jsonl`) :

  ```
  node "<plugin>/scripts/log-event.js" done --mission <mission_id> --summary "abandonnée"
  ```

  `<plugin>` est la racine du plugin, celle que donne la ligne « Règles : » de `.orchestrator/state.md` (le dossier de `scripts/regles-chef.md`).
  Le `done` archive le journal dans `.orchestrator/archive/<mission_id>.jsonl`, range `tmp/<mission_id>/` et remet `.agents.json` et
  `.chef.json` à zéro. Si `events.jsonl` existe mais ne contient aucune ligne JSON valide, la même commande passe avec n'importe quel `--mission`.
- Ancien `.chef.json` (sans `registered`, d'avant la 0.3.1) : la fenêtre de comptage retombe sur l'heure du `plan` ; le comptage reste correct
  si le skill est retrouvé dans le transcript, sinon il part du plan.
