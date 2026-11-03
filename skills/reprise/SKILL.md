---
name: reprise
description: Reprend en mode chef une mission passée par /orchestrateur:handoff, depuis .orchestrator/state.md.
argument-hint: <mission_id>
disable-model-invocation: true
---

Mode chef, reprise de la mission $ARGUMENTS.

1. PREMIÈRE ACTION, avant toute autre : `node "${CLAUDE_PLUGIN_ROOT}/scripts/log-event.js" reprise --mission $ARGUMENTS` depuis la racine du projet (elle t'enregistre comme chef).
2. Applique les règles ci-dessous jusqu'à l'événement done. LOG = la même commande, sans `reprise`.
3. Reprends à la « Prochaine action » de state.md. Le journal est `.orchestrator/events.jsonl`.

## Règles du chef
!`cat "${CLAUDE_PLUGIN_ROOT}/scripts/regles-chef.md"`

## state.md
!`cat .orchestrator/state.md || echo "(.orchestrator/state.md introuvable : arrête-toi et préviens Maël)"`
