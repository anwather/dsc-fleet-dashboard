# DSC v3 configuration authoring guide

This guide is for authors writing DSC v3 YAML configurations in the **dsc-fleet-dashboard** Monaco editor. Configurations are stored in the dashboard, assigned to lab agents, fetched by the `dsc-fleet` PowerShell runner (`bootstrap/Invoke-DscRunner.ps1`), and applied with `dsc config set --file <yaml>` on Windows Server lab hosts.

> **Audience:** anyone writing or editing a configuration in the dashboard. You do not need to know how the runner works to use this guide, but a few sections (validation, troubleshooting) reference its behaviour.

---

## 1. DSC v3 quick primer

### 1.1 Document anatomy

Every configuration is a single YAML document with at minimum a `$schema` and a `resources:` array:

```yaml
# yaml-language-server: $schema=https://aka.ms/dsc/schemas/v3/bundled/config/document.json
$schema: https://aka.ms/dsc/schemas/v3/bundled/config/document.json
metadata:
  Microsoft.DSC:
    securityContext: elevated   # the agent runs as SYSTEM; declare it
  description: What this config does, in one line.
resources:
  - name: A human-readable name shown in dsc output
    type: <namespace>/<resourceName>
    properties:
      key: value
```

* **`$schema`** — pinned to the bundled DSC v3 config-document schema. The yaml-language-server comment gives you Monaco completions; the `$schema` property triggers validation in the API.
* **`metadata.Microsoft.DSC.securityContext: elevated`** — required because the runner is invoked from a SYSTEM scheduled task; many resources (Registry, MsiPackage, WindowsFeature) require elevation.
* **`resources[]`** — an ordered list. DSC processes them top-to-bottom for `set`; `get`/`test` may run in parallel.

### 1.2 The Get / Test / Set contract

Every DSC resource implements three verbs. The dashboard runner only ever calls `set`, but understanding all three helps when reading errors:

| Verb  | Returns                          | When it runs                                  |
| ----- | -------------------------------- | --------------------------------------------- |
| `get` | Current state of the system      | Diagnostic only; the runner does not call it. |
| `test`| `inDesiredState: true \| false`  | Implicitly first half of `set` — skips work if already in desired state. |
| `set` | Applies changes; re-runs `test`. | This is what the runner invokes per assignment. |

A well-written resource is **idempotent**: running `set` twice in a row produces no change on the second run.

### 1.3 Resource type strings

A resource type is `<namespace>/<name>`. Examples:

| Type | Means |
| ---- | ----- |
| `Microsoft.Windows/Registry`           | Built-in single registry value resource. |
| `Microsoft.Windows/WindowsPowerShell`  | Adapter resource. Hosts PS 5.1 v1 DSC resources. |
| `Microsoft.DSC/PowerShell`             | Adapter resource. Hosts PS 7+ class-based DSC resources. |
| `PSDscResources/MsiPackage`            | A v1 PS 5.1 resource — must run **inside** the `Microsoft.Windows/WindowsPowerShell` adapter. |
| `Microsoft.WinGet.DSC/WinGetPackage`   | A PS 7 class resource — runs **inside** the `Microsoft.DSC/PowerShell` adapter. |
| `DscV3.RegFile/RegFile`                | This repo's custom resource — PS 7 only, runs inside `Microsoft.DSC/PowerShell`. |

The dashboard's parser (`apps/api/src/services/yamlParser.ts`) walks resources and uses the namespace to compute `requiredModules`. That list is what the runner installs from PSGallery before applying the config.

---

## 2. Adapter selection rules

DSC v3 itself ships only a handful of native resources. Anything written as a classic PowerShell DSC resource has to be hosted by an **adapter**. Picking the wrong adapter is the single most common authoring error.

### 2.1 The two adapters

#### `Microsoft.Windows/WindowsPowerShell` — Windows PowerShell 5.1

Use this for:

* **`PSDscResources`** — `MsiPackage`, `Script`, `Archive`, `Environment`, `Group`, `User`, `WindowsFeature`, `WindowsProcess`, etc.
* **`PSDesiredStateConfiguration`** — the legacy in-box module. Most useful members today are `Service` and `File`.
* Any other v1 (MOF/script-style) DSC resource shipping under PS 5.1.

It loads modules from `C:\Program Files\WindowsPowerShell\Modules` and runs in the **Desktop** PowerShell edition.

#### `Microsoft.DSC/PowerShell` — PowerShell 7.2+

Use this for:

* **`Microsoft.WinGet.DSC`** — `WinGetPackage`, `WinGetSource`, `WinGetUserSettings`. Class-based, PS 7-only.
* **`DscV3.RegFile`** (this fleet's custom module) — class-based, manifest pins `PowerShellVersion = '7.2'` and `CompatiblePSEditions = @('Core')`.
* Any other modern class-based resource that targets PS 7.

It loads modules from `C:\Program Files\PowerShell\Modules` and runs in the **Core** edition.

### 2.2 Why you cannot mix them

The `DscV3.RegFile` module manifest declares:

```powershell
PowerShellVersion    = '7.2'
CompatiblePSEditions = @('Core')
```

If you nest `DscV3.RegFile/RegFile` under `Microsoft.Windows/WindowsPowerShell` (PS 5.1), the module loader refuses to import it and you get an opaque "resource not found" or "module incompatible with this edition" error in `dsc` output. The reverse is also true — most `PSDscResources` cmdlets work fine in PS 7, but the v1 DSC engine that the `Microsoft.Windows/WindowsPowerShell` adapter exposes does not exist in PS 7, so put them under that adapter and never under `Microsoft.DSC/PowerShell`.

### 2.3 Decision table

| You want to… | Resource | Adapter |
| ------------ | -------- | ------- |
| Set a single registry value | `Microsoft.Windows/Registry` | None — top-level |
| Bulk-import a `.reg` file | `DscV3.RegFile/RegFile` | `Microsoft.DSC/PowerShell` |
| Install an MSI (UNC or HTTPS) | `PSDscResources/MsiPackage` | `Microsoft.Windows/WindowsPowerShell` |
| Install a winget package | `Microsoft.WinGet.DSC/WinGetPackage` | `Microsoft.DSC/PowerShell` |
| Configure a service | `PSDesiredStateConfiguration/Service` | `Microsoft.Windows/WindowsPowerShell` |
| Install/remove a server role | `PSDscResources/WindowsFeature` | `Microsoft.Windows/WindowsPowerShell` |
| Install a PSGallery module | `PSDscResources/Script` calling `Install-PSResource` | `Microsoft.Windows/WindowsPowerShell` |
| Run an arbitrary script | `PSDscResources/Script` | `Microsoft.Windows/WindowsPowerShell` |

---

## 3. Sample reference

These are the canned starters available from the dashboard's **Samples** menu (defined in `apps/web/src/lib/samples.ts`). Each one is a complete, valid configuration.

### 3.1 Single registry value — `Microsoft.Windows/Registry`

Sets one HKLM value with the built-in resource. No adapter needed.

```yaml
$schema: https://aka.ms/dsc/schemas/v3/bundled/config/document.json
metadata:
  Microsoft.DSC:
    securityContext: elevated
  description: Set a single HKLM registry value.
resources:
  - name: ManagedBy marker
    type: Microsoft.Windows/Registry
    properties:
      keyPath:   HKLM\SOFTWARE\Contoso\DscV3
      valueName: ManagedBy
      valueData:
        DWord: "1"
      _exist: true
```

**When to use:** changing one or two values. The `valueData` block uses the value type as a key (`DWord`, `String`, `QWord`, `MultiString`, `Binary`, `ExpandString`).

### 3.2 Bulk `.reg` import — `DscV3.RegFile/RegFile`

Applies an entire `.reg` file in one shot. See [§4](#4-dscv3regfile-module-guide) for the full module guide.

```yaml
resources:
  - name: Baseline registry import
    type: Microsoft.DSC/PowerShell
    properties:
      resources:
        - name: Import .reg file
          type: DscV3.RegFile/RegFile
          properties:
            Path:   C:\ProgramData\DscV3\repo\configs\registry\files\baseline-security.reg
            Hash:   ''                  # optional SHA256
            Ensure: Present
```

**When to use:** dozens of values across many keys; baselines exported from a reference machine; anything where editing N `Microsoft.Windows/Registry` blocks would be tedious.

### 3.3 winget package — `Microsoft.WinGet.DSC/WinGetPackage`

```yaml
resources:
  - name: Install 7-Zip
    type: Microsoft.WinGet.DSC/WinGetPackage
    properties:
      Id:     7zip.7zip
      Source: winget        # or msstore
      Ensure: Present
```

**When to use:** the package exists in winget. Faster than authoring an MSI install; handles upgrades natively. Note that this is a top-level resource type but the parser walks namespaces — it requires the `Microsoft.WinGet.DSC` PSGallery module which the runner installs automatically.

### 3.4 MSI from UNC share — `PSDscResources/MsiPackage`

```yaml
resources:
  - name: ACME Agent MSI
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install MSI
          type: PSDscResources/MsiPackage
          properties:
            ProductId: '{8E9A3C2A-1C7C-4F31-9F1A-AAAAAAAAAAAA}'
            Path:      \\fileshare01.contoso.local\packages\AcmeAgent\AcmeAgent-1.4.0.msi
            Ensure:    Present
            Arguments: /qn /norestart REBOOT=ReallySuppress
```

**When to use:** the MSI lives on an SMB share the lab agent (running as SYSTEM, i.e. computer account) can read. `ProductId` is the MSI ProductCode and is the **idempotency key** — if Windows reports that GUID installed, the resource is already in desired state.

### 3.5 MSI from HTTPS URL — `PSDscResources/MsiPackage`

```yaml
resources:
  - name: ACME Agent MSI from URL
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install MSI from URL
          type: PSDscResources/MsiPackage
          properties:
            ProductId:     '{8E9A3C2A-1C7C-4F31-9F1A-AAAAAAAAAAAA}'
            Path:          https://downloads.contoso.com/acme/AcmeAgent-1.4.0.msi
            Ensure:        Present
            Arguments:     /qn /norestart REBOOT=ReallySuppress
            FileHash:      'A1B2C3...'
            HashAlgorithm: SHA256
```

**When to use:** the installer is on a public or internal HTTPS endpoint. **Always supply `FileHash` + `HashAlgorithm: SHA256`** — without it, anyone who can MITM the connection or replace the file on the origin server can deliver arbitrary code that runs as SYSTEM.

### 3.6 PSGallery module install — `PSDscResources/Script`

```yaml
resources:
  - name: Install Microsoft.WinGet.Client
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install-PSResource Microsoft.WinGet.Client
          type: PSDscResources/Script
          properties:
            GetScript: |
              $m = Get-Module -ListAvailable -Name Microsoft.WinGet.Client |
                   Sort-Object Version -Descending | Select-Object -First 1
              @{ Result = if ($m) { $m.Version.ToString() } else { 'absent' } }
            TestScript: |
              $null -ne (Get-Module -ListAvailable -Name Microsoft.WinGet.Client)
            SetScript: |
              if (-not (Get-PSResourceRepository -Name PSGallery).Trusted) {
                  Set-PSResourceRepository -Name PSGallery -Trusted -Confirm:$false
              }
              Install-PSResource -Name Microsoft.WinGet.Client -Repository PSGallery `
                                 -Scope AllUsers -TrustRepository -Confirm:$false
```

**When to use:** you need a helper PowerShell module on the lab host. For DSC modules used in configs, prefer letting the runner install them automatically (it derives the list from `requiredModules` in the parsed YAML). Use this pattern for *runtime* modules, not DSC resource modules.

### 3.7 Inline script — `PSDscResources/Script`

The escape hatch. Use it when no resource fits.

```yaml
resources:
  - name: Provision C:\Tools
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Provision C:\Tools (script)
          type: PSDscResources/Script
          properties:
            GetScript: |
              @{ Result = (Test-Path 'C:\Tools') }
            TestScript: |
              Test-Path 'C:\Tools'
            SetScript: |
              New-Item -Path 'C:\Tools' -ItemType Directory -Force | Out-Null
```

**When to use:** sparingly. You own the idempotency contract — `TestScript` must return `$true` after `SetScript` ran successfully, otherwise DSC re-runs `Set` forever. Returning anything other than `$true`/`$false` from `TestScript` is undefined behaviour.

### 3.8 Service state — `PSDesiredStateConfiguration/Service`

```yaml
resources:
  - name: Service baseline
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Configure Spooler
          type: PSDesiredStateConfiguration/Service
          properties:
            Name:        Spooler
            StartupType: Disabled       # Automatic | Manual | Disabled
            State:       Stopped        # Running | Stopped
            Ensure:      Present
```

**When to use:** ensure a service is running, stopped, disabled at boot. `Ensure: Absent` removes the service definition entirely (rarely what you want — almost always use `Stopped` + `Disabled`).

### 3.9 Windows server role/feature — `PSDscResources/WindowsFeature`

```yaml
resources:
  - name: Web-Server role
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Present Web-Server
          type: PSDscResources/WindowsFeature
          properties:
            Name:                 Web-Server
            Ensure:               Present
            IncludeAllSubFeature: false
```

**When to use:** install/remove server roles and features. `Name` is the short feature name from `Get-WindowsFeature`. `IncludeAllSubFeature: true` pulls in every dependent feature — for IIS that means dozens of role services, so leave it `false` unless you actually want them.

---

## 4. DscV3.RegFile module guide

`DscV3.RegFile` is the fleet's bespoke module (`C:\Source\dsc-fleet\modules\DscV3.RegFile`). It takes a `.reg` file and applies it idempotently. The current version is **0.3.0**.

### 4.1 The class

```text
[DscResource()] class RegFile {
    [Key]    [string] $Path                  # local or UNC path on the agent
    [Write]  [string] $Hash    = ''          # optional SHA256 of .reg contents
    [Write]  [Ensure] $Ensure  = Present     # Present | Absent
    [Read]   [string] $ActualHash
    [Read]   [int]    $ValuesChecked
    [Read]   [int]    $ValuesMatching
}
```

* **`Path`** is the **key** — DSC uses it to identify the resource instance. Two `RegFile` blocks with the same `Path` are the same instance.
* **`Hash`**, when set, is checked at `Test`/`Set` time. If `Get-FileHash` of the file at `Path` does not match, the resource throws *before* importing. This protects against a tampered `.reg` on a share.

### 4.2 Test/Set semantics

* **`Test`** parses the `.reg` file into entries `{Key, Name, Type, Value}` and, for each entry:
  * `Ensure: Present` — every value must exist in the registry **and** equal the `.reg` value (typed comparison).
  * `Ensure: Absent`  — every value must **not** exist.
* **`Set`** for `Present` shells out to `reg.exe import "<Path>"` (so you get exactly stock Windows semantics).
* **`Set`** for `Absent` walks the parsed entries and removes each named value (default values are cleared, never the whole key).

### 4.3 Pairing with file download

The fleet does not ship a "download from blob" resource — keep it simple by combining a `Script` resource that fetches the `.reg` with a `RegFile` resource that applies it. **Both must live under the same outer adapter only if the file is downloaded inside PS 7**, but the cleaner pattern is:

```yaml
resources:
  - name: Stage baseline.reg from blob
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Download baseline.reg
          type: PSDscResources/Script
          properties:
            GetScript:  |
              @{ Result = (Test-Path 'C:\ProgramData\DscV3\reg\baseline.reg') }
            TestScript: |
              if (-not (Test-Path 'C:\ProgramData\DscV3\reg\baseline.reg')) { return $false }
              (Get-FileHash 'C:\ProgramData\DscV3\reg\baseline.reg' -Algorithm SHA256).Hash -eq `
                'EXPECTED_SHA256_HEX_HERE'
            SetScript:  |
              New-Item 'C:\ProgramData\DscV3\reg' -ItemType Directory -Force | Out-Null
              Invoke-WebRequest -UseBasicParsing `
                -Uri 'https://contosolab.blob.core.windows.net/configs/baseline.reg' `
                -OutFile 'C:\ProgramData\DscV3\reg\baseline.reg'

  - name: Apply baseline.reg
    type: Microsoft.DSC/PowerShell
    properties:
      resources:
        - name: Import baseline.reg
          type: DscV3.RegFile/RegFile
          properties:
            Path:   C:\ProgramData\DscV3\reg\baseline.reg
            Hash:   EXPECTED_SHA256_HEX_HERE
            Ensure: Present
```

The order in `resources[]` matters — DSC runs the download first, then the import. The `Hash` on `RegFile` is your second line of defence: if the downloader was somehow fooled, the import still fails fast.

### 4.4 Supported `.reg` value types

`reg.exe export` produces a standard set of value-type prefixes. The 0.3.0 parser decodes each one into the typed value the registry actually stores, so `Test` compares like-for-like:

| `.reg` syntax              | Registry type     | Parsed as            |
| -------------------------- | ----------------- | -------------------- |
| `"Name"="text"`            | REG_SZ            | `[string]`           |
| `"Name"=dword:00000001`    | REG_DWORD         | `[int]`              |
| `"Name"=qword:0000000000000001` | REG_QWORD    | `[long]`             |
| `"Name"=hex(b):01,00,…`    | REG_QWORD (8 bytes LE) | `[long]` via `BitConverter::ToInt64` |
| `"Name"=hex:01,02,03`      | REG_BINARY        | `[byte[]]`           |
| `"Name"=hex(0):01,02`      | REG_NONE / binary | `[byte[]]`           |
| `"Name"=hex(2):25,00,54,…` | REG_EXPAND_SZ     | `[string]` (UTF-16 LE, NUL-trimmed, **not** env-expanded) |
| `"Name"=hex(7):41,00,…`    | REG_MULTI_SZ      | `[string[]]` (UTF-16 LE, split on NUL) |
| `"Name"=-`                 | (deletion)        | Skipped by `Test`; not enforced |
| `[-HKLM\…]`                | (key deletion)    | Skipped — RegFile only models value-level ops |

**REG_EXPAND_SZ comparison detail:** `Get-ItemProperty` auto-expands `%TEMP%` and friends, so the resource re-reads the unexpanded literal via `RegistryKey.GetValue(..., DoNotExpandEnvironmentNames)` and compares against that. This means `%SystemRoot%\System32` in a `.reg` file matches even when the live machine's `%SystemRoot%` is `C:\Windows`.

### 4.5 What 0.3.0 fixed

`0.3.0` rewrote `ParseValueLine` for `hex(<n>)` prefixes. Before 0.3.0, **every** `hex(*)` value was lumped into `Type = 'Binary'`. That broke three things:

1. **`hex(b)` / REG_QWORD** — `[long]$current -eq [long]$entry.Value` cast a `byte[]` to `long` and threw `Cannot convert "System.Byte[]" to "System.Int64"`. **`Test` would always fail** for any config containing a QWORD.
2. **`hex(2)` / REG_EXPAND_SZ** — `[byte[]]` never equalled `[string]`, so `Test` always returned `$false` and `Set` re-imported on every run.
3. **`hex(7)` / REG_MULTI_SZ** — same problem, plus the values appeared as binary blobs in `Get` output.

If you are still on 0.2.x and seeing those symptoms, upgrade to 0.3.0. The dashboard runner installs whatever version is referenced in `requiredModules`; bump your `minVersion` to `0.3.0`.

---

## 5. Common recipes

### 5.1 Download and install an MSI from HTTPS

Use the [§3.5 sample](#35-msi-from-https-url--psdscresourcesmsipackage). `MsiPackage` natively supports HTTP(S) `Path`. Always include `FileHash`.

### 5.2 Set a small set of registry keys

For ≤3 values use one `Microsoft.Windows/Registry` block per value (the §3.1 sample). For more, export to `.reg` and use the §3.2 / §4 pattern.

### 5.3 Create a scheduled task

There is no first-class scheduled-task DSC resource in the modules the runner installs by default. Use a `Script` resource:

```yaml
resources:
  - name: Nightly cleanup task
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Register cleanup task
          type: PSDscResources/Script
          properties:
            GetScript:  |
              $t = Get-ScheduledTask -TaskName 'ContosoCleanup' -ErrorAction SilentlyContinue
              @{ Result = if ($t) { $t.State.ToString() } else { 'absent' } }
            TestScript: |
              [bool] (Get-ScheduledTask -TaskName 'ContosoCleanup' -ErrorAction SilentlyContinue)
            SetScript:  |
              $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
                            -Argument '-NoProfile -File C:\Scripts\Cleanup.ps1'
              $trigger = New-ScheduledTaskTrigger -Daily -At 2am
              Register-ScheduledTask -TaskName 'ContosoCleanup' -Action $action `
                                     -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force
```

### 5.4 Ensure a service is running

Use the [§3.8 sample](#38-service-state--psdesiredstateconfigurationservice). `State: Running` + `StartupType: Automatic`.

### 5.5 Install a winget package

Use the [§3.3 sample](#33-winget-package--microsoftwingetdscwingetpackage). Search the catalog interactively first: `winget search 7zip`.

---

## 6. YAML pitfalls

### 6.1 Indentation

YAML is whitespace-sensitive. Use **two spaces per level** consistently — never tabs. Monaco's format-on-save normalises this, but copy/paste from another editor often introduces mixed indent or tab characters.

```yaml
# WRONG — tab between `name:` and value will fail to parse
resources:
  - name:	Bad indent

# WRONG — three-space indent under a two-space parent is OK to YAML but
# breaks visual scanning; pick one width and stick to it.
resources:
   - name: Inconsistent
```

### 6.2 Strings

* Plain scalars (no quotes) are fine for most values. Quote when the value contains `:`, `#`, `{`, `}`, `[`, `]`, `,`, `&`, `*`, `|`, `>`, `!`, leading/trailing spaces, or starts with one of `?`, `-`, `:`.
* Use **single quotes** to suppress all escape processing — recommended for paths, GUIDs, hashes:

  ```yaml
  ProductId: '{8E9A3C2A-1C7C-4F31-9F1A-AAAAAAAAAAAA}'
  Path:      'C:\ProgramData\DscV3\reg\baseline.reg'
  ```
* Use the **block scalar** `|` for multi-line scripts. Everything indented past the `|` is preserved literally including newlines:

  ```yaml
  SetScript: |
    New-Item C:\Tools -ItemType Directory -Force
    Set-Content C:\Tools\readme.txt 'managed by dsc'
  ```
* `>` (folded) joins lines with spaces — almost never what you want for PowerShell. Stick with `|`.

### 6.3 Backslashes

Inside double-quoted scalars, `\\` becomes `\`. Inside single-quoted or plain scalars, `\` is literal. Prefer single quotes for Windows paths to avoid surprises.

### 6.4 Booleans

YAML 1.2 booleans are `true`/`false` only, but the parser used by the dashboard (`yaml`) treats unquoted `Yes`/`No`/`On`/`Off` as plain strings. Stick with `true`/`false`.

### 6.5 Secrets — do not put them in configs

Configurations are stored verbatim in the dashboard, fetched over HTTPS by every assigned agent, **and cached on disk** under `C:\ProgramData\DscV3\state\revisions\`. Treat every config as world-readable to anyone with agent access. **Never inline:**

* passwords, API keys, certificates, private keys
* connection strings with embedded credentials
* OAuth tokens

If a resource needs a secret, fetch it at `Set` time from a runtime secret store (Azure Key Vault via managed identity, Windows Credential Manager, `SecretManagement` module). Pass only the *reference* (vault URI, secret name) in the YAML.

---

## 7. Validation flow

When you click **Validate** (or save) in the dashboard the editor sends the YAML body to the API, which:

1. **Parses** with the `yaml` package. A YAML syntax error returns `errors[]` with `YAML parse error: …` and stops.
2. **Hashes** the source bytes (`sourceSha256`) and the canonical-JSON form of the parsed object (`semanticSha256`). The semantic hash is what the dashboard compares to detect "real" changes vs comment/whitespace edits.
3. **Schema-validates** against the bundled DSC v3 config-document schema (`https://aka.ms/dsc/schemas/v3/bundled/config/document.json`) using AJV 2020. Failures appear as `schema: <jsonPath> <message>`.
4. **Walks `resources[]`**, recursing into the `properties.resources` of any resource whose `type` is in `ADAPTER_TYPES` (`Microsoft.Windows/WindowsPowerShell`, `Microsoft.DSC/PowerShell`).
5. **Maps namespaces to modules** using `NAMESPACE_MODULE_MAP`. Built-ins (`Microsoft.DSC`, `Microsoft.Windows`, `PSDesiredStateConfiguration`) map to `null` (no install needed); known custom namespaces (`PSDscResources`, `Microsoft.WinGet.DSC`, `DscV3.RegFile`) map to themselves; **anything else** is treated as the literal namespace string and the runner will try to install it from PSGallery. If you mistype a namespace, the runner will silently fail to install a non-existent module and you'll get a `resource not found` at apply time.

### 7.1 Format-on-validate

Monaco runs the YAML formatter when you press the validate button — that's why your indentation may snap into a canonical layout. Don't hand-fight it; let the formatter own whitespace.

### 7.2 What the errors mean

| Error                                              | Meaning |
| -------------------------------------------------- | ------- |
| `YAML parse error: …`                              | Syntactic — usually bad indent, an unclosed quote, or a tab. |
| `Document is empty or not an object.`              | The whole file evaluated to `null`/scalar/array. You probably forgot the top-level keys. |
| `schema: /resources/0 must have required property 'type'` | Resource block missing `type:`. |
| `schema: /resources/0/properties/resources must be array` | An adapter has nested `resources:` but you wrote it as a map. Use `- name: …` list items. |
| `schema validation skipped: …` (warning only)      | The schema URL was unreachable; parsing succeeded but validation was bypassed. Safe to retry. |
| `adapter resource X has non-array nested resources; skipping recursion` (warning) | The adapter's `properties.resources` is a scalar/object. Required-module detection won't recurse into it; almost certainly a typo. |

---

## 8. Troubleshooting matrix

Errors below appear in the run-output panel of the dashboard (forwarded from `dsc config set --output-format json` on the agent).

| Symptom                                              | Likely root cause                                      | Fix |
| ---------------------------------------------------- | ------------------------------------------------------ | --- |
| `Cannot convert "System.Byte[]" to "System.Int64"` while testing a `RegFile` | DscV3.RegFile ≤ 0.2.x parsing a `hex(b)`/REG_QWORD value as `Binary` (fixed in 0.3.0). | Upgrade `DscV3.RegFile` to `0.3.0`. Bump `minVersion` in your assignment if the runner installed an older one. |
| `RegFile: SHA256 mismatch for '<path>'. Expected X, got Y.` | `Hash` property doesn't match the actual file. | Re-hash the file: `Get-FileHash -Algorithm SHA256 <path>` (PowerShell). Update either the file or the `Hash` value. |
| `RegFile: Path '<path>' is not reachable.`           | Agent (running as SYSTEM, i.e. computer account) can't read the path. | If UNC, grant the computer account read access on the share/NTFS. If a downloaded file, make sure the upstream `Script` resource ran *before* the `RegFile` resource in the same config. |
| `reg.exe import '<path>' exited with code N.`        | Malformed `.reg` file or a value the registry rejects (e.g. trying to write a value under a protected key without elevation). | Run `reg import` manually on the host to see the underlying message. Check that `metadata.Microsoft.DSC.securityContext: elevated` is set. |
| `RegFile/RegFile: resource not found` or "module is not compatible with this PowerShell edition" | Nested `DscV3.RegFile/RegFile` under `Microsoft.Windows/WindowsPowerShell` (PS 5.1). | Move it under `Microsoft.DSC/PowerShell`. See [§2](#2-adapter-selection-rules). |
| `WinGetPackage: WinGet is not installed`             | The lab host has no winget bootstrap. | Add a prior `Script` resource that bootstraps `Microsoft.WinGet.Client` + `Repair-WinGetPackageManager`, *or* install the `Microsoft.WinGet.DSC` module via the runner's `requiredModules` flow and trigger the prereq endpoint. |
| `MsiPackage: Could not resolve URI: …`               | URL typo, certificate validation failure, or the agent has no outbound HTTPS. | `Invoke-WebRequest -Uri … -UseBasicParsing` from the host to reproduce. Check proxy / firewall. |
| `MsiPackage: file hash mismatch`                     | `FileHash` property is wrong. | Re-hash the published artifact: `Get-FileHash -Algorithm SHA256 <localCopy>`. |
| `Script: TestScript returned a non-Boolean value`    | Your `TestScript` block emits objects (e.g. forgot to suppress `Out-Null`). | Ensure the **last expression** evaluates to `$true` or `$false` only. Pipe noisy commands to `Out-Null`. |
| `Script: Set ran but Test still false` (loop)        | `SetScript` succeeded but `TestScript` doesn't recognise the new state. | Make sure both scripts agree on the same condition. Common bug: `SetScript` creates `C:\Tools` but `TestScript` checks `C:\tools` and the host has case-sensitive logic somewhere. |
| `assignments: HTTP 401`/`403` (in agent log, not config output) | Agent API key revoked or rotated. | Re-run the agent registration script. Not a config-authoring problem. |
| `prereq=installing` / `prereq=failed` and the config never applies | Runner couldn't install one of the `requiredModules` from PSGallery. | Check the namespace in your YAML — a typo means the runner tries to install a non-existent module. Verify `Find-PSResource <name>` from the host. |
| YAML validates but a property is silently ignored at apply | Property name casing or spelling wrong. The DSC engine warns but doesn't fail. | Check the resource schema (e.g. `dsc resource list --adapter Microsoft.Windows/WindowsPowerShell` then `dsc resource schema --resource …`). Property names are **case-sensitive** for class-based resources. |

---

## 9. Reference

* DSC v3 docs: https://learn.microsoft.com/powershell/dsc/overview
* PSDscResources: https://www.powershellgallery.com/packages/PSDscResources
* Microsoft.WinGet.DSC: https://www.powershellgallery.com/packages/Microsoft.WinGet.DSC
* DscV3.RegFile module source: `C:\Source\dsc-fleet\modules\DscV3.RegFile`
* Dashboard sample definitions: `apps/web/src/lib/samples.ts`
* Dashboard YAML validator: `apps/api/src/services/yamlParser.ts`
* Agent runner: `C:\Source\dsc-fleet\bootstrap\Invoke-DscRunner.ps1`
