# DSC Fleet Dashboard — User Guide

This guide walks through the dashboard screen by screen so you can get from
"new tenant" to "Windows fleet under DSC v3 management" without spelunking
through the source. Each section is task‑oriented: the headings answer
"How do I X?".

The top navigation bar always shows four tabs — **Servers**, **Configs**,
**Assignments**, **Jobs** — plus a user menu and a light/dark theme toggle on
the right.

---

## 1. Signing in

The app is gated by Microsoft Entra ID (MSAL redirect flow).

What you'll see the first time you load the URL:

1. A centered spinner with **"Signing you in…"**.
2. A redirect to your tenant's Entra sign‑in page. Use your normal corporate
   account (the one that has been granted access to the Fleet API app
   registration).
3. On first sign‑in your tenant admin may show a consent prompt for the
   scopes the dashboard requests (read your profile + call the Fleet API).
   Approve it once.
4. You land back on the dashboard, defaulted to the **Servers** tab. Your
   account name appears in the top‑right user menu — click it to sign out.

If sign‑in fails you'll stay on the spinner; check the browser console for
the underlying MSAL error and confirm your account is in the API's allowed
group.

---

## 2. Servers tab

**Path:** `/servers`. This is the home of your fleet inventory.

### What you see

A header (**"Servers"** + a one‑line description) with a **Refresh** button
and an **Add Server** button on the right, then a single table:

| Column | Meaning |
|---|---|
| **Name** | Friendly name (clickable — drills into the detail page). The Windows hostname reported by the agent appears in small grey text next to it. |
| **Azure target** | First 8 chars of the subscription ID, then `<resource-group>/<vm-name>` in monospace. |
| **Status** | Live status pill (`online`, `offline`, `error`, etc.) updated over the WebSocket. If the agent reported an error, the truncated message is shown below the pill — hover for the full text. |
| **Last heartbeat** | Relative time since the last agent check‑in. |
| **Created** | When the row was added to the dashboard. |
| **Actions** | A **View →** button (same as clicking the name) and a trash‑can **Remove** button. |

When the table is empty you get a **"No servers yet."** empty state with a
hint to click **Add Server**.

### Add a server

Click **Add Server** — a modal opens titled **"Add Azure VM"**. Fill in:

- **Azure subscription ID** (GUID).
- **Resource group**.
- **VM name** (the existing Azure VM you want to onboard).
- **Friendly name** (optional — defaults to the VM name).
- **Labels (JSON)** — a JSON object of free‑form tags. Defaults to `{}`. The
  dialog validates that this parses as a JSON object before submitting.
- **Run‑as identity** — what `DscV3-Apply` will run as on the box:
  - **SYSTEM** (default — no extra fields).
  - **Password account** — `DOMAIN\user` plus a password. The password
    field has an **eye / eye‑off** toggle so you can verify what you typed
    without anyone shoulder‑surfing the dots.
  - **gMSA** — `DOMAIN\name$` only.

Clicking **Add server** does two things in sequence: creates the dashboard
row, then queues a provision job via Azure `virtualMachines.runCommand`. You
get a toast like "*vm‑web‑01 queued for provisioning (job 1a2b3c4d).*" If
the provision queue fails for a reason other than "API not implemented", the
row is still created and a separate destructive toast tells you to re‑run
provisioning manually from the Server detail page.

### Remove a server

Click the trash icon. The confirm dialog reminds you this is a *soft delete*
— the row is hidden from all lists but assignments, run history, and audit
events stay in the database. **The actual Azure VM is not touched.**

---

## 3. Server detail page

**Path:** `/servers/<id>`. Reached by clicking a server name or **View →**.

The header gives you the friendly name, a live status pill, **Refresh** and
**Remove** buttons, the full Azure path
(`<sub>/<rg>/<vm>`), the agent‑reported hostname, OS caption, OS version,
and "last heartbeat: N minutes ago".

Below the header are six tabs. They default to **Prereqs**.

### 3.1 Prereqs tab — provisioning health

This is the "is this box actually ready" view. It aggregates the latest
provision and module‑install jobs and computes a required‑vs‑installed
modules table from this server's assignments.

Two action buttons sit at the top:

- **Re‑run provisioning** — see [§7 Reprovisioning](#7-reprovisioning) for
  the full flow (the button behaves differently depending on the stored
  run‑as identity).
- **Install missing modules** — disabled when nothing is missing. Otherwise
  shows the count, e.g. **"Install missing modules (3)"**, and queues a
  module‑install job for those exact modules.

To the right of the buttons a small `🛡 N/M required modules installed`
status line summarises coverage.

Then:

- **Required modules** card — table of every module any assignment on this
  server needs, with required min‑version, currently installed version, how
  many assignments need it ("used by"), and an `installed` / `missing`
  badge.
- **Recent provisioning jobs** + **Recent module‑install jobs** — two
  side‑by‑side cards listing the last three jobs of each type. Each card
  shows the job type, status pill, when it was requested, and any captured
  log output.

### 3.2 Assignments tab

A table of every config assigned to this server (terminal `removed` and
`removal_expired` rows are hidden). Columns:

- **Config** — clickable link to the config editor.
- **Revision** — current pinned version (e.g. `v3`). When the config has a
  newer revision available, an amber **"v4 available"** button appears
  inline; click it to bump the assignment's pinned revision (only enabled
  while the assignment is `active`).
- **Interval** — apply cadence in minutes.
- **Lifecycle** — `active`, `removing`, etc.
- **Prereqs** — pill summarising whether all required modules are
  installed.
- **Last status** — outcome of the last run (`in_desired_state`, `drift`,
  `errors`). Includes the version that ran and a **pending vN** badge if
  you've pinned a newer version that hasn't applied yet.
- **Last run** / **Next due** — relative timestamps.
- **Actions** — trash icon. For an `active` assignment this performs a
  *soft* remove (the agent stops applying on its next check‑in, history
  preserved). For an assignment stuck in `removing`, the button becomes a
  **Force remove** that skips the agent ack and frees the slot — use this
  when the agent is offline or the previous removal hung.

### 3.3 Run history tab

A simple table: short run id, **Result** (`in desired state` / `drift` /
`errors` plus the `exit N` code), duration, and start time.

**Click any row** to open the **Run output** dialog — a wide modal showing
the run's `dscOutput`. The agent posts `dsc config set --output-format
json`'s stdout as `{ raw: "<stdout>" }`; the dialog auto‑detects JSON and
pretty‑prints it, falling back to the raw text otherwise. To copy or share,
select all in the `<pre>` block (`Ctrl+A` then `Ctrl+C`); dialog title
includes the short run id you can quote in chat / tickets.

### 3.4 Modules tab

Everything the agent reported on its last heartbeat: module name, installed
version, when it was discovered, and a green `required` badge if any
assignment on this server needs it. Required rows are tinted so they stand
out.

### 3.5 Audit tab

Up to 100 most‑recent audit events scoped to this server entity:
**When**, **Event** (e.g. `assignment.created`, `server.runas.updated`),
**Entity** (`<type>/<short-id>`), and **Actor** (`user:abcd1234`,
`system:`, etc.). Read‑only.

### 3.6 Jobs tab

Every job ever queued for this server, newest first. Each card shows job
type, status pill, requested time, and the streaming log output. Live
updated over the WebSocket — running jobs refresh as new lines arrive,
so you can use this tab to watch a provision or module install in real
time.

> The full UI doesn't expose a separate **Settings** screen — server
> attributes (labels, run‑as) are set when adding the server. To change
> the run‑as identity later, use **Re‑run provisioning** on the Prereqs
> tab and pick the new identity in the dialog.

---

## 4. Configurations

**Path:** `/configs`.

### List view

A table of every (non‑deleted) config you've authored:

- **Name** — clicks through to the editor.
- **Description** — first line from the metadata block.
- **Version** — the highest revision number (`v3`, `v7`…).
- **Required modules** — info badges for each module the latest revision
  needs. PowerShell modules are extracted from the YAML during validate.
- **Assignments** — how many active assignments exist.
- **Updated** — relative time since the latest revision.
- A trash icon at the end. Removing is soft (revision history is kept)
  and the API rejects it if any active assignments still point at the
  config — remove those first via the Assignments page.

Click **New Config** (top right) to open the editor with a blank document.

### Editor (`/configs/new` or `/configs/<id>`)

A three‑pane layout:

#### Left pane — sample picker

A vertical stack of 9 starter samples. Each card has a title, a one‑line
blurb, and a **"Use this"** button. Clicking it opens a small form modal —
fill in the parameter fields the sample exposes, then click **Insert into
editor** to render the sample YAML and load it into the editor (replaces
the current text — you'll get a "Sample applied to editor" toast). The full
catalog:

| # | Sample | What it does |
|---|---|---|
| 1 | **Single registry value** | Sets one HKLM value via the built‑in `Microsoft.Windows/Registry` resource. Choose key path, value name, type (`DWord`/`String`/`QWord`/`MultiString`), and data. |
| 2 | **Bulk .reg import** | Imports a Windows `.reg` file via the custom `DscV3.RegFile/RegFile` resource (wrapped in `Microsoft.DSC/PowerShell`). Specify the path on the agent and an optional SHA256 for tamper detection. |
| 3 | **winget package** | Installs (or removes) a winget package via `Microsoft.WinGet.DSC/WinGetPackage`. Pick the package Id, the source (`winget` or `msstore`), and `Present`/`Absent`. |
| 4 | **MSI from UNC share** | Installs an MSI from a file share via `PSDscResources/MsiPackage`. Specify the MSI ProductCode GUID, UNC path, and msiexec arguments. |
| 5 | **MSI from HTTPS URL** | Downloads and installs an MSI from an HTTPS URL via `PSDscResources/MsiPackage`. Same fields as #4 but with a URL. **Strongly recommended:** also fill in the SHA256 — without it a MITM can deliver arbitrary code as SYSTEM. |
| 6 | **PSGallery module install** | Installs a PowerShell module via `Install-PSResource`, wrapped in `PSDscResources/Script` so DSC can do `Get/Test/Set`. Trusts PSGallery if needed. |
| 7 | **Inline Get/Test/Set script** | The escape hatch: a `PSDscResources/Script` resource where you provide raw `TestScript` and `SetScript` blocks. Use when nothing else fits. |
| 8 | **Windows service state** | Configures a service via `PSDesiredStateConfiguration/Service` — set `StartupType` (`Automatic`/`Manual`/`Disabled`) and `State` (`Running`/`Stopped`). |
| 9 | **Windows server role/feature** | Installs or removes a server role/feature via `PSDscResources/WindowsFeature`. Set `Ensure` and `IncludeAllSubFeature`. |

A yellow banner above the editor reminds you: **"Do not store secrets in
YAML."** Database backups contain config content verbatim — reference a
secret store at apply time instead.

#### Center pane — Monaco YAML editor

Full Monaco editor with monaco‑yaml wired to a locally hosted copy of the
DSC v3 bundled document schema, plus a custom IntelliSense layer that
suggests known DSC `type:` values and the per‑resource property bags. You
get hover docs, completions, validation squiggles, and `Format Document`
support out of the box. Word‑wrap is on; minimap is off; the theme follows
your light/dark choice.

Two buttons sit above the editor:

- **Validate** — formats the document first (so YAML alignment mistakes
  the formatter would have fixed don't trip the parser), then POSTs the
  result to `/configs/parse`. Errors and warnings show up in the right
  pane; required modules are extracted and shown as info badges.
- **Create** / **Save new revision** — also formats first, then saves.
  Disabled until **Name** is filled in (you'll see a small amber
  "Name required to save →" hint). On a new config this navigates you to
  `/configs/<new-id>`. On an existing config this creates a new immutable
  revision — old revisions stay in history.

#### Right pane — metadata + parse result

- **Name** (required) and **Description** (optional).
- **Required modules** — populated from the latest validate result, falling
  back to whatever the saved revision recorded. If the list looks stale,
  click **Validate** again.
- **Errors** / **Warnings** sections — only appear when the last validate
  produced any. Each item is a single line you can click to find in the
  YAML.

### Remove a config

From the list (trash icon) or from the editor header (**Remove** button —
only visible when editing an existing config). Soft delete — revisions and
run history are retained in the DB. The API rejects removal if any active
or pending‑removal assignments still reference the config.

---

## 5. Assignments

**Path:** `/assignments`. One row per server; each assigned config is a
clickable chip.

### What you see

Header with a **"Filter servers…"** text box (filters by server name as
you type) and a **Refresh** button.

Each server row contains:

- **Server name** (clickable to detail) + status pill + a count line
  ("3 configs assigned" / "No configs assigned.").
- A row of **chips** — one per active or removing assignment. Each chip
  shows: lifecycle pill, config name, current revision (`v3`),
  interval (`every 15m`), last‑run status pill + the version that last
  ran, and amber callouts when an upgrade is pending or available
  (e.g. **"v4 available"**, **"pending v4"**).
- An **Add** button on the right.

The list paginates 25 servers at a time when filtered results exceed that.

### Assign a config to a server

1. Click **Add** on the server row.
2. The **"Assign a config to <server>"** dialog opens. Pick a configuration
   from the dropdown — already‑assigned configs are filtered out.
3. Pick an interval from the dropdown
   (5 / 10 / 15 / 30 / 60 / 120 / 240 / 1440 minutes).
4. Click **Create assignment**. The agent will install any missing required
   modules on its next heartbeat and start applying on the configured
   cadence. You get a "Assignment created" toast.

### Manage an existing assignment (chip menu)

Click any chip to open its menu:

- The dialog title is **"<config> on <server>"** with a small revision
  badge.
- Change the **Interval** dropdown and click **Save interval** (only
  enabled when the value differs from the current one).
- If the config has a newer revision than what's pinned, an **"Update to
  vN"** primary button appears — click it to bump the pinned revision.
- **View config →** and **View server →** are quick shortcuts.
- The destructive **Remove** (or **Force remove** if the assignment is
  already in `removing`) button on the bottom‑left opens a confirmation
  dialog. Soft remove asks the agent to uninstall on its next check‑in;
  force remove skips the ack and marks the assignment terminal so you can
  reassign the same config.

> **Run‑now** is not a separate button. Lower the interval (or queue a
> module install / re‑provision from Server detail) to trigger a run
> sooner. Run history for an assignment is reachable via Server detail →
> Run history (or jump from the chip menu's **View server →**).

---

## 6. Jobs / Run history

**Path:** `/jobs`. The fleet‑wide queue of background work — provisions,
module installs, removals, etc. Live‑updated over the WebSocket.

Header has a **Refresh** button and a **status filter** dropdown
(`all` / `queued` / `running` / `success` / `failed` / `cancelled`).

Each job is a card showing:

- **Type** (e.g. `provision`, `module-install`).
- **Status pill** and an **attempts: N** badge if it has retried.
- The associated server (clickable to that server's detail page) and three
  relative timestamps: requested, started, finished.
- An **error code** in red when applicable.
- The streaming **log output** in a monospace block (max ~12 lines,
  scrollable). For finished jobs this is the final captured stdout/stderr;
  for `running` jobs it appends in real time.

#### Reading run output

For *config apply* runs (recorded as **run results**, not jobs), use
**Server detail → Run history → click a row** to open the run output
dialog. The agent posts `dscOutput` as `{ raw: "<dsc stdout>" }` where
the stdout is itself a JSON document from
`dsc config set --output-format json`. The dialog pretty‑prints valid
JSON, otherwise shows the raw stream.

#### Status meanings

- **queued** — accepted, waiting for a worker.
- **running** — picked up; logs appended as they arrive.
- **success** — exited 0; resources applied (or already in desired state).
- **failed** — non‑zero exit or unhandled exception. Inspect the log and
  the `error code` line.
- **cancelled** — explicitly cancelled, or superseded by a newer job for
  the same target.

#### Copy / share output

Select the text inside the log `<pre>` block (`Ctrl+A` while focused, then
`Ctrl+C`). Reference a job by the short id shown in toasts, or quote the
short run id from the run‑output dialog title when filing tickets.

---

## 7. Reprovisioning

### When to use it

Re‑run provisioning whenever:

- The agent or `DscV3-Apply` task got removed / corrupted.
- You need to **rotate the run‑as credential** (or move from password ->
  gMSA / SYSTEM).
- The bootstrap previously failed and you've fixed the underlying issue
  (e.g. WinRM reachability, RBAC on the VM).
- You're updating a stuck or out‑of‑date agent.

### The flow

1. Open the affected server (**Servers** → click the name).
2. Stay on the **Prereqs** tab and click **Re‑run provisioning**.
3. The button branches on the *currently stored* run‑as identity:
   - If it's **SYSTEM**, no dialog — the dashboard immediately POSTs an
     empty body to `/servers/<id>/provision-token`, queues a job, and
     toasts the short job id.
   - If it's **password** or **gMSA**, the **"Re‑run provisioning —
     <server>"** dialog opens. **The dashboard never silently reuses the
     stored password.** You must re‑confirm the credentials.
4. In the dialog:
   - Pick the **Run‑as identity** radio (`SYSTEM` / `Password account` /
     `gMSA`). Switching to SYSTEM clears the username field so a stale
     value can't look like an override.
   - For **Password account**, type the `DOMAIN\user` and the password.
     The password field is the same `PasswordInput` you saw in
     **Add Server** — click the eye icon on the right to toggle
     visibility. `autocomplete="new-password"` is set so your browser
     won't auto‑fill stored passwords (this is a credential prompt, not
     a login form).
   - For **gMSA**, type just `DOMAIN\name$`.
5. Click **Re‑run provisioning**. Validation: password run‑as requires
   both fields; gMSA requires the username. On submit you get a
   "Provisioning queued" toast with the short job id and the dialog
   closes.

### What happens on the agent side

The dashboard hands the provision request to the API, which uses Azure
`virtualMachines.runCommand` to run the bootstrap script on the VM.
That script:

- Installs / refreshes the DSC v3 agent and the `DscV3-Apply` scheduled
  task.
- Re‑creates the task to run as the identity you confirmed in step 4
  (SYSTEM / `DOMAIN\user` with password / gMSA).
- For password run‑as, the password is delivered via a one‑time URL and
  is **never** persisted in the Azure Run‑Command instance view
  (which would otherwise leak it to anyone with read access on the VM).
- Reports back with a heartbeat; the **Recent provisioning jobs** card
  on the Prereqs tab will flip from `running` to `success` (or `failed`,
  with the captured log).

After a successful re‑provision the **Required modules** table should
re‑populate as the agent reports its module inventory on the next
heartbeat. If anything's still missing, click **Install missing modules**
on the same tab.

---

## Appendix — quick keyboard / mouse cheats

- **Click a server name** anywhere → server detail.
- **Click a config name** anywhere → config editor.
- **Click an assignment chip** → manage that assignment (interval, update
  revision, remove).
- **Click a run row** in Server detail → Run history → run output dialog.
- **Eye icon** on any password field → toggle visibility (the field still
  defaults to hidden when reopened).
- **Refresh button** (top right of every tab) → re‑fetches every query
  scoped to that page (handy when you don't want to wait for the next
  WebSocket event).
- **Theme toggle** (top right of the nav bar) → light / dark; the Monaco
  editor follows the choice.
