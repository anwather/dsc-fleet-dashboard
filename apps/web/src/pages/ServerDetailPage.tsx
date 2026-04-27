import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
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
import { apiGet, ApiError, softFetch } from '@/lib/api';
import { useWsTopic } from '@/hooks/useWebSocket';
import type {
  ServerSummary,
  AssignmentSummary,
  RunResultSummary,
  ServerModuleSummary,
  AuditEventSummary,
  JobSummary,
  RequiredModule,
} from '@dsc-fleet/shared-types';

export function ServerDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();

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

      <Tabs defaultValue="assignments">
        <TabsList>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="modules">Modules</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
        </TabsList>

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
    </div>
  );
}

function AssignmentsTab({ serverId }: { serverId: string }) {
  const { data, isLoading, error } = useQuery<AssignmentSummary[] | null>({
    queryKey: ['assignments', { serverId }],
    queryFn: () => softFetch(() => apiGet<AssignmentSummary[]>(`/assignments?serverId=${serverId}`)),
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
            <TableHead>Interval</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead>Prereqs</TableHead>
            <TableHead>Last status</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Next due</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                No assignments. Use the Assignments matrix to assign a config.
              </TableCell>
            </TableRow>
          )}
          {data?.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <Link to={`/configs/${a.configId}`} className="font-medium hover:underline">
                  {a.configName ?? a.configId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>{a.intervalMinutes} min</TableCell>
              <TableCell>
                <LifecyclePill state={a.lifecycleState} />
              </TableCell>
              <TableCell>
                <PrereqPill status={a.prereqStatus} />
              </TableCell>
              <TableCell>
                <LastStatusPill status={a.lastStatus} />
              </TableCell>
              <TableCell>
                <RelativeTime iso={a.lastRunAt} />
              </TableCell>
              <TableCell>
                <RelativeTime iso={a.nextDueAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

// Avoid unused-import lint when Button/etc. stay in tree for future use
void Button;
