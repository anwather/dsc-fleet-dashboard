/**
 * Hand-curated catalog of common DSC v3 resource types and their properties.
 *
 * The bundled DSC v3 document schema only describes the outer shape of a
 * configuration document (resources[].name/type/properties). It does NOT
 * describe the property bag accepted by individual resources, because each
 * resource ships its own schema in its manifest. To give authors useful
 * IntelliSense without dynamically discovering manifests at edit time, we
 * maintain this small catalog covering the resources our team actually
 * uses for fleet management (registry, scripts, packages, modules).
 *
 * Add new resources here as you start using them. Each entry should match
 * the official manifest's input schema as closely as possible.
 */

export interface DscPropertyDoc {
  name: string;
  /** Short human description shown in the completion details panel. */
  description?: string;
  /** Hint for what value kind to insert. */
  kind: 'string' | 'boolean' | 'integer' | 'enum' | 'object' | 'array';
  /** For `kind: 'enum'`, the allowed values. First entry is treated as default. */
  enumValues?: string[];
  /** Default literal to insert in the snippet. */
  defaultValue?: string;
  /** Whether the property must always be set. */
  required?: boolean;
}

export interface DscResourceDoc {
  description?: string;
  properties: DscPropertyDoc[];
}

export const DSC_RESOURCE_CATALOG: Record<string, DscResourceDoc> = {
  'Microsoft.WinGet.DSC/WinGetPackage': {
    description: 'Install, update, or remove a package via WinGet. Runs in the invoking user context — when invoked by SYSTEM it only sees machine-scope packages.',
    properties: [
      { name: 'Id', kind: 'string', required: true, description: 'Winget package identifier (e.g. anwather.ncw).' },
      { name: 'Source', kind: 'string', defaultValue: 'winget', description: 'Winget source name. Use "winget" for the public catalog.' },
      { name: 'Ensure', kind: 'enum', enumValues: ['Present', 'Absent'], defaultValue: 'Present', description: 'Whether the package should be installed or removed.' },
      { name: 'Version', kind: 'string', description: 'Specific package version. Omit to allow any version.' },
      { name: 'UseLatest', kind: 'boolean', defaultValue: 'false', description: 'When true, upgrade to the latest available version on every run.' },
      { name: 'MatchOption', kind: 'enum', enumValues: ['Equals', 'EqualsCaseInsensitive', 'StartsWith', 'Contains'], defaultValue: 'Equals', description: 'How the package Id is matched against installed packages.' },
    ],
  },

  'Microsoft.Windows.Registry/Registry': {
    description: 'Manage a single registry value or key.',
    properties: [
      { name: 'keyPath', kind: 'string', required: true, description: 'Full registry key path (e.g. HKLM\\Software\\Contoso\\Agent).' },
      { name: 'valueName', kind: 'string', description: 'Name of the value under keyPath. Omit to manage the key itself.' },
      { name: 'valueData', kind: 'object', description: 'Object with one of: String, ExpandString, MultiString, Binary, DWord, QWord. e.g. { DWord: 1 }.' },
      { name: '_exist', kind: 'boolean', defaultValue: 'true', description: 'Set to false to ensure the key/value is removed.' },
    ],
  },

  'Microsoft.DSC/Script': {
    description: 'Run an inline script (PowerShell by default) for Get/Test/Set.',
    properties: [
      { name: 'GetScript', kind: 'string', required: true, description: 'Script returning the current state as a hashtable.' },
      { name: 'TestScript', kind: 'string', required: true, description: 'Script returning $true if in desired state.' },
      { name: 'SetScript', kind: 'string', required: true, description: 'Script that brings the resource into desired state.' },
    ],
  },

  'Microsoft.DSC.Transitional/RunCommandOnSet': {
    description: 'Run a command only during Set; useful for one-shot remediation.',
    properties: [
      { name: 'executable', kind: 'string', required: true, description: 'Path or name of the executable to invoke.' },
      { name: 'arguments', kind: 'array', description: 'Array of string arguments passed to the executable.' },
      { name: 'workingDirectory', kind: 'string', description: 'Optional working directory for the command.' },
    ],
  },

  'Microsoft.PowerShell.PSResourceGet/PSResource': {
    description: 'Install or remove a PowerShell module/script from a PSResourceGet repository.',
    properties: [
      { name: 'name', kind: 'string', required: true, description: 'Module or script name (e.g. Microsoft.WinGet.DSC).' },
      { name: 'version', kind: 'string', description: 'Specific version or version range (e.g. "[1.0.0,2.0.0)").' },
      { name: 'repository', kind: 'string', defaultValue: 'PSGallery', description: 'Repository to install from.' },
      { name: 'scope', kind: 'enum', enumValues: ['AllUsers', 'CurrentUser'], defaultValue: 'AllUsers', description: 'Install scope.' },
      { name: 'prerelease', kind: 'boolean', defaultValue: 'false', description: 'Allow prerelease versions.' },
      { name: '_exist', kind: 'boolean', defaultValue: 'true', description: 'Set to false to uninstall.' },
    ],
  },

  'Microsoft.Windows.WindowsPowerShell/PSModule': {
    description: 'Install a module into Windows PowerShell 5.1 (legacy PSModule).',
    properties: [
      { name: 'Name', kind: 'string', required: true },
      { name: 'Version', kind: 'string' },
      { name: 'Ensure', kind: 'enum', enumValues: ['Present', 'Absent'], defaultValue: 'Present' },
      { name: 'Repository', kind: 'string', defaultValue: 'PSGallery' },
      { name: 'Scope', kind: 'enum', enumValues: ['AllUsers', 'CurrentUser'], defaultValue: 'AllUsers' },
    ],
  },

  'PSDesiredStateConfiguration/Service': {
    description: 'Manage a Windows service.',
    properties: [
      { name: 'Name', kind: 'string', required: true, description: 'Service short name.' },
      { name: 'State', kind: 'enum', enumValues: ['Running', 'Stopped'], defaultValue: 'Running' },
      { name: 'StartupType', kind: 'enum', enumValues: ['Automatic', 'Manual', 'Disabled'], defaultValue: 'Automatic' },
      { name: 'Ensure', kind: 'enum', enumValues: ['Present', 'Absent'], defaultValue: 'Present' },
    ],
  },

  'PSDesiredStateConfiguration/File': {
    description: 'Manage a file or directory.',
    properties: [
      { name: 'DestinationPath', kind: 'string', required: true },
      { name: 'SourcePath', kind: 'string' },
      { name: 'Type', kind: 'enum', enumValues: ['File', 'Directory'], defaultValue: 'File' },
      { name: 'Contents', kind: 'string' },
      { name: 'Ensure', kind: 'enum', enumValues: ['Present', 'Absent'], defaultValue: 'Present' },
    ],
  },

  'Microsoft.DSC/Group': {
    description: 'Compose multiple sub-resources into a logical group.',
    properties: [
      { name: 'resources', kind: 'array', required: true, description: 'Array of nested resource entries.' },
    ],
  },
};

export function listResourceTypes(): string[] {
  return Object.keys(DSC_RESOURCE_CATALOG).sort();
}
