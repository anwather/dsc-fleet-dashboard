# Documentation index

Start here, then jump to the doc relevant to the task at hand.

## Deploying

- [Deployment runbook](deployment.md) — end-to-end deploy and teardown
  of the supported Azure stack (Container Apps + managed Postgres +
  Entra). Phase ordering, redeploy delta, and reused-VM reprovision.
- [Azure quickstart](../azure/README.md) — Bicep + scripts reference
  for the Container Apps deployment. Companion to `deployment.md`.
- [Entra setup](entra-setup.md) — app registration, redirect URIs,
  scopes, scripted + manual portal flow, teardown order.

## Using the dashboard

- [User guide](user-guide.md) — sign in, add servers, author configs,
  assign on a schedule, read run output.
- [DSC v3 authoring guide](dsc-authoring.md) — adapter selection,
  every sample explained, `DscV3.RegFile` module reference,
  troubleshooting matrix.

## Operating

- [Operations](operations.md) — day-2 ops: heartbeat, logs, schedules,
  image rollout, Postgres admin, common remediations.
- [Security posture](security-posture.md) — v1 trust model and v2
  hardening backlog.

## Reference

- [Architecture](architecture.md) — component diagram and design
  reasoning for the Entra + ACA + managed Flex Server stack.
- [Data model](data-model.md) — Postgres schema and the lifecycle of a
  server / config / job / run-result.
- [Template customisation](template-customisation.md) — URLs, env
  vars, and code locations to change when forking.
