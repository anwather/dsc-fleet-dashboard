import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ToastProvider';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { LifecyclePill, PrereqPill, LastStatusPill } from '@/components/StatusPill';
import { apiGet, apiPost, apiDelete, ApiError, softFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  ServerSummary,
  ConfigSummary,
  AssignmentSummary,
} from '@dsc-fleet/shared-types';

const PAGE_SIZE = 25;

export function AssignmentsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState<{ serverId: string; configId: string } | null>(null);
  const [intervalMin, setIntervalMin] = useState(15);

  const servers = useQuery<ServerSummary[] | null>({
    queryKey: ['servers'],
    queryFn: () => softFetch(() => apiGet<ServerSummary[]>('/servers')),
  });
  const configs = useQuery<ConfigSummary[] | null>({
    queryKey: ['configs'],
    queryFn: () => softFetch(() => apiGet<ConfigSummary[]>('/configs')),
  });
  const assignments = useQuery<AssignmentSummary[] | null>({
    queryKey: ['assignments'],
    queryFn: () => softFetch(() => apiGet<AssignmentSummary[]>('/assignments')),
  });

  // Index for O(1) lookup in the matrix.
  const byKey = useMemo(() => {
    const m = new Map<string, AssignmentSummary>();
    for (const a of assignments.data ?? []) m.set(`${a.serverId}::${a.configId}`, a);
    return m;
  }, [assignments.data]);

  const filteredServers = (servers.data ?? []).filter((s) =>
    s.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const pageStart = page * PAGE_SIZE;
  const pageRows = filteredServers.slice(pageStart, pageStart + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filteredServers.length / PAGE_SIZE));

  const create = useMutation({
    mutationFn: (body: { serverId: string; configId: string; intervalMinutes: number }) =>
      apiPost<AssignmentSummary>('/assignments', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments'] });
      toast({ title: 'Assignment created', variant: 'success' });
      setPicker(null);
    },
    onError: (e: unknown) => {
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    },
  });

  const remove = useMutation({
    mutationFn: (assignmentId: string) => apiDelete(`/assignments/${assignmentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments'] });
      toast({ title: 'Removal requested', variant: 'success' });
    },
    onError: (e: unknown) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });

  const installAll = useMutation({
    mutationFn: async (serverId: string) => {
      try {
        return await apiPost(`/servers/${serverId}/install-modules`, {});
      } catch (e) {
        if (e instanceof ApiError && e.notImplemented) return null;
        throw e;
      }
    },
    onSuccess: (r) => {
      if (r === null) {
        toast({
          title: 'Bulk install unavailable',
          description: 'POST /servers/:id/install-modules not yet implemented.',
          variant: 'info',
        });
        return;
      }
      toast({ title: 'Module install job queued', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const notImpl =
    servers.data === null || configs.data === null || assignments.data === null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assignments</h1>
          <p className="text-sm text-muted-foreground">
            Server × Config matrix. Click a cell to assign or remove.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Filter servers…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            className="w-56"
          />
        </div>
      </div>

      {notImpl && <BackendIncomplete feature="Assignments matrix" />}

      {(servers.isLoading || configs.isLoading || assignments.isLoading) && (
        <Skeleton className="h-80 w-full" />
      )}

      {!servers.isLoading && servers.data && configs.data && assignments.data && (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="sticky left-0 z-10 bg-muted/50 text-left p-2 min-w-[220px]">
                    Server
                  </th>
                  {(configs.data ?? []).map((c) => (
                    <th key={c.id} className="text-left p-2 whitespace-nowrap">
                      <Link to={`/configs/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-muted-foreground font-normal">
                        v{c.currentRevision?.version ?? '—'}
                      </div>
                    </th>
                  ))}
                  <th className="p-2 w-32">Bulk</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={(configs.data?.length ?? 0) + 2} className="p-6 text-center text-muted-foreground">
                      No servers match.
                    </td>
                  </tr>
                )}
                {pageRows.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="sticky left-0 bg-background p-2 align-top">
                      <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{s.status}</div>
                    </td>
                    {(configs.data ?? []).map((c) => {
                      const a = byKey.get(`${s.id}::${c.id}`);
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            'p-2 align-top cursor-pointer hover:bg-accent/50 transition-colors',
                          )}
                          onClick={() => {
                            if (a) {
                              if (confirm(`Remove ${c.name} from ${s.name}?`)) remove.mutate(a.id);
                            } else {
                              setPicker({ serverId: s.id, configId: c.id });
                            }
                          }}
                        >
                          {a ? (
                            <div className="space-y-1">
                              <LifecyclePill state={a.lifecycleState} />
                              <div className="flex flex-wrap gap-1">
                                <PrereqPill status={a.prereqStatus} />
                                <LastStatusPill status={a.lastStatus} />
                              </div>
                            </div>
                          ) : (
                            <Badge variant="outline" className="opacity-40">+</Badge>
                          )}
                        </td>
                      );
                    })}
                    <td className="p-2 align-top">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => installAll.mutate(s.id)}
                        disabled={installAll.isPending}
                      >
                        <Wrench className="h-3 w-3" /> Install
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <span className="text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={!!picker} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New assignment</DialogTitle>
            <DialogDescription>
              The agent will install required modules on its next heartbeat (if missing) and start
              applying on the configured cadence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="interval">Interval (minutes)</Label>
              <Select
                value={String(intervalMin)}
                onValueChange={(v) => setIntervalMin(Number(v))}
              >
                <SelectTrigger id="interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[5, 10, 15, 30, 60, 120, 240, 1440].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPicker(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                picker &&
                create.mutate({
                  serverId: picker.serverId,
                  configId: picker.configId,
                  intervalMinutes: intervalMin,
                })
              }
              disabled={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create assignment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
