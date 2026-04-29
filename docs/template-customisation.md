# Template customisation

This repo is published as a **template**: the expectation is that you fork it
into your org, change a handful of URLs and tunables, and run from your fork.
This document lists every place that bakes in a default you'll likely want
to change.

## Repoint the dsc-fleet bootstrap URLs

The provision job on the dashboard side downloads three PowerShell scripts
from `anwather/dsc-fleet` and runs them on the target VM. To point at your
own fork:

1. Fork [`anwather/dsc-fleet`](https://github.com/anwather/dsc-fleet) into
   your org. Optionally pin a release tag.
2. Edit the three constants at the top of
   [`apps/api/src/services/jobs.ts`](../apps/api/src/services/jobs.ts):

   ```ts
   const PREREQ_BOOTSTRAP_URL =
     'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Install-Prerequisites.ps1';
   const INSTALL_DSC_URL =
     'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Install-DscV3.ps1';
   const REGISTER_AGENT_URL =
     'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Register-DashboardAgent.ps1';
   ```

   Replace `anwather/dsc-fleet/main` with `<your-org>/dsc-fleet/<your-tag>`
   in each line.
3. The `agentBridgeBaseUrl` field on the provision job payload is also
   hardcoded a few lines below in `servers.ts`
   ([`/:id/provision-token` handler](../apps/api/src/routes/servers.ts)) —
   change the `'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap'`
   default there too.

If you forked `Register-DashboardAgent.ps1` to change agent behaviour,
make that change inside your `dsc-fleet` fork — it is not stored in
this repo. (The agent's historical `-Mode Git` configs path is
deprecated; `-Mode Dashboard` is the only supported mode.)

## Tune the agent poll cadence and offline detection

These are env vars, no code edit required:

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENT_POLL_DEFAULT_SECONDS` | `60` | How often the agent polls `/assignments` and posts `/heartbeat`. The api echoes this value back to the agent in every `assignments` and `heartbeat` response, so changing it here is enough — the agent picks it up on the next poll. |
| `OFFLINE_MULTIPLIER` | `3` | A server with no heartbeat for `OFFLINE_MULTIPLIER × AGENT_POLL_DEFAULT_SECONDS` seconds is marked `offline` by the scheduler. Default is therefore 3 minutes at default poll. |
| `DEFAULT_ASSIGNMENT_INTERVAL_MINUTES` | `15` | Default `interval_minutes` when an `assignment` is created without one. |
| `AZURE_RUNCOMMAND_TIMEOUT_MINUTES` | `30` | Wall-clock cap on Run-Command jobs (provision + module-install). Also doubles as the provision-token lifetime. |
| `REMOVAL_ACK_TIMEOUT_MINUTES` | `60` | (Reserved.) The scheduler currently uses `15 × interval_minutes` to expire stale removals; this knob is plumbed for future per-deployment override. |

Set them in `.env` (compose) or in `k8s/20-api-config.yaml` (`ConfigMap`), then
restart the api container.

## Add a new config sample to the picker

The eight built-in samples live in
[`apps/web/src/lib/samples.ts`](../apps/web/src/lib/samples.ts). Each sample
is a `Sample` object with:

- `id`, `title`, `blurb`, `resourceType` (display only),
- a `fields: SampleField[]` list of form inputs,
- a `render(values)` function that returns the YAML body.

To add one:

1. Append a new entry to the exported `SAMPLES` array.
2. Reuse the `HEADER` constant so you get the `$schema` and elevated security
   context for free.
3. Restart the web container (or `npm -w @dsc-fleet/web run build` then
   rebuild the docker image).
4. If your sample requires a module **not** in the existing namespace map (see
   below), add it to the API's allow-list as well.

> The historical `dsc-fleet-configs` repo (and the agent's `-Mode Git`
> path) is archived and no longer used. Configurations are authored
> directly in the dashboard UI and dispatched to agents via
> `-Mode Dashboard`.

## Add a new built-in DSC resource to the module-extraction allow-list

[`apps/api/src/services/yamlParser.ts`](../apps/api/src/services/yamlParser.ts)
contains two extension points:

```ts
const NAMESPACE_MODULE_MAP: Record<string, string | null> = {
  'Microsoft.DSC':                null,            // built-in
  'Microsoft.Windows':            null,            // built-in
  'PSDesiredStateConfiguration':  null,            // ships with Windows
  'Microsoft.WinGet.DSC':         'Microsoft.WinGet.DSC',
  'PSDscResources':               'PSDscResources',
  'DscV3.RegFile':                'DscV3.RegFile',
};

const ADAPTER_TYPES: Set<string> = new Set([
  'Microsoft.Windows/WindowsPowerShell',
  'Microsoft.DSC/PowerShell',
]);
```

To teach the parser about a new resource:

- If it's **built-in** (ships with the OS or with `dsc` itself, no PSGallery
  install), map its namespace prefix to `null` so the parser doesn't add it to
  `requiredModules`.
- If it ships in a PSGallery module, map the namespace prefix to the module
  name. The parser uses longest-prefix matching, so e.g.
  `'Contoso.MyApp.SubResource'` would also be matched by a `'Contoso.MyApp'`
  entry.
- If the resource is itself a **PowerShell adapter** whose nested resources
  need their own module lookup, add its full type to `ADAPTER_TYPES`. The
  parser then recurses into its `properties.resources` array.

After editing, rebuild the api container. The parser's in-memory schema cache
is per-process, so a restart picks up the new map automatically.

## Other things you may want to change

- **DSC v3 schema URL** — set `DSC_CONFIG_SCHEMA_URL` to a pinned version of
  the bundled schema if you'd rather not float with `aka.ms`'s redirect. The
  parser fetches it once and caches in memory.
- **Postgres credentials** — change `POSTGRES_USER` / `POSTGRES_PASSWORD` /
  `POSTGRES_DB` and `DATABASE_URL` in `.env` (compose) or
  `k8s/10-postgres-secret.yaml` (k8s).
- **Web port / API port** — `WEB_PORT` (default `8080`) and `API_PORT` (default
  `3000`).
- **Default labels on new servers** — currently the UI's `AddServerDialog`
  ships with an empty `{}` label JSON. If you want a default like
  `{ "owner": "platform-team" }`, edit the form initial state in
  [`apps/web/src/components/AddServerDialog.tsx`](../apps/web/src/components/AddServerDialog.tsx).
