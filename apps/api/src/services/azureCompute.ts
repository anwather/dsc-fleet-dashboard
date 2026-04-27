/**
 * Azure Compute service — wraps `@azure/arm-compute`'s
 * `virtualMachines.beginRunCommand` so the API can execute PowerShell on
 * managed Azure VMs without needing `pwsh` or the `az` CLI in the container.
 *
 * Auth: `DefaultAzureCredential` from `@azure/identity`.
 *   1. Env service principal: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 *   2. Azure CLI fallback (mounted ~/.azure for dev)
 *
 * Required Azure RBAC on each target VM:
 *   - `Microsoft.Compute/virtualMachines/runCommand/action`
 *   Built-in role: **Virtual Machine Contributor** (or a custom role
 *   containing only that single action for least privilege).
 */
import {
  DefaultAzureCredential,
  type TokenCredential,
} from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { logger } from '../lib/logger.js';
import { loadEnv } from '../lib/env.js';

export type AzureCredentialStatus = 'ok' | 'unconfigured' | 'error';

let credential: TokenCredential | null = null;
let credentialStatus: AzureCredentialStatus = 'unconfigured';
let credentialError: string | null = null;

function buildCredential(): TokenCredential {
  return new DefaultAzureCredential();
}

/**
 * Probe credentials at boot. Calls `getToken` for the ARM scope. On failure
 * sets status to 'error' but does NOT throw — the API still boots so the UI
 * can show a clear banner.
 */
export async function initAzureCredential(): Promise<AzureCredentialStatus> {
  const env = loadEnv();
  const hasEnvSp =
    !!env.AZURE_TENANT_ID && !!env.AZURE_CLIENT_ID && !!env.AZURE_CLIENT_SECRET;

  try {
    credential = buildCredential();
    const token = await credential.getToken('https://management.azure.com/.default');
    if (!token) {
      credentialStatus = hasEnvSp ? 'error' : 'unconfigured';
      credentialError = 'getToken returned null';
      logger.warn({ hasEnvSp }, 'Azure credential probe returned null token');
    } else {
      credentialStatus = 'ok';
      credentialError = null;
      logger.info('Azure credential probe succeeded');
    }
  } catch (err) {
    credential = null;
    credentialStatus = hasEnvSp ? 'error' : 'unconfigured';
    credentialError = (err as Error).message;
    logger.warn(
      { err: credentialError, hasEnvSp },
      hasEnvSp
        ? 'Azure credential probe FAILED — provisioning will not work'
        : 'No Azure credentials configured — provisioning disabled',
    );
  }
  return credentialStatus;
}

export function getAzureCredentialStatus(): {
  status: AzureCredentialStatus;
  error: string | null;
} {
  return { status: credentialStatus, error: credentialError };
}

function requireCredential(): TokenCredential {
  if (!credential || credentialStatus !== 'ok') {
    throw new Error(
      `Azure credentials not available (status=${credentialStatus}${
        credentialError ? `, error=${credentialError}` : ''
      }). Set AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET in .env.`,
    );
  }
  return credential;
}

const clientCache = new Map<string, ComputeManagementClient>();
function getClient(subscriptionId: string): ComputeManagementClient {
  const cred = requireCredential();
  let client = clientCache.get(subscriptionId);
  if (!client) {
    client = new ComputeManagementClient(cred, subscriptionId);
    clientCache.set(subscriptionId, client);
  }
  return client;
}

export interface RunCommandResult {
  /** Combined stdout from all output substatuses. */
  stdout: string;
  /** Combined stderr from all error substatuses. */
  stderr: string;
  /** Exit code if surfaced by the platform; otherwise undefined. */
  exitCode?: number;
  /** Final provisioning state of the run command (e.g. Succeeded/Failed). */
  provisioningState?: string;
}

/**
 * Run a PowerShell script on an Azure VM via Run-Command. Long-running op:
 * polls until completion or timeout.
 *
 * @param subscriptionId  Target VM subscription
 * @param resourceGroup   Target VM resource group
 * @param vmName          Target VM name
 * @param script          PowerShell script body (will run as Administrator)
 * @param timeoutMinutes  Total wall-clock cap (default from env)
 */
export async function runPowerShellScript(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  script: string,
  timeoutMinutes?: number,
): Promise<RunCommandResult> {
  const env = loadEnv();
  const effectiveTimeout = timeoutMinutes ?? env.AZURE_RUNCOMMAND_TIMEOUT_MINUTES;
  const client = getClient(subscriptionId);

  logger.info(
    { subscriptionId, resourceGroup, vmName, timeoutMinutes: effectiveTimeout },
    'submitting Run-Command',
  );

  const poller = await client.virtualMachines.beginRunCommand(
    resourceGroup,
    vmName,
    {
      commandId: 'RunPowerShellScript',
      script: [script],
    },
  );

  // Race the LRO against the timeout.
  const timeoutMs = effectiveTimeout * 60_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Run-Command timed out after ${effectiveTimeout} minutes (${vmName})`,
          ),
        ),
      timeoutMs,
    ),
  );

  const result = (await Promise.race([
    poller.pollUntilDone(),
    timeoutPromise,
  ])) as Awaited<ReturnType<typeof poller.pollUntilDone>>;

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let exitCode: number | undefined;

  for (const status of result.value ?? []) {
    const code = status.code ?? '';
    const message = status.message ?? '';
    if (code.startsWith('ComponentStatus/StdOut')) stdoutParts.push(message);
    else if (code.startsWith('ComponentStatus/StdErr')) stderrParts.push(message);
    else if (code.startsWith('ComponentStatus/ExitCode')) {
      const parsed = Number.parseInt(message.trim(), 10);
      if (!Number.isNaN(parsed)) exitCode = parsed;
    }
  }

  return {
    stdout: stdoutParts.join('\n'),
    stderr: stderrParts.join('\n'),
    exitCode,
    provisioningState: undefined,
  };
}
