import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowLeft, ShieldCheck, RotateCw, Trash2, Download } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ServerStatusPill,
  LifecyclePill,
  PrereqPill,
  LastStatusPill,
  JobStatusPill,
} from '@/components/StatusPill';
import { RelativeTime } from '@/components/RelativeTime';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError, softFetch } from '@/lib/api';
import { useWsTopic } from '@/hooks/useWebSocket';
import { useToast } from '@/components/ToastProvider';
import type {
  ServerSummary,
  AssignmentSummary,
  ConfigSummary,
  RunResultSummary,
  ServerModuleSummary,
  AuditEventSummary,
  JobSummary,
  RequiredModule,
} from '@dsc-fleet/shared-types';

export function ServerDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);

  const server = useQuery<ServerSummary | null>({
    queryKey: ['server', id],
    queryFn: () => softFetch(() => apiGet<ServerSummary>(`/servers/${id}`)),
    enabled: !!id,
  });

  // Live updates: server:<id> events trigger refetch of everything on this page.
  useWsTopic(`server:${id}`, () => {
    qc.invalidateQueries({ queryKey: ['server', id] });
    qc.invalidateQueries({ queryKey: ['assignments', { serverId: id }] });
    qc.invalidateQueries({ queryKey: ['runResults', { serverId: id }] });
    qc.invalidateQueries({ queryKey: ['serverModules', id] });
    qc.invalidateQueries({ queryKey: ['auditEvents', { serverId: id }] });
    qc.invalidateQueries({ queryKey: ['jobs', { serverId: id }] });
  });

  const remove = useMutation({
    mutationFn: () => apiDelete(`/servers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast({
        title: 'Server removed',
        description: `${server.data?.name ?? id} hidden. Run history retained in DB.`,
        variant: 'success',
      });
      navigate('/servers');
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to remove server';
      toast({ title: 'Remove failed', description: msg, variant: 'destructive' });
    },
  });

  if (server.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  const s = server.data;
  if (!s) {
    return (
      <div className="space-y-4">
        <Link to="/servers" className="text-sm text-muted-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> back to servers
        </Link>
        <BackendIncomplete feature="Server detail" />
      </div>
    );
  }

  // All sub-tab queries that the page-level refresh button should invalidate.
  const refreshKeys: import('@tanstack/react-query').QueryKey[] = [
    ['server', id],
    ['assignments', { serverId: id }],
    ['runResults', { serverId: id }],
    ['serverModules', id],
    ['auditEvents', { serverId: id }],
    ['jobs', { serverId: id }],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/servers"
          className="text-sm text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> back to servers
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
          <ServerStatusPill status={s.status} />
          <div className="ml-auto flex items-center gap-2">
            <RefreshButton queryKeys={refreshKeys} />
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRemoveOpen(true)}
              title="Soft-delete this server"
            >
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          </div>
        </div>
        <div className="mt-1 text-xs text-muted-foreground font-mono">
          {s.azureSubscriptionId} / {s.azureResourceGroup} / {s.azureVmName}
        </div>
        {s.hostname && (
          <div className="mt-1 text-xs text-muted-foreground">
            hostname: <span className="font-mono">{s.hostname}</span>
            {s.osCaption && <span className="ml-3">{s.osCaption}</span>}
            {s.osVersion && <span className="ml-2">{s.osVersion}</span>}
          </div>
        )}
        <div className="mt-1 text-xs text-muted-foreground">
          last heartbeat: <RelativeTime iso={s.lastHeartbeatAt} />
        </div>
      </div>

      <Tabs defaultValue="prereqs">
        <TabsList>
          <TabsTrigger value="prereqs">Prereqs</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="modules">Modules</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
        </TabsList>

        <TabsContent value="prereqs">
          <PrereqsTab serverId={id} serverName={s.name} />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentsTab serverId={id} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab serverId={id} />
        </TabsContent>
        <TabsContent value="modules">
          <ModulesTab serverId={id} />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab serverId={id} />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsTab serverId={id} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove server?"
        description={
          <span>
            <span className="font-medium">{s.name}</span> will be hidden from all lists.
            Assignments and run history are kept in the database (soft-delete) so audit data
            isn't lost. The actual Azure VM is not touched.
          </span>
        }
        confirmLabel="Remove server"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/**
 * Prereqs tab — at-a-glance view of provisioning health for a server.
 *
 * Aggregates:
 *   1. Latest provision-related jobs (provision, install-modules) so the user
 *      can see whether bootstrap actually ran and re-trigger it.
 *   2. Required-vs-installed module table computed from joined assignment data
 *      and the agent's last-reported module inventory.
 *
 * Two action buttons in the header:
 *   • Re-run provisioning — POSTs /provision-token (the canonical route)
 *   • Install missing modules — POSTs /install-modules with the computed list
 */
function PrereqsTab({ serverId, serverName }: { serverId: string; serverName: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const jobs = useQuery<JobSummary[] | null>({
    queryKey: ['jobs', { serverId }],
    queryFn: () => softFetch(() => apiGet<JobSummary[]>(`/jobs?serverId=${serverId}`)),
  });

  const assigns = useQuery<AssignmentSummary[] | null>({
    queryKey: ['assignments', { serverId }],
    queryFn: () =>
      softFetch(() => apiGet<AssignmentSummary[]>(`/assignments?serverId=${serverId}`)),
  });

  const modules = useQuery<ServerModuleSummary[] | null>({
    queryKey: ['serverModules', serverId],
    queryFn: () =>
      softFetch(() => apiGet<ServerModuleSummary[]>(`/servers/${serverId}/modules`)),
  });

  const reprovision = useMutation({
    mutationFn: () => apiPost<{ jobId: string }>(`/servers/${serverId}/provision-token`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['jobs', { serverId }] });
      toast({
        title: 'Provisioning queued',
        description: `${serverName}: job ${r.jobId.slice(0, 8)}.`,
        variant: 'success',
      });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to queue provisioning';
      toast({ title: 'Re-run failed', description: msg, variant: 'destructive' });
    },
  });

  const installMissing = useMutation({
    mutationFn: (mods: { name: string; minVersion?: string }[]) =>
      apiPost<{ jobId: string }>(`/servers/${serverId}/install-modules`, { modules: mods }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['jobs', { serverId }] });
      qc.invalidateQueries({ queryKey: ['serverModules', serverId] });
      toast({
        title: 'Module install queued',
        description: `Job ${r.jobId.slice(0, 8)}.`,
        variant: 'success',
      });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to queue module install';
      toast({ title: 'Install failed', description: msg, variant: 'destructive' });
    },
  });

  if (jobs.isLoading || assigns.isLoading || modules.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (jobs.data === null && assigns.data === null && modules.data === null) {
    return <BackendIncomplete feature="Prereqs" />;
  }

  // Required modules across all of this server's assignments.
  const requiredMap = new Map<string, { name: string; minVersion?: string; usedBy: number }>();
  for (const a of assigns.data ?? []) {
    const reqs = (a as unknown as { requiredModules?: RequiredModule[] }).requiredModules ?? [];
    for (const r of reqs) {
      const existing = requiredMap.get(r.name);
      if (existing) {
        existing.usedBy += 1;
        // Track the highest minVersion we've seen.
        if (r.minVersion && (!existing.minVersion || r.minVersion > existing.minVersion)) {
          existing.minVersion = r.minVersion;
        }
      } else {
        requiredMap.set(r.name, { name: r.name, minVersion: r.minVersion, usedBy: 1 });
      }
    }
  }

  const installedByName = new Map<string, ServerModuleSummary>();
  for (const m of modules.data ?? []) installedByName.set(m.name, m);

  const required = [...requiredMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const missing = required
    .filter((r) => !installedByName.has(r.name))
    .map((r) => ({ name: r.name, minVersion: r.minVersion }));

  const allJobs = jobs.data ?? [];
  const provisionJobs = allJobs.filter((j) => j.type === 'provision').slice(0, 3);
  const moduleJobs = allJobs.filter((j) => j.type === 'module-install').slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Action header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => reprovision.mutate()}
          disabled={reprovision.isPending}
        >
          <RotateCw className="h-4 w-4" />
          {reprovision.isPending ? 'Queuing…' : 'Re-run provisioning'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => installMissing.mutate(missing)}
          disabled={installMissing.isPending || missing.length === 0}
          title={
            missing.length === 0
              ? 'No missing modules — all required modules are already installed.'
              : `Install ${missing.length} missing module${missing.length === 1 ? '' : 's'}.`
          }
        >
          <Download className="h-4 w-4" />
          {installMissing.isPending
            ? 'Queuing…'
            : `Install missing modules${missing.length ? ` (${missing.length})` : ''}`}
        </Button>
        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          {required.length === 0
            ? 'No assignments yet — required-module list is empty.'
            : `${required.length - missing.length}/${required.length} required modules installed.`}
        </div>
      </div>

      {/* Required modules table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Required modules</CardTitle>
        </CardHeader>
        <CardContent>
          {required.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              No modules required. Assign a config to this server to populate this list.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Required min version</TableHead>
                  <TableHead>Installed version</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {required.map((r) => {
                  const installed = installedByName.get(r.name);
                  return (
                    <TableRow key={r.name}>
                      <TableCell className="font-mono">{r.name}</TableCell>
                      <TableCell>{r.minVersion ?? <span className="text-muted-foreground">any</span>}</TableCell>
                      <TableCell>
                        {installed?.installedVersion ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>{r.usedBy} assignment{r.usedBy === 1 ? '' : 's'}</TableCell>
                      <TableCell>
                        {installed ? (
                          <Badge variant="success">installed</Badge>
                        ) : (
                          <Badge variant="warning">missing</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent provision-related jobs */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent provisioning jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {provisionJobs.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
                No provisioning jobs yet — click <span className="font-medium">Re-run provisioning</span> above to queue one.
              </div>
            ) : (
              <div className="space-y-3">
                {provisionJobs.map((j) => (
                  <JobCard key={j.id} job={j} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent module-install jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {moduleJobs.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
                No module-install jobs yet.
              </div>
            ) : (
              <div className="space-y-3">
                {moduleJobs.map((j) => (
                  <JobCard key={j.id} job={j} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Compact card used inside Prereqs and Jobs tabs. */
function JobCard({ job }: { job: JobSummary }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{job.type}</span>
        <JobStatusPill status={job.status} />
        <span className="ml-auto text-xs text-muted-foreground">
          <RelativeTime iso={job.requestedAt} />
        </span>
      </div>
      {job.log && (
        <pre className="mt-2 text-xs font-mono bg-muted p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap">
          {job.log}
        </pre>
      )}
    </div>
  );
}

/**
 * Lifecycle states the user can act on. Terminal states (`removed`,
 * `removal_expired`) are filtered out — they're noise and confuse the
 * "X configs assigned" header on the Assignments page.
 */
const ACTIONABLE_LIFECYCLES = new Set(['active', 'removing']);

function AssignmentsTab({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [removeTarget, setRemoveTarget] = useState<AssignmentSummary | null>(null);
  const { data, isLoading, error } = useQuery<AssignmentSummary[] | null>({
    queryKey: ['assignments', { serverId }],
    queryFn: () => softFetch(() => apiGet<AssignmentSummary[]>(`/assignments?serverId=${serverId}`)),
  });
  // Configs are needed to resolve the latest revision id for the
  // "update to vN" action. The /assignments payload only carries the
  // latest version number, not the revision uuid required by PATCH.
  const configsQ = useQuery<ConfigSummary[] | null>({
    queryKey: ['configs'],
    queryFn: () => softFetch(() => apiGet<ConfigSummary[]>('/configs')),
  });
  const configCurrentRevision = (() => {
    const m = new Map<string, { id: string; version: number } | null>();
    for (const c of configsQ.data ?? []) {
      m.set(c.id, c.currentRevision ? { id: c.currentRevision.id, version: c.currentRevision.version } : null);
    }
    return m;
  })();
  const visible = (data ?? []).filter((a) => ACTIONABLE_LIFECYCLES.has(a.lifecycleState));

  const isForce = removeTarget?.lifecycleState === 'removing';
  const remove = useMutation({
    mutationFn: (a: AssignmentSummary) =>
      a.lifecycleState === 'removing'
        ? apiPost(`/assignments/${a.id}/force-remove`, {})
        : apiDelete(`/assignments/${a.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments', { serverId }] });
      qc.invalidateQueries({ queryKey: ['assignments'] });
      qc.invalidateQueries({ queryKey: ['configs'] });
      toast({
        title: isForce ? 'Assignment force-removed' : 'Removal requested',
        variant: 'success',
      });
      setRemoveTarget(null);
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError && e.body && typeof e.body === 'object' && 'message' in e.body
          ? String((e.body as { message?: unknown }).message ?? e.message)
          : e instanceof Error
          ? e.message
          : 'Failed to remove assignment';
      toast({ title: 'Remove failed', description: msg, variant: 'destructive' });
    },
  });
  const updateRevision = useMutation({
    mutationFn: ({ id, pinnedRevisionId }: { id: string; pinnedRevisionId: string }) =>
      apiPatch<AssignmentSummary>(`/assignments/${id}`, { pinnedRevisionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments', { serverId }] });
      qc.invalidateQueries({ queryKey: ['assignments'] });
      qc.invalidateQueries({ queryKey: ['configs'] });
      toast({ title: 'Revision updated', variant: 'success' });
    },
    onError: (e: unknown) =>
      toast({
        title: 'Update failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error && !(error instanceof ApiError && error.notImplemented))
    return <div className="text-sm text-destructive">{(error as Error).message}</div>;
  if (data === null) return <BackendIncomplete feature="Assignments" />;

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Config</TableHead>
            <TableHead>Revision</TableHead>
            <TableHead>Interval</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead>Prereqs</TableHead>
            <TableHead>Last status</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Next due</TableHead>
            <TableHead className="w-[80px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                No assignments. Use the <Link to="/assignments" className="underline">Assignments</Link> page to add one.
              </TableCell>
            </TableRow>
          )}
          {visible.map((a) => {
            const force = a.lifecycleState === 'removing';
            const cur = configCurrentRevision.get(a.configId);
            const updateAvailable =
              a.revisionVersion != null && cur && cur.version > a.revisionVersion;
            return (
              <TableRow key={a.id}>
                <TableCell>
                  <Link to={`/configs/${a.configId}`} className="font-medium hover:underline">
                    {a.configName ?? a.configId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {a.revisionVersion != null ? `v${a.revisionVersion}` : '—'}
                    </span>
                    {updateAvailable && cur && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 border-amber-500/40 bg-amber-500/10 px-2 text-[11px] text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                        disabled={updateRevision.isPending || a.lifecycleState !== 'active'}
                        title={
                          a.lifecycleState === 'active'
                            ? `Update assignment to v${cur.version} (latest)`
                            : 'Cannot update — assignment is not active'
                        }
                        onClick={() =>
                          updateRevision.mutate({ id: a.id, pinnedRevisionId: cur.id })
                        }
                      >
                        v{cur.version} available
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell>{a.intervalMinutes} min</TableCell>
                <TableCell>
                  <LifecyclePill state={a.lifecycleState} />
                </TableCell>
                <TableCell>
                  <PrereqPill status={a.prereqStatus} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <LastStatusPill status={a.lastStatus} />
                    {a.lastRunRevisionVersion != null && (
                      <span className="text-xs text-muted-foreground">v{a.lastRunRevisionVersion}</span>
                    )}
                    {a.revisionVersion != null &&
                      a.lastRunRevisionVersion != null &&
                      a.revisionVersion > a.lastRunRevisionVersion && (
                        <span
                          className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                          title={`Upgrade pinned to v${a.revisionVersion}; awaiting next run`}
                        >
                          pending v{a.revisionVersion}
                        </span>
                      )}
                  </div>
                </TableCell>
                <TableCell>
                  <RelativeTime iso={a.lastRunAt} />
                </TableCell>
                <TableCell>
                  <RelativeTime iso={a.nextDueAt} />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    title={
                      force
                        ? 'Force-remove this stuck assignment (skips agent ack)'
                        : 'Remove this assignment'
                    }
                    disabled={remove.isPending}
                    onClick={() => setRemoveTarget(a)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={isForce ? 'Force-remove this assignment?' : 'Remove this assignment?'}
        description={
          removeTarget ? (
            isForce ? (
              <span>
                <span className="font-medium">{removeTarget.configName ?? removeTarget.configId.slice(0, 8)}</span>{' '}
                is stuck in <span className="font-medium">removing</span>. Force-remove skips
                the agent acknowledgement and marks it as terminal so the slot is freed for a
                new assignment. Use this when the agent is offline or the previous removal never
                completed.
              </span>
            ) : (
              <span>
                The agent will stop applying{' '}
                <span className="font-medium">{removeTarget.configName ?? removeTarget.configId.slice(0, 8)}</span>{' '}
                on its next check-in. Run history is preserved.
              </span>
            )
          ) : null
        }
        confirmLabel={isForce ? 'Force remove' : 'Remove assignment'}
        destructive
        busy={remove.isPending}
        onConfirm={() => removeTarget && remove.mutate(removeTarget)}
      />
    </div>
  );
}

function RunsTab({ serverId }: { serverId: string }) {
  const [drawer, setDrawer] = useState<RunResultSummary | null>(null);
  const { data, isLoading, error } = useQuery<RunResultSummary[] | null>({
    queryKey: ['runResults', { serverId }],
    queryFn: () =>
      softFetch(() => apiGet<RunResultSummary[]>(`/run-results?serverId=${serverId}&limit=50`)),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (data === null) return <BackendIncomplete feature="Run results" />;
  if (error) return <div className="text-sm text-destructive">{(error as Error).message}</div>;

  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  No runs recorded yet.
                </TableCell>
              </TableRow>
            )}
            {data?.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => setDrawer(r)}
              >
                <TableCell className="font-mono text-xs">{r.runId.slice(0, 8)}</TableCell>
                <TableCell>
                  {r.hadErrors ? (
                    <Badge variant="destructive">errors</Badge>
                  ) : r.inDesiredState ? (
                    <Badge variant="success">in desired state</Badge>
                  ) : (
                    <Badge variant="warning">drift</Badge>
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">exit {r.exitCode}</span>
                </TableCell>
                <TableCell>{(r.durationMs / 1000).toFixed(1)}s</TableCell>
                <TableCell>
                  <RelativeTime iso={r.startedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Run output — {drawer?.runId.slice(0, 8)}</DialogTitle>
          </DialogHeader>
          <pre className="text-xs font-mono bg-muted p-3 rounded max-h-[60vh] overflow-auto">
            {drawer ? JSON.stringify(drawer.dscOutput ?? {}, null, 2) : ''}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ModulesTab({ serverId }: { serverId: string }) {
  const modules = useQuery<ServerModuleSummary[] | null>({
    queryKey: ['serverModules', serverId],
    queryFn: () =>
      softFetch(() => apiGet<ServerModuleSummary[]>(`/servers/${serverId}/modules`)),
  });
  // Required modules from this server's assignments
  const assigns = useQuery<AssignmentSummary[] | null>({
    queryKey: ['assignments', { serverId }],
    queryFn: () => softFetch(() => apiGet<AssignmentSummary[]>(`/assignments?serverId=${serverId}`)),
  });

  if (modules.isLoading) return <Skeleton className="h-40 w-full" />;
  if (modules.data === null) return <BackendIncomplete feature="Server modules" />;

  // Pull required module names off any joined revision data; if the API
  // doesn't yet inline that, we'll just show installed modules.
  const required = new Set<string>();
  for (const a of assigns.data ?? []) {
    const reqs = (a as unknown as { requiredModules?: RequiredModule[] }).requiredModules ?? [];
    for (const r of reqs) required.add(r.name);
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Module</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Discovered</TableHead>
            <TableHead>Required by assignment?</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(modules.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                No modules reported. The agent reports modules on each heartbeat.
              </TableCell>
            </TableRow>
          )}
          {modules.data?.map((m) => {
            const isReq = required.has(m.name);
            return (
              <TableRow key={m.name} className={isReq ? 'bg-emerald-500/5' : undefined}>
                <TableCell className="font-mono">{m.name}</TableCell>
                <TableCell>{m.installedVersion}</TableCell>
                <TableCell>
                  <RelativeTime iso={m.discoveredAt} />
                </TableCell>
                <TableCell>
                  {isReq ? <Badge variant="success">required</Badge> : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AuditTab({ serverId }: { serverId: string }) {
  const { data, isLoading } = useQuery<AuditEventSummary[] | null>({
    queryKey: ['auditEvents', { serverId }],
    queryFn: () =>
      softFetch(() =>
        apiGet<AuditEventSummary[]>(`/audit-events?entityId=${serverId}&limit=100`),
      ),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (data === null) return <BackendIncomplete feature="Audit events" />;
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Actor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                No audit events.
              </TableCell>
            </TableRow>
          )}
          {data?.map((e) => (
            <TableRow key={e.id}>
              <TableCell><RelativeTime iso={e.createdAt} /></TableCell>
              <TableCell className="font-mono text-xs">{e.eventType}</TableCell>
              <TableCell className="font-mono text-xs">
                {e.entityType}{e.entityId ? `/${e.entityId.slice(0, 8)}` : ''}
              </TableCell>
              <TableCell className="text-xs">
                {e.actorType}{e.actorId ? `:${e.actorId.slice(0, 8)}` : ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function JobsTab({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<JobSummary[] | null>({
    queryKey: ['jobs', { serverId }],
    queryFn: () => softFetch(() => apiGet<JobSummary[]>(`/jobs?serverId=${serverId}`)),
  });

  // For each running job, subscribe to live log updates.
  useWsTopic('*', (ev) => {
    if (ev.topic.startsWith('job:')) {
      qc.invalidateQueries({ queryKey: ['jobs', { serverId }] });
    }
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (data === null) return <BackendIncomplete feature="Jobs" />;

  return (
    <div className="space-y-3">
      {(data ?? []).length === 0 && (
        <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
          No jobs for this server.
        </div>
      )}
      {data?.map((j) => (
        <Card key={j.id}>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <CardTitle className="text-base">{j.type}</CardTitle>
            <JobStatusPill status={j.status} />
            <span className="ml-auto text-xs text-muted-foreground">
              <RelativeTime iso={j.requestedAt} />
            </span>
          </CardHeader>
          <CardContent>
            {j.log ? (
              <pre className="text-xs font-mono bg-muted p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap">
                {j.log}
              </pre>
            ) : (
              <div className="text-xs text-muted-foreground">No log output yet.</div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
