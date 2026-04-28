import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { LifecyclePill, LastStatusPill, ServerStatusPill } from '@/components/StatusPill';
import { apiGet, apiPost, apiPatch, apiDelete, softFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  ServerSummary,
  ConfigSummary,
  AssignmentSummary,
} from '@dsc-fleet/shared-types';

const PAGE_SIZE = 25;
const INTERVAL_OPTIONS = [5, 10, 15, 30, 60, 120, 240, 1440];

/**
 * Lifecycle states the user can act on. Terminal states (`removed`,
 * `removal_expired`) are filtered out so stale chips don't pollute the
 * per-server "X configs assigned" count or block re-adding the same
 * config (which the API permits because the partial unique index only
 * covers `active`+`removing`).
 */
const ACTIONABLE_LIFECYCLES = new Set(['active', 'removing']);

type AddPicker = { serverId: string; serverName: string };
type ChipMenu = { assignment: AssignmentSummary; configName: string; serverName: string };

/**
 * Per-server list of config chips. Replaces the original Server×Config matrix
 * (which didn't scale past ~6 configs) and the confusing "Bulk / Install"
 * column (whose action moved to ServerDetail → Prereqs → Install missing
 * modules, where the actual missing-module list is computed).
 */
export function AssignmentsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);

  const [addPicker, setAddPicker] = useState<AddPicker | null>(null);
  const [pickConfigId, setPickConfigId] = useState<string>('');
  const [intervalMin, setIntervalMin] = useState(15);

  const [chipMenu, setChipMenu] = useState<ChipMenu | null>(null);
  const [chipInterval, setChipInterval] = useState(15);
  const [removeTarget, setRemoveTarget] = useState<ChipMenu | null>(null);

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

  // Group assignments by serverId for the per-server list rendering.
  // Terminal-state rows are filtered out — they're not actionable and
  // they confuse the "X configs assigned" count + addAvailable picker.
  const byServer = useMemo(() => {
    const m = new Map<string, AssignmentSummary[]>();
    for (const a of assignments.data ?? []) {
      if (!ACTIONABLE_LIFECYCLES.has(a.lifecycleState)) continue;
      const arr = m.get(a.serverId) ?? [];
      arr.push(a);
      m.set(a.serverId, arr);
    }
    return m;
  }, [assignments.data]);

  // Quick lookup: configId → name.
  const configName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of configs.data ?? []) m.set(c.id, c.name);
    return m;
  }, [configs.data]);

  // Quick lookup: configId → current revision (id + version) for the
  // "update available" affordance on assignment chips.
  const configCurrentRevision = useMemo(() => {
    const m = new Map<string, { id: string; version: number } | null>();
    for (const c of configs.data ?? []) {
      m.set(c.id, c.currentRevision ? { id: c.currentRevision.id, version: c.currentRevision.version } : null);
    }
    return m;
  }, [configs.data]);

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
      setAddPicker(null);
      setPickConfigId('');
    },
    onError: (e: unknown) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });

  const updateInterval = useMutation({
    mutationFn: ({ id, intervalMinutes }: { id: string; intervalMinutes: number }) =>
      apiPatch<AssignmentSummary>(`/assignments/${id}`, { intervalMinutes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments'] });
      toast({ title: 'Interval updated', variant: 'success' });
      setChipMenu(null);
    },
    onError: (e: unknown) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });

  const updateRevision = useMutation({
    mutationFn: ({ id, pinnedRevisionId }: { id: string; pinnedRevisionId: string }) =>
      apiPatch<AssignmentSummary>(`/assignments/${id}`, { pinnedRevisionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments'] });
      qc.invalidateQueries({ queryKey: ['configs'] });
      toast({ title: 'Revision updated', variant: 'success' });
      setChipMenu(null);
    },
    onError: (e: unknown) =>
      toast({
        title: 'Update failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });

  const remove = useMutation({
    mutationFn: (a: AssignmentSummary) =>
      a.lifecycleState === 'removing'
        ? apiPost(`/assignments/${a.id}/force-remove`, {})
        : apiDelete(`/assignments/${a.id}`),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['assignments'] });
      qc.invalidateQueries({ queryKey: ['configs'] });
      toast({
        title:
          variables.lifecycleState === 'removing'
            ? 'Assignment force-removed'
            : 'Removal requested',
        variant: 'success',
      });
      setRemoveTarget(null);
      setChipMenu(null);
    },
    onError: (e: unknown) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      }),
  });

  const notImpl =
    servers.data === null || configs.data === null || assignments.data === null;

  // Available configs for the Add picker — exclude already-assigned ones.
  const addAvailable = useMemo(() => {
    if (!addPicker) return [];
    const taken = new Set((byServer.get(addPicker.serverId) ?? []).map((a) => a.configId));
    return (configs.data ?? []).filter((c) => !taken.has(c.id));
  }, [addPicker, byServer, configs.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assignments</h1>
          <p className="text-sm text-muted-foreground">
            One row per server. Each chip is an assigned config — click a chip to edit interval,
            remove, or jump to its run history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter servers…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            className="w-56"
          />
          <RefreshButton queryKeys={[['servers'], ['configs'], ['assignments']]} />
        </div>
      </div>

      {notImpl && <BackendIncomplete feature="Assignments" />}

      {(servers.isLoading || configs.isLoading || assignments.isLoading) && (
        <Skeleton className="h-80 w-full" />
      )}

      {!servers.isLoading && servers.data && configs.data && assignments.data && (
        <>
          <div className="rounded-lg border divide-y">
            {pageRows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No servers match.
              </div>
            )}
            {pageRows.map((s) => {
              const list = byServer.get(s.id) ?? [];
              return (
                <div
                  key={s.id}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-[200px] sm:max-w-[260px]">
                    <Link
                      to={`/servers/${s.id}`}
                      className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                    >
                      {s.name}
                    </Link>
                    <div className="mt-1 flex items-center gap-2">
                      <ServerStatusPill status={s.status} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {list.length === 0
                        ? 'No configs assigned.'
                        : `${list.length} config${list.length === 1 ? '' : 's'} assigned.`}
                    </div>
                  </div>

                  <div className="flex flex-1 flex-wrap gap-2">
                    {list.map((a) => {
                      const name = configName.get(a.configId) ?? a.configId.slice(0, 8);
                      const updateAvailable =
                        a.revisionVersion != null &&
                        a.latestRevisionVersion != null &&
                        a.latestRevisionVersion > a.revisionVersion;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            setChipInterval(a.intervalMinutes);
                            setChipMenu({
                              assignment: a,
                              configName: name,
                              serverName: s.name,
                            });
                          }}
                          className={cn(
                            'group inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs',
                            'hover:border-primary hover:bg-accent transition-colors',
                          )}
                          title={
                            updateAvailable
                              ? `${name} v${a.revisionVersion} → v${a.latestRevisionVersion} available · click to update`
                              : `${name} v${a.revisionVersion ?? '?'} · every ${a.intervalMinutes}m — click to manage`
                          }
                        >
                          <LifecyclePill state={a.lifecycleState} />
                          <span className="font-medium">{name}</span>
                          {a.revisionVersion != null && (
                            <span className="text-muted-foreground">v{a.revisionVersion}</span>
                          )}
                          {updateAvailable && (
                            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              v{a.latestRevisionVersion} available
                            </span>
                          )}
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">every {a.intervalMinutes}m</span>
                          {a.lastStatus && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <LastStatusPill status={a.lastStatus} />
                              {a.lastRunRevisionVersion != null && (
                                <span className="text-muted-foreground">v{a.lastRunRevisionVersion}</span>
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
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex shrink-0 sm:self-center">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setIntervalMin(15);
                        setPickConfigId('');
                        setAddPicker({ serverId: s.id, serverName: s.name });
                      }}
                    >
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                  </div>
                </div>
              );
            })}
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

      {/* Add assignment dialog — config picker + interval. */}
      <Dialog open={!!addPicker} onOpenChange={(o) => !o && setAddPicker(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a config to {addPicker?.serverName}</DialogTitle>
            <DialogDescription>
              The agent will install required modules on its next heartbeat (if missing) and start
              applying on the configured cadence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-picker">Configuration</Label>
              <Select value={pickConfigId} onValueChange={setPickConfigId}>
                <SelectTrigger id="cfg-picker">
                  <SelectValue placeholder="Select a configuration…" />
                </SelectTrigger>
                <SelectContent>
                  {addAvailable.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No more configs available
                    </SelectItem>
                  )}
                  {addAvailable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} (v{c.currentRevision?.version ?? '—'})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
                  {INTERVAL_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      every {n} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPicker(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                addPicker &&
                pickConfigId &&
                create.mutate({
                  serverId: addPicker.serverId,
                  configId: pickConfigId,
                  intervalMinutes: intervalMin,
                })
              }
              disabled={create.isPending || !pickConfigId}
              title={!pickConfigId ? 'Pick a configuration first' : undefined}
            >
              {create.isPending ? 'Creating…' : 'Create assignment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chip menu — edit interval / remove / jump to config. */}
      <Dialog open={!!chipMenu} onOpenChange={(o) => !o && setChipMenu(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {chipMenu?.configName} on {chipMenu?.serverName}
            </DialogTitle>
            <DialogDescription>
              {chipMenu?.assignment.revisionVersion != null && (
                <span className="mr-2 inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                  revision v{chipMenu.assignment.revisionVersion}
                </span>
              )}
              Adjust the cadence, remove this assignment, or jump to the related views.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="chip-interval">Interval (minutes)</Label>
              <Select
                value={String(chipInterval)}
                onValueChange={(v) => setChipInterval(Number(v))}
              >
                <SelectTrigger id="chip-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      every {n} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              {chipMenu && (
                <>
                  {(() => {
                    const cur = configCurrentRevision.get(chipMenu.assignment.configId);
                    const av =
                      chipMenu.assignment.revisionVersion != null &&
                      cur &&
                      cur.version > chipMenu.assignment.revisionVersion;
                    if (!av || !cur) return null;
                    return (
                      <Button
                        size="sm"
                        variant="default"
                        disabled={updateRevision.isPending}
                        onClick={() =>
                          updateRevision.mutate({
                            id: chipMenu.assignment.id,
                            pinnedRevisionId: cur.id,
                          })
                        }
                      >
                        {updateRevision.isPending
                          ? 'Updating…'
                          : `Update to v${cur.version}`}
                      </Button>
                    );
                  })()}
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/configs/${chipMenu.assignment.configId}`}>View config →</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/servers/${chipMenu.assignment.serverId}`}>View server →</Link>
                  </Button>
                </>
              )}
            </div>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="destructive"
              onClick={() => chipMenu && setRemoveTarget(chipMenu)}
              disabled={remove.isPending}
              title={
                chipMenu?.assignment.lifecycleState === 'removing'
                  ? 'Force-remove (skips agent ack — use when agent is stuck/offline)'
                  : 'Soft-remove (agent uninstalls on next check-in)'
              }
            >
              <X className="h-4 w-4" />
              {chipMenu?.assignment.lifecycleState === 'removing' ? 'Force remove' : 'Remove'}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setChipMenu(null)}>
                Close
              </Button>
              <Button
                onClick={() =>
                  chipMenu &&
                  updateInterval.mutate({
                    id: chipMenu.assignment.id,
                    intervalMinutes: chipInterval,
                  })
                }
                disabled={
                  updateInterval.isPending ||
                  !chipMenu ||
                  chipInterval === chipMenu.assignment.intervalMinutes
                }
              >
                {updateInterval.isPending ? 'Saving…' : 'Save interval'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm-remove dialog (separate so chip menu stays open behind it). */}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={
          removeTarget?.assignment.lifecycleState === 'removing'
            ? 'Force-remove this assignment?'
            : 'Remove this assignment?'
        }
        description={
          removeTarget ? (
            removeTarget.assignment.lifecycleState === 'removing' ? (
              <span>
                <span className="font-medium">{removeTarget.configName}</span> on{' '}
                <span className="font-medium">{removeTarget.serverName}</span> is stuck in{' '}
                <span className="font-medium">removing</span>. Force-remove skips the agent
                acknowledgement and marks it as terminal so you can reassign the same config.
                Use this when the agent is offline or the previous removal never completed.
              </span>
            ) : (
              <span>
                Remove <span className="font-medium">{removeTarget.configName}</span> from{' '}
                <span className="font-medium">{removeTarget.serverName}</span>? Run history is kept;
                the agent will stop applying this config on its next check-in.
              </span>
            )
          ) : null
        }
        confirmLabel={
          removeTarget?.assignment.lifecycleState === 'removing'
            ? 'Force remove'
            : 'Remove assignment'
        }
        destructive
        busy={remove.isPending}
        onConfirm={() => removeTarget && remove.mutate(removeTarget.assignment)}
      />
    </div>
  );
}
