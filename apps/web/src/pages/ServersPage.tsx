import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus, ServerOff, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ServerStatusPill } from '@/components/StatusPill';
import { RelativeTime } from '@/components/RelativeTime';
import { AddServerDialog } from '@/components/AddServerDialog';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { useWsTopic } from '@/hooks/useWebSocket';
import { useToast } from '@/components/ToastProvider';
import type { ServerSummary } from '@dsc-fleet/shared-types';

export function ServersPage() {
  const [open, setOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ServerSummary | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery<ServerSummary[]>({
    queryKey: ['servers'],
    queryFn: () => apiGet<ServerSummary[]>('/servers'),
  });

  // Live status pill: invalidate the list whenever a server:* event fires.
  useWsTopic('*', (ev) => {
    if (ev.topic.startsWith('server:')) {
      qc.invalidateQueries({ queryKey: ['servers'] });
    }
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/servers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast({
        title: 'Server removed',
        description: removeTarget
          ? `${removeTarget.name} hidden. Run history retained in DB.`
          : 'Server removed.',
        variant: 'success',
      });
      setRemoveTarget(null);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to remove server';
      toast({ title: 'Remove failed', description: msg, variant: 'destructive' });
    },
  });

  const notImpl = error instanceof ApiError && error.notImplemented;
  const otherErr = error && !notImpl ? (error as Error).message : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="text-sm text-muted-foreground">
            Azure VMs registered with this dashboard. Click a name to view detail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton queryKeys={[['servers']]} />
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Add Server
          </Button>
        </div>
      </div>

      {notImpl && <BackendIncomplete feature="Server inventory" />}
      {otherErr && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          Failed to load servers: {otherErr}
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Azure target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last heartbeat</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[140px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (data?.length ?? 0) === 0 && !notImpl && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="py-12 flex flex-col items-center text-center text-muted-foreground gap-2">
                    <ServerOff className="h-8 w-8" />
                    <div className="font-medium">No servers yet.</div>
                    <div className="text-sm">
                      Click <span className="font-medium">Add Server</span> to onboard your first
                      Azure VM.
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {data?.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link
                    to={`/servers/${s.id}`}
                    className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                  >
                    {s.name}
                  </Link>
                  {s.hostname && (
                    <span className="ml-2 text-xs text-muted-foreground">{s.hostname}</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <div>{s.azureSubscriptionId.slice(0, 8)}…</div>
                  <div>{s.azureResourceGroup}/{s.azureVmName}</div>
                </TableCell>
                <TableCell>
                  <ServerStatusPill status={s.status} />
                  {s.lastError && (
                    <div className="text-xs text-destructive mt-1 truncate max-w-xs" title={s.lastError}>
                      {s.lastError}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <RelativeTime iso={s.lastHeartbeatAt} />
                </TableCell>
                <TableCell>
                  <RelativeTime iso={s.createdAt} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      title="View server detail"
                    >
                      <Link to={`/servers/${s.id}`}>
                        View <ChevronRight className="h-4 w-4" />
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove server"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => setRemoveTarget(s)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AddServerDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="Remove server?"
        description={
          removeTarget ? (
            <span>
              <span className="font-medium">{removeTarget.name}</span> will be hidden from all
              lists. Assignments and run history are kept in the database (soft-delete) so audit
              data isn't lost.
            </span>
          ) : null
        }
        confirmLabel="Remove server"
        destructive
        busy={remove.isPending}
        onConfirm={() => removeTarget && remove.mutate(removeTarget.id)}
      />
    </div>
  );
}
