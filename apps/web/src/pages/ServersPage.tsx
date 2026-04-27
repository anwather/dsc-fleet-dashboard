import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, ServerOff } from 'lucide-react';
import { apiGet, ApiError } from '@/lib/api';
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
import { useWsTopic } from '@/hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerSummary } from '@dsc-fleet/shared-types';

export function ServersPage() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

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

  const notImpl = error instanceof ApiError && error.notImplemented;
  const otherErr = error && !notImpl ? (error as Error).message : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="text-sm text-muted-foreground">
            Azure VMs registered with this dashboard.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add Server
        </Button>
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
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (data?.length ?? 0) === 0 && !notImpl && (
              <TableRow>
                <TableCell colSpan={5}>
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
                  <Link to={`/servers/${s.id}`} className="font-medium hover:underline">
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
                <TableCell className="text-right">
                  <RelativeTime iso={s.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AddServerDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
