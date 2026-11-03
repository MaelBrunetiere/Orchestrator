---
name: handoff
description: Passe la mission en cours du mode chef à une nouvelle session qui reprend depuis .orchestrator/state.md.
disable-model-invocation: true
---

Passation de la mission en cours. $ARGUMENTS

1. Si un worker tourne encore, attends son compte rendu avant de continuer.
2. Réécris `.orchestrator/state.md` en entier (modèle dans `${CLAUDE_PLUGIN_ROOT}/scripts/regles-chef.md`) : il doit suffire à reprendre sans l'historique (décisions, état de chaque tâche, pièges, chemins des sorties, prochaine action précise).
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/log-event.js" handoff --mission <id> --summary "<prochaine action>"`.
4. Lance la nouvelle session :
   - Dans l'app Desktop : charge l'outil `mcp__ccd_session__start_session` (ToolSearch `select:mcp__ccd_session__start_session`) et appelle-le avec `initiation: "user_asked"`, `context: "fresh"`, le dossier du projet comme `cwd` si l'outil le demande, un titre `Reprise <mission_id>` et ce brief :
     « /orchestrateur:reprise <mission_id> » (le skill reprise injecte les règles et state.md, puis enregistre la session comme chef).
   - Si l'outil n'existe pas (CLI) ou échoue : dis-le clairement et affiche ce même brief dans un bloc de code, prêt à coller dans une nouvelle session.
5. Ici, arrête-toi : ne lance plus aucun worker dans cette session.
