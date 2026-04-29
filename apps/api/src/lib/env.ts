/**
 * Centralised env loader. Validates with zod at boot — any missing/invalid
 * required var fails fast with a clear message.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  AZURE_TENANT_ID: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  AZURE_CLIENT_ID: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  AZURE_CLIENT_SECRET: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),

  // Entra (Azure AD) auth for the dashboard. Both required to gate dashboard
  // routes. When unset, the API will refuse to start so we never accidentally
  // ship an unauthenticated dashboard.
  ENTRA_TENANT_ID: z.string().min(1, 'ENTRA_TENANT_ID is required (Entra tenant GUID)'),
  ENTRA_API_CLIENT_ID: z.string().min(1, 'ENTRA_API_CLIENT_ID is required (the Entra app registration client/app ID)'),
  ENTRA_REQUIRED_SCOPE: z.string().min(1).default('access_as_user'),

  AGENT_POLL_DEFAULT_SECONDS: z.coerce.number().int().positive().default(60),
  OFFLINE_MULTIPLIER: z.coerce.number().int().positive().default(3),
  DEFAULT_ASSIGNMENT_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  AZURE_RUNCOMMAND_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  REMOVAL_ACK_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),

  // Public, agent-reachable base URL of the dashboard (e.g. https://dsc.example.com).
  // When unset, provisioning falls back to req.protocol + req.headers.host, which on
  // a local kubectl port-forward resolves to https://127.0.0.1 — useless to a remote
  // VM. Set this in production / when fronted by cloudflared/ingress.
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v && v.length > 0 ? v.replace(/\/$/, '') : undefined)),

  DSC_CONFIG_SCHEMA_URL: z
    .string()
    .url()
    .default('https://aka.ms/dsc/schemas/v3/bundled/config/document.json'),

  // 32-byte AES-256-GCM master key, base64-encoded. Used to encrypt run-as
  // credentials at rest in `agent_credentials`. Generate with:
  //   openssl rand -base64 32
  // Optional: when unset, the API will refuse to issue credential URLs (the
  // run-as flow returns 503). SYSTEM and gMSA flows still work without it.
  RUNAS_MASTER_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .refine(
      (v) => {
        if (v === undefined) return true;
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'RUNAS_MASTER_KEY must be a base64-encoded 32-byte value (try `openssl rand -base64 32`)' },
    ),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
