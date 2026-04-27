/**
 * YAML parser & DSC v3 schema validator.
 *
 * Responsibilities:
 *  1. Validate YAML body against the DSC v3 bundled config document schema.
 *  2. Extract `resources[].type` and map namespace prefixes to PowerShell
 *     module names. Adapter resources (`Microsoft.Windows/WindowsPowerShell`)
 *     have nested resources whose own types are recursively mapped.
 *  3. Compute two hashes:
 *       - sourceSha256:   SHA-256 of the exact YAML bytes (UTF-8).
 *       - semanticSha256: SHA-256 of the canonical JSON form of the parsed
 *                         document (sorted object keys). Suppresses no-op
 *                         edits (whitespace / comment changes).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { logger } from '../lib/logger.js';
import { loadEnv } from '../lib/env.js';
import type {
  RequiredModule,
  ParsedResource,
  YamlParseResult,
} from '@dsc-fleet/shared-types';

// ESM/CJS interop: ajv (and ajv-formats) ship CommonJS that exposes the
// constructor / function on `.default`. Using createRequire avoids brittle
// namespace-import gymnastics under NodeNext.
const require = createRequire(import.meta.url);
const ajv2020Module = require('ajv/dist/2020.js');
const Ajv2020: new (opts?: object) => {
  compileAsync: (schema: unknown) => Promise<ValidateFunction>;
} = ajv2020Module.default ?? ajv2020Module.Ajv2020 ?? ajv2020Module;
const addFormatsModule = require('ajv-formats');
const addFormats: (ajv: unknown) => void =
  addFormatsModule.default ?? addFormatsModule;

// ---------------------------------------------------------------------------
// Namespace → module mapping
// ---------------------------------------------------------------------------
//
// Keys are matched as the *namespace prefix* (everything before the final '/').
// `null` means built-in / ships with the OS or with `dsc` itself — no module
// install needed.
//
// Extend by adding entries to NAMESPACE_MODULE_MAP.
// ---------------------------------------------------------------------------
const NAMESPACE_MODULE_MAP: Record<string, string | null> = {
  'Microsoft.DSC': null,
  'Microsoft.Windows': null, // Registry, WindowsPowerShell adapter — built-in
  'PSDesiredStateConfiguration': null, // ships with Windows
  'Microsoft.WinGet.DSC': 'Microsoft.WinGet.DSC',
  'PSDscResources': 'PSDscResources',
  'DscV3.RegFile': 'DscV3.RegFile',
};

// Resource types that act as PowerShell adapters whose nested resources need
// their own module mapping.
const ADAPTER_TYPES: Set<string> = new Set([
  'Microsoft.Windows/WindowsPowerShell',
  'Microsoft.DSC/PowerShell',
]);

// ---------------------------------------------------------------------------
// Schema cache (lazy)
// ---------------------------------------------------------------------------
let cachedValidator: ValidateFunction | null = null;
let cacheLoadPromise: Promise<ValidateFunction> | null = null;

async function loadValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;
  if (cacheLoadPromise) return cacheLoadPromise;

  const url = loadEnv().DSC_CONFIG_SCHEMA_URL;

  cacheLoadPromise = (async () => {
    try {
      logger.info({ url }, 'fetching DSC v3 config document schema');
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} fetching schema`);
      }
      const schema = (await res.json()) as Record<string, unknown>;
      const ajv = new Ajv2020({
        strict: false,
        allErrors: true,
        validateFormats: true,
        loadSchema: async (uri: string) => {
          const r = await fetch(uri, { redirect: 'follow' });
          if (!r.ok) throw new Error(`HTTP ${r.status} loading $ref ${uri}`);
          return r.json() as Promise<Record<string, unknown>>;
        },
      });
      addFormats(ajv);
      const validator = await ajv.compileAsync(schema);
      cachedValidator = validator;
      logger.info('DSC v3 config schema compiled and cached');
      return validator;
    } catch (err) {
      cacheLoadPromise = null; // allow retry on next call
      logger.error({ err }, 'failed to load DSC v3 config schema');
      throw err;
    }
  })();

  return cacheLoadPromise;
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable JSON: keys sorted alphabetically at every object level. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const stringify = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stringify).join(',')}]`;
    if (typeof v === 'object') {
      if (seen.has(v as object)) throw new Error('cycle detected during canonicalisation');
      seen.add(v as object);
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`);
      return `{${parts.join(',')}}`;
    }
    return 'null';
  };
  return stringify(value);
}

// ---------------------------------------------------------------------------
// Module extraction
// ---------------------------------------------------------------------------
/** Returns module name for a resource type, or null if built-in. */
function moduleForType(resourceType: string): string | null {
  const slashIdx = resourceType.indexOf('/');
  if (slashIdx <= 0) return null;
  const namespace = resourceType.slice(0, slashIdx);
  // Walk up the namespace path: Foo.Bar.Baz → Foo.Bar → Foo
  let probe = namespace;
  while (probe.length > 0) {
    if (probe in NAMESPACE_MODULE_MAP) {
      return NAMESPACE_MODULE_MAP[probe] ?? null;
    }
    const dot = probe.lastIndexOf('.');
    if (dot < 0) break;
    probe = probe.slice(0, dot);
  }
  // Unknown namespace — assume the namespace itself is the module name (best-effort).
  return namespace;
}

interface RawResource {
  type?: unknown;
  name?: unknown;
  properties?: unknown;
  resources?: unknown;
}

function* walkResources(
  resources: unknown,
  warnings: string[],
): Generator<RawResource> {
  if (!Array.isArray(resources)) return;
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const res = r as RawResource;
    yield res;
    if (typeof res.type === 'string' && ADAPTER_TYPES.has(res.type)) {
      // Nested resources can live under `properties.resources` (PowerShell adapter)
      // or under `resources` directly.
      const props = (res.properties ?? {}) as Record<string, unknown>;
      const nested = props['resources'] ?? res.resources;
      if (nested !== undefined && !Array.isArray(nested)) {
        warnings.push(
          `adapter resource ${res.type} has non-array nested resources; skipping recursion`,
        );
        continue;
      }
      yield* walkResources(nested, warnings);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface ParseOptions {
  /** Skip JSON-schema validation (for quick parse / preview). Default false. */
  skipSchemaValidation?: boolean;
}

export async function parseConfigYaml(
  yamlBody: string,
  opts: ParseOptions = {},
): Promise<YamlParseResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sourceSha256 = sha256Hex(Buffer.from(yamlBody, 'utf8'));

  let doc: unknown;
  try {
    doc = parseYaml(yamlBody);
  } catch (err) {
    errors.push(`YAML parse error: ${(err as Error).message}`);
    return {
      requiredModules: [],
      parsedResources: [],
      errors,
      warnings,
      sourceSha256,
      semanticSha256: sha256Hex(''),
    };
  }

  if (!doc || typeof doc !== 'object') {
    errors.push('Document is empty or not an object.');
    return {
      requiredModules: [],
      parsedResources: [],
      errors,
      warnings,
      sourceSha256,
      semanticSha256: sha256Hex(canonicalJson(doc ?? null)),
    };
  }

  const semanticSha256 = sha256Hex(canonicalJson(doc));

  if (!opts.skipSchemaValidation) {
    try {
      const validator = await loadValidator();
      const valid = validator(doc);
      if (!valid && validator.errors) {
        for (const e of validator.errors) {
          errors.push(
            `schema: ${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
          );
        }
      }
    } catch (err) {
      // Don't hard-fail parse on transient schema-fetch issues — degrade to
      // a warning so the user can still see required modules / resources.
      warnings.push(
        `schema validation skipped: ${(err as Error).message}`,
      );
    }
  }

  const docObj = doc as { resources?: unknown };
  const parsedResources: ParsedResource[] = [];
  const moduleSet = new Map<string, RequiredModule>();

  for (const r of walkResources(docObj.resources, warnings)) {
    if (typeof r.type !== 'string') continue;
    parsedResources.push({
      type: r.type,
      name: typeof r.name === 'string' ? r.name : undefined,
    });
    if (ADAPTER_TYPES.has(r.type)) continue; // adapter itself is built-in
    const moduleName = moduleForType(r.type);
    if (moduleName && !moduleSet.has(moduleName)) {
      moduleSet.set(moduleName, { name: moduleName });
    }
  }

  return {
    requiredModules: [...moduleSet.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    parsedResources,
    errors,
    warnings,
    sourceSha256,
    semanticSha256,
  };
}

// Exported for testing / extension
export const _internal = {
  NAMESPACE_MODULE_MAP,
  ADAPTER_TYPES,
  moduleForType,
};
