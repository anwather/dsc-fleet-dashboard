/**
 * Job runners for asynchronous server-side work.
 *
 * Two job types are owned here:
 *   - provision       — installs prereqs, dsc, and registers the agent on a fresh VM.
 *   - module-install  — installs missing PSGallery modules so prereq_status can flip to ready.
 *
 * Both runners:
 *   - Are safe to retry (job.attempts++ each time).
 *   - Stream stdout/stderr line-by-line into job.log via appendJobLog().
 *   - Broadcast WS topic `job:<id>` on each line and on terminal status.
 *   - NEVER throw out of the runner — any error becomes a `failed` job + audit_event.
 *
 * The api process invokes runJob() directly when a job is created (fire-and-forget);
 * the scheduler also calls reapStuckJobs() periodically.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { loadEnv } from '../lib/env.js';
import { runPowerShellScript, getAzureCredentialStatus } from './azureCompute.js';

let appRef: FastifyInstance | null = null;

/** Wired from server.ts so jobs can broadcast WS frames. */
export function bindJobsApp(app: FastifyInstance<any, any, any, any, any>): void {
  appRef = app as unknown as FastifyInstance;
}

function broadcast(topic: string, type: string, payload: unknown): void {
  if (!appRef) return;
  try {
    appRef.broadcast(topic, type, payload);
  } catch (err) {
    logger.warn({ err, topic }, 'job ws broadcast failed');
  }
}

async function appendJobLog(jobId: string, line: string): Promise<void> {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  // Postgres `||` handles null as null — coalesce to '' for the very first line.
  await prisma.$executeRaw`
    UPDATE "jobs"
    SET "log" = COALESCE("log", '') || ${stamped}
    WHERE "id" = ${jobId}::uuid
  `;
  broadcast(`job:${jobId}`, 'log', { line: stamped.trimEnd() });
}

interface JobPayloadProvision {
  token: string;
  expiresAt: string;
  dashboardUrl: string;
  agentBridgeBaseUrl: string;
  /**
   * Optional one-time URL the bootstrap script fetches to obtain run-as
   * credentials. When undefined, the agent registers as SYSTEM (default).
   * The URL itself is opaque; the bootstrap script supplies the provision
   * token as Bearer auth when calling it.
   */
  credentialUrl?: string;
}

interface ModuleSpec {
  name: string;
  minVersion?: string;
}

interface JobPayloadModuleInstall {
  modules: ModuleSpec[];
}

// ---------------------------------------------------------------------------
// Public job creation helpers (called from UI routes)
// ---------------------------------------------------------------------------

export async function createProvisionJob(
  serverId: string,
  payload: JobPayloadProvision,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      serverId,
      type: 'provision',
      status: 'queued',
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
  // Fire and forget; the runner manages its own state.
  void runJob(job.id);
  return job.id;
}

export async function createModuleInstallJob(
  serverId: string,
  payload: JobPayloadModuleInstall,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      serverId,
      type: 'module_install',
      status: 'queued',
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
  void runJob(job.id);
  return job.id;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status !== 'queued' && job.status !== 'failed') {
    // Already running / done — caller can re-run a failed job by changing status to queued.
    logger.debug({ jobId, status: job.status }, 'runJob: skip non-queued job');
    return;
  }
  switch (job.type) {
    case 'provision':
      return runProvisionJob(jobId);
    case 'module_install':
      return runModuleInstallJob(jobId);
    default:
      logger.debug({ jobId, type: job.type }, 'runJob: unsupported type');
  }
}

// ---------------------------------------------------------------------------
// Provision job
// ---------------------------------------------------------------------------

const PREREQ_BOOTSTRAP_URL =
  'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Install-Prerequisites.ps1';
const INSTALL_DSC_URL =
  'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Install-DscV3.ps1';
const REGISTER_AGENT_URL =
  'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/Register-DashboardAgent.ps1';
// Shared logging module imported by every bootstrap script. MUST land on
// disk before any of the script invocations run, otherwise their
// `Import-Module DscFleet.Logging.psm1` falls back to host-only logging
// and we lose the unified agent.log we're trying to build.
const LOGGING_MODULE_URL =
  'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/DscFleet.Logging.psm1';

function buildProvisionScript(payload: JobPayloadProvision): string {
  // Single PowerShell script run on the VM via Azure Run-Command. We download
  // each bootstrap fragment and dot-source it. URLs are pinned to main of
  // dsc-fleet — production users should fork and override via env.
  const dashboardUrl = payload.dashboardUrl.replace(/'/g, "''");
  const token = payload.token.replace(/'/g, "''");
  const credentialUrl = payload.credentialUrl
    ? payload.credentialUrl.replace(/'/g, "''")
    : '';
  const credArg = credentialUrl ? ` -CredentialUrl '${credentialUrl}'` : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version 3.0',
    '$ProgressPreference = "SilentlyContinue"',
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    "$bootstrapDir = 'C:\\ProgramData\\DscV3\\bootstrap'",
    'if (-not (Test-Path -LiteralPath $bootstrapDir)) { New-Item -ItemType Directory -Path $bootstrapDir -Force | Out-Null }',
    `iwr -UseBasicParsing -Uri '${LOGGING_MODULE_URL}'    -OutFile (Join-Path $bootstrapDir 'DscFleet.Logging.psm1')`,
    `iwr -UseBasicParsing -Uri '${PREREQ_BOOTSTRAP_URL}' -OutFile (Join-Path $bootstrapDir 'Install-Prerequisites.ps1')`,
    `iwr -UseBasicParsing -Uri '${INSTALL_DSC_URL}'        -OutFile (Join-Path $bootstrapDir 'Install-DscV3.ps1')`,
    `iwr -UseBasicParsing -Uri '${REGISTER_AGENT_URL}'     -OutFile (Join-Path $bootstrapDir 'Register-DashboardAgent.ps1')`,
    'Write-Host "==> running Install-Prerequisites"',
    '& (Join-Path $bootstrapDir "Install-Prerequisites.ps1")',
    'if ($LASTEXITCODE -ne 0) { throw "Install-Prerequisites failed (exit $LASTEXITCODE)" }',
    'Write-Host "==> running Install-DscV3"',
    '& (Join-Path $bootstrapDir "Install-DscV3.ps1")',
    'if ($LASTEXITCODE -ne 0) { throw "Install-DscV3 failed (exit $LASTEXITCODE)" }',
    'Write-Host "==> running Register-DashboardAgent"',
    `& (Join-Path $bootstrapDir 'Register-DashboardAgent.ps1') -DashboardUrl '${dashboardUrl}' -ProvisionToken '${token}'${credArg} -Force`,
    'if ($LASTEXITCODE -ne 0) { throw "Register-DashboardAgent failed (exit $LASTEXITCODE)" }',
    'Write-Host "==> provision complete"',
  ].join('\n');
}

async function runProvisionJob(jobId: string): Promise<void> {
  const job = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'running',
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
    include: { server: true },
  });
  broadcast(`job:${jobId}`, 'status', { status: 'running' });
  if (!job.server) {
    await failJob(jobId, 'NoServer', 'job has no associated server');
    return;
  }

  const azure = getAzureCredentialStatus();
  if (azure.status !== 'ok') {
    await failJob(jobId, 'AzureUnavailable', `Azure credentials not ready: ${azure.status}${azure.error ? ' — ' + azure.error : ''}`);
    return;
  }

  const payload = job.payload as unknown as JobPayloadProvision;
  if (!payload?.token || !payload?.dashboardUrl) {
    await failJob(jobId, 'BadPayload', 'provision job payload missing token/dashboardUrl');
    return;
  }

  await appendJobLog(jobId, `provision: ${job.server.azureVmName} (rg=${job.server.azureResourceGroup})`);
  await prisma.server.update({ where: { id: job.server.id }, data: { status: 'provisioning' } });
  broadcast(`server:${job.server.id}`, 'status', { status: 'provisioning' });

  try {
    const script = buildProvisionScript(payload);
    const result = await runPowerShellScript(
      job.server.azureSubscriptionId,
      job.server.azureResourceGroup,
      job.server.azureVmName,
      script,
    );
    // Stream stdout/stderr line-by-line into the log.
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.length > 0) await appendJobLog(jobId, `[stdout] ${line}`);
    }
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.length > 0) await appendJobLog(jobId, `[stderr] ${line}`);
    }
    if ((result.exitCode ?? 0) !== 0) {
      await failJob(jobId, 'NonZeroExit', `Run-Command exit ${result.exitCode}`);
      return;
    }
    // Azure Run-Command's RunPowerShellScript invoker rarely surfaces an exit
    // code, so a thrown PowerShell error still presents as exitCode=undefined.
    // The bootstrap script ends with "==> provision complete"; if that line
    // is missing the script aborted somewhere in the middle.
    if (!/==> provision complete/.test(result.stdout)) {
      await failJob(
        jobId,
        'BootstrapAborted',
        'bootstrap did not reach completion sentinel — see stderr in log',
      );
      return;
    }
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'success', finishedAt: new Date() },
    });
    broadcast(`job:${jobId}`, 'status', { status: 'success' });
    await prisma.auditEvent.create({
      data: {
        eventType: 'job.provision.success',
        entityType: 'server',
        entityId: job.server.id,
        actorType: 'system',
        payload: { jobId },
      },
    });
  } catch (err) {
    await failJob(jobId, 'RunCommandError', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Module-install job
// ---------------------------------------------------------------------------

function buildModuleInstallScript(modules: ModuleSpec[]): string {
  const lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version 3.0',
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    "if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.PSResourceGet)) { Install-Module Microsoft.PowerShell.PSResourceGet -Scope AllUsers -Force -AllowClobber }",
    "Import-Module Microsoft.PowerShell.PSResourceGet -Force",
    "if (-not (Get-PSResourceRepository -Name PSGallery -ErrorAction SilentlyContinue)) { Register-PSResourceRepository -PSGallery -Trusted } else { Set-PSResourceRepository -Name PSGallery -Trusted -ErrorAction SilentlyContinue }",
  ];
  for (const m of modules) {
    const name = m.name.replace(/'/g, "''");
    const ver = m.minVersion ? ` -Version '${m.minVersion.replace(/'/g, "''")}'` : '';
    lines.push(`Write-Host "==> Install-PSResource ${name}${m.minVersion ? ' v' + m.minVersion : ''}"`);
    lines.push(`Install-PSResource -Name '${name}'${ver} -Scope AllUsers -TrustRepository -AcceptLicense -Reinstall:$false -ErrorAction Stop`);
  }
  return lines.join('\n');
}

async function runModuleInstallJob(jobId: string): Promise<void> {
  const job = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'running',
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
    include: { server: true },
  });
  broadcast(`job:${jobId}`, 'status', { status: 'running' });
  if (!job.server) {
    await failJob(jobId, 'NoServer', 'job has no associated server');
    return;
  }

  const azure = getAzureCredentialStatus();
  if (azure.status !== 'ok') {
    await failJob(jobId, 'AzureUnavailable', `Azure credentials not ready: ${azure.status}`);
    return;
  }

  const payload = job.payload as unknown as JobPayloadModuleInstall;
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  if (modules.length === 0) {
    await failJob(jobId, 'BadPayload', 'no modules in payload');
    return;
  }

  await appendJobLog(jobId, `installing modules: ${modules.map((m) => m.name).join(', ')}`);
  try {
    const script = buildModuleInstallScript(modules);
    const result = await runPowerShellScript(
      job.server.azureSubscriptionId,
      job.server.azureResourceGroup,
      job.server.azureVmName,
      script,
    );
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.length > 0) await appendJobLog(jobId, `[stdout] ${line}`);
    }
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.length > 0) await appendJobLog(jobId, `[stderr] ${line}`);
    }
    if ((result.exitCode ?? 0) !== 0) {
      await failJob(jobId, 'NonZeroExit', `Run-Command exit ${result.exitCode}`);
      return;
    }
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'success', finishedAt: new Date() },
    });
    broadcast(`job:${jobId}`, 'status', { status: 'success' });
    await prisma.auditEvent.create({
      data: {
        eventType: 'job.module-install.success',
        entityType: 'server',
        entityId: job.server.id,
        actorType: 'system',
        payload: { jobId, modules } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    await failJob(jobId, 'RunCommandError', (err as Error).message);
  }
}

async function failJob(jobId: string, code: string, message: string): Promise<void> {
  await appendJobLog(jobId, `[error] ${code}: ${message}`);
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'failed', finishedAt: new Date(), errorCode: code },
  });
  broadcast(`job:${jobId}`, 'status', { status: 'failed', errorCode: code, message });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job?.serverId) {
    await prisma.auditEvent.create({
      data: {
        eventType: `job.${job.type}.failed`,
        entityType: 'server',
        entityId: job.serverId,
        actorType: 'system',
        payload: { jobId, code, message },
      },
    });
  }
}

// Re-pick queued jobs that nothing fired (e.g. crash mid-create). Called by scheduler.
export async function reapStuckJobs(): Promise<void> {
  const env = loadEnv();
  const stuckBefore = new Date(Date.now() - 5 * 60_000); // 5 min
  const queued = await prisma.job.findMany({
    where: { status: 'queued', requestedAt: { lt: stuckBefore } },
    select: { id: true },
    take: 20,
  });
  for (const q of queued) void runJob(q.id);
  // Also fail provision jobs whose token has expired and never registered.
  const expired = await prisma.job.findMany({
    where: { status: 'queued', type: 'provision' },
    select: { id: true, payload: true },
    take: 50,
  });
  const now = Date.now();
  for (const j of expired) {
    const p = j.payload as unknown as JobPayloadProvision;
    if (p?.expiresAt && new Date(p.expiresAt).getTime() < now - env.AZURE_RUNCOMMAND_TIMEOUT_MINUTES * 60_000) {
      await failJob(j.id, 'TokenExpired', 'provision token expired');
    }
  }
}
