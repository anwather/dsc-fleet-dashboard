/**
 * The 8 sample DSC v3 configuration patterns from dsc-fleet-configs/samples.
 * Embedded so the web bundle doesn't depend on the configs repo at runtime.
 *
 * Each sample exposes a small set of FormFields the user fills in;
 * `render(values)` produces the YAML body to seed the Monaco editor.
 */

export type FieldType = 'string' | 'number' | 'select' | 'textarea';

export interface SampleField {
  name: string;
  label: string;
  type: FieldType;
  default: string | number;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  required?: boolean;
}

export interface Sample {
  id: string;
  title: string;
  blurb: string;
  resourceType: string;
  fields: SampleField[];
  render: (v: Record<string, string | number>) => string;
}

const HEADER = `# yaml-language-server: $schema=https://aka.ms/dsc/schemas/v3/bundled/config/document.json
$schema: https://aka.ms/dsc/schemas/v3/bundled/config/document.json
metadata:
  Microsoft.DSC:
    securityContext: elevated`;

export const SAMPLES: Sample[] = [
  {
    id: 'registry-single-value',
    title: '1. Single registry value',
    blurb: 'Set one HKLM value via the built-in Microsoft.Windows/Registry resource.',
    resourceType: 'Microsoft.Windows/Registry',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'ManagedBy marker', required: true },
      { name: 'keyPath', label: 'Registry key path', type: 'string', default: 'HKLM\\SOFTWARE\\Contoso\\DscV3', required: true },
      { name: 'valueName', label: 'Value name', type: 'string', default: 'ManagedBy', required: true },
      { name: 'valueType', label: 'Value type', type: 'select', default: 'DWord', options: ['DWord', 'String', 'QWord', 'MultiString'] },
      { name: 'valueData', label: 'Value data', type: 'string', default: '1', required: true },
    ],
    render: (v) => `${HEADER}
  description: Set a single HKLM registry value.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/Registry
    properties:
      keyPath:   ${v.keyPath}
      valueName: ${v.valueName}
      valueData:
        ${v.valueType}: ${JSON.stringify(v.valueData)}
      _exist:    true
`,
  },
  {
    id: 'regfile-bulk-import',
    title: '2. Bulk .reg import',
    blurb: 'Import a Windows .reg file via the custom DscV3.RegFile/RegFile resource.',
    resourceType: 'DscV3.RegFile/RegFile',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Baseline registry import', required: true },
      { name: 'path', label: 'Path to .reg on agent', type: 'string', default: 'C:\\ProgramData\\DscV3\\repo\\configs\\registry\\files\\baseline-security.reg', required: true },
      { name: 'hash', label: 'SHA256 (optional)', type: 'string', default: '' },
    ],
    render: (v) => `${HEADER}
  description: Bulk-import a .reg file.
resources:
  - name: ${v.name}
    type: Microsoft.DSC/PowerShell
    properties:
      resources:
        - name: Import .reg file
          type: DscV3.RegFile/RegFile
          properties:
            Path:   ${v.path}
            Hash:   '${v.hash}'
            Ensure: Present
`,
  },
  {
    id: 'winget-install',
    title: '3. winget package',
    blurb: 'Install a winget package via Microsoft.WinGet.DSC/WinGetPackage.',
    resourceType: 'Microsoft.WinGet.DSC/WinGetPackage',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Install 7-Zip', required: true },
      { name: 'id', label: 'winget package Id', type: 'string', default: '7zip.7zip', required: true },
      { name: 'source', label: 'Source', type: 'select', default: 'winget', options: ['winget', 'msstore'] },
      { name: 'ensure', label: 'Ensure', type: 'select', default: 'Present', options: ['Present', 'Absent'] },
    ],
    render: (v) => `${HEADER}
  description: Install ${v.id} via winget.
resources:
  - name: ${v.name}
    type: Microsoft.WinGet.DSC/WinGetPackage
    properties:
      Id:     ${v.id}
      Source: ${v.source}
      Ensure: ${v.ensure}
`,
  },
  {
    id: 'msi-from-share',
    title: '4. MSI from UNC share',
    blurb: 'Install an MSI from a file share via PSDscResources/MsiPackage.',
    resourceType: 'PSDscResources/MsiPackage',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'ACME Agent MSI', required: true },
      { name: 'productId', label: 'MSI ProductCode {GUID}', type: 'string', default: '{8E9A3C2A-1C7C-4F31-9F1A-AAAAAAAAAAAA}', required: true },
      { name: 'path', label: 'UNC path to MSI', type: 'string', default: '\\\\fileshare01.contoso.local\\packages\\AcmeAgent\\AcmeAgent-1.4.0.msi', required: true },
      { name: 'args', label: 'MSI arguments', type: 'string', default: '/qn /norestart REBOOT=ReallySuppress' },
    ],
    render: (v) => `${HEADER}
  description: Install MSI ${v.productId}.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install MSI
          type: PSDscResources/MsiPackage
          properties:
            ProductId: '${v.productId}'
            Path:      ${v.path}
            Ensure:    Present
            Arguments: ${v.args}
`,
  },
  {
    id: 'msi-from-url',
    title: '5. MSI from HTTPS URL',
    blurb: 'Download and install an MSI from an HTTPS URL via PSDscResources/MsiPackage.',
    resourceType: 'PSDscResources/MsiPackage',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'ACME Agent MSI from URL', required: true },
      { name: 'productId', label: 'MSI ProductCode {GUID}', type: 'string', default: '{8E9A3C2A-1C7C-4F31-9F1A-AAAAAAAAAAAA}', required: true, helpText: 'MSI ProductCode — used as idempotency key. Get from msiexec /a or Win32_Product.IdentifyingNumber.' },
      { name: 'url', label: 'HTTPS URL to MSI', type: 'string', default: 'https://downloads.contoso.com/acme/AcmeAgent-1.4.0.msi', required: true },
      { name: 'fileHash', label: 'SHA256 of MSI (recommended)', type: 'string', default: '', helpText: 'Strongly recommended for URL installers — without it a MITM can deliver arbitrary code as SYSTEM.' },
      { name: 'args', label: 'MSI arguments', type: 'string', default: '/qn /norestart REBOOT=ReallySuppress' },
    ],
    render: (v) => `${HEADER}
  description: Install MSI ${v.productId} from URL.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install MSI from URL
          type: PSDscResources/MsiPackage
          properties:
            ProductId: '${v.productId}'
            Path:      ${v.url}
            Ensure:    Present
            Arguments: ${v.args}${v.fileHash ? `
            FileHash:      '${v.fileHash}'
            HashAlgorithm: SHA256` : ''}
`,
  },
  {
    id: 'psmodule-install',
    title: '6. PSGallery module install',
    blurb: 'Install a PowerShell module via Install-PSResource (PSDscResources/Script).',
    resourceType: 'PSDscResources/Script',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Install Microsoft.WinGet.Client', required: true },
      { name: 'moduleName', label: 'Module name', type: 'string', default: 'Microsoft.WinGet.Client', required: true },
    ],
    render: (v) => `${HEADER}
  description: Install ${v.moduleName} from PSGallery via Install-PSResource.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Install-PSResource ${v.moduleName}
          type: PSDscResources/Script
          properties:
            GetScript: |
              $m = Get-Module -ListAvailable -Name ${v.moduleName} |
                   Sort-Object Version -Descending | Select-Object -First 1
              @{ Result = if ($m) { $m.Version.ToString() } else { 'absent' } }
            TestScript: |
              $null -ne (Get-Module -ListAvailable -Name ${v.moduleName})
            SetScript: |
              if (-not (Get-PSResourceRepository -Name PSGallery).Trusted) {
                  Set-PSResourceRepository -Name PSGallery -Trusted -Confirm:$false
              }
              Install-PSResource -Name ${v.moduleName} -Repository PSGallery \`
                                 -Scope AllUsers -TrustRepository -Confirm:$false
`,
  },
  {
    id: 'inline-script',
    title: '7. Inline Get/Test/Set script',
    blurb: 'Escape hatch — run an inline PowerShell script via PSDscResources/Script.',
    resourceType: 'PSDscResources/Script',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Provision C:\\Tools', required: true },
      { name: 'testScript', label: 'TestScript', type: 'textarea', default: "Test-Path 'C:\\Tools'" },
      { name: 'setScript', label: 'SetScript', type: 'textarea', default: "New-Item -Path 'C:\\Tools' -ItemType Directory -Force | Out-Null" },
    ],
    render: (v) => `${HEADER}
  description: Inline script.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: ${v.name} (script)
          type: PSDscResources/Script
          properties:
            GetScript: |
              @{ Result = (${v.testScript}) }
            TestScript: |
              ${v.testScript}
            SetScript: |
              ${v.setScript}
`,
  },
  {
    id: 'service-state',
    title: '8. Windows service state',
    blurb: 'Configure a service via PSDesiredStateConfiguration/Service.',
    resourceType: 'PSDesiredStateConfiguration/Service',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Service baseline', required: true },
      { name: 'serviceName', label: 'Service name', type: 'string', default: 'Spooler', required: true },
      { name: 'startupType', label: 'StartupType', type: 'select', default: 'Disabled', options: ['Automatic', 'Manual', 'Disabled'] },
      { name: 'state', label: 'State', type: 'select', default: 'Stopped', options: ['Running', 'Stopped'] },
    ],
    render: (v) => `${HEADER}
  description: Configure service ${v.serviceName}.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: Configure ${v.serviceName}
          type: PSDesiredStateConfiguration/Service
          properties:
            Name:        ${v.serviceName}
            StartupType: ${v.startupType}
            State:       ${v.state}
            Ensure:      Present
`,
  },
  {
    id: 'windows-feature',
    title: '9. Windows server role/feature',
    blurb: 'Install/remove a server role via PSDscResources/WindowsFeature.',
    resourceType: 'PSDscResources/WindowsFeature',
    fields: [
      { name: 'name', label: 'Resource name', type: 'string', default: 'Web-Server role', required: true },
      { name: 'featureName', label: 'Feature name', type: 'string', default: 'Web-Server', required: true },
      { name: 'ensure', label: 'Ensure', type: 'select', default: 'Present', options: ['Present', 'Absent'] },
      { name: 'includeAllSubFeature', label: 'IncludeAllSubFeature', type: 'select', default: 'false', options: ['true', 'false'] },
    ],
    render: (v) => `${HEADER}
  description: ${v.ensure === 'Present' ? 'Install' : 'Remove'} ${v.featureName}.
resources:
  - name: ${v.name}
    type: Microsoft.Windows/WindowsPowerShell
    properties:
      resources:
        - name: ${v.ensure} ${v.featureName}
          type: PSDscResources/WindowsFeature
          properties:
            Name:                 ${v.featureName}
            Ensure:               ${v.ensure}
            IncludeAllSubFeature: ${v.includeAllSubFeature}
`,
  },
];

export const BLANK_YAML = `${HEADER}
  description: New configuration.
resources:
  - name: Example
    type: Microsoft.Windows/Registry
    properties:
      keyPath:   HKLM\\SOFTWARE\\Contoso\\DscV3
      valueName: Example
      valueData:
        DWord: 1
      _exist:    true
`;
