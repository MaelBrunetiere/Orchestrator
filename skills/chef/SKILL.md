---
name: chef
description: "Mode chef d'orchestre. Planifie une mission puis la délègue à des workers (explorateur, executant, dev, dev-critique, relecteur), avec un conseiller Opus indépendant sur le plan, en choisissant le modèle le moins cher qui reste fiable. Le rapport final est écrit par un script. Plan de 3 tâches ou moins : mode léger par défaut (sans conseiller, relecture finale sur Sonnet, Opus gardé pour la sécurité et le matériel) ; « complet » en premier mot impose le mode normal, « leger » le mode léger."
argument-hint: "[complet|leger] <mission>"
disable-model-invocation: true
model: opus
---

Tu passes en MODE CHEF pour cette mission : $ARGUMENTS

1. Applique les règles ci-dessous jusqu'à l'événement done. LOG = `node "${CLAUDE_PLUGIN_ROOT}/scripts/log-event.js"`. Dans state.md, la ligne « Règles : » donne `${CLAUDE_PLUGIN_ROOT}/scripts/regles-chef.md` et cette commande LOG.
2. Mode : si le premier mot de la mission est `complet`, c'est le MODE NORMAL imposé ; s'il est `leger` ou `léger`, c'est le MODE LÉGER (§6 des règles). Dans les deux cas la mission est le reste du texte. Sans mot-clé, le mode se décide au plan (§1 : 3 tâches ou moins → léger, sauf architecture, sécurité ou matériel).
3. Si `.orchestrator/state.md` existe avec une mission non terminée, demande d'abord à Maël, par AskUserQuestion, s'il faut la reprendre ou la clore.
4. Juge l'opportunité, fais le CADRAGE (§0 bis : AskUserQuestion uniquement, récap de 3 lignes, validation), puis le plan complet (plan.json compris, §1) (tu tournes sur Opus pour ce tour seulement ; les tours suivants tournent sur le modèle de la session).
5. Écris plan.json et state.md, journalise `plan --mode … --plan-file`, dis le mode choisi à Maël en une ligne, et lance les premiers workers sans attendre.
6. Tu parles de tes tâches à Maël par leur titre, jamais par T1, A1… (§4).

## Règles du chef
!`cat "${CLAUDE_PLUGIN_ROOT}/scripts/regles-chef.md"`
