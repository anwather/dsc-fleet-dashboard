import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, FileCode2, Trash2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/ToastProvider';
import { apiDelete, apiGet, ApiError, softFetch } from '@/lib/api';
import { RelativeTime } from '@/components/RelativeTime';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { RefreshButton } from '@/components/ui/RefreshButton';
import type { ConfigSummary } from '@dsc-fleet/shared-types';

export function ConfigsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [removeTarget, setRemoveTarget] = useState<ConfigSummary | null>(null);

  const { data, isLoading } = useQuery<ConfigSummary[] | null>({
    queryKey: ['configs'],
    queryFn: () => softFetch(() => apiGet<ConfigSummary[]>('/configs')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/configs/${id}`),
    onSuccess: () => {
      toast({
        title: 'Config removed',
        description: removeTarget ? `${removeTarget.name} hidden. Revision history retained.` : 'Config removed.',
        variant: 'success',
      });
      qc.invalidateQueries({ queryKey: ['configs'] });
      setRemoveTarget(null);
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError && e.body && typeof e.body === 'object' && 'message' in e.body
          ? String((e.body as { message?: unknown }).message ?? e.message)
          : e instanceof Error
            ? e.message
            : 'Failed to remove config';
      toast({ title: 'Remove failed', description: msg, variant: 'destructive' });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Configurations</h1>
          <p className="text-sm text-muted-foreground">
            Immutable revisions of DSC v3 documents. Editing a config creates a new revision.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton queryKeys={[['configs']]} />
          <Button asChild>
            <Link to="/configs/new">
              <Plus className="h-4 w-4" /> New Config
            </Link>
          </Button>
        </div>
      </div>

      {data === null && <BackendIncomplete feature="Config inventory" />}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Required modules</TableHead>
              <TableHead>Assignments</TableHead>
              <TableHead className="text-right">Updated</TableHead>
              <TableHead className="w-[60px]" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (data?.length ?? 0) === 0 && data !== null && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="py-12 flex flex-col items-center text-center text-muted-foreground gap-2">
                    <FileCode2 className="h-8 w-8" />
                    <div className="font-medium">No configurations yet.</div>
                    <div className="text-sm">
                      Click <span className="font-medium">New Config</span> to author one — pick a
                      sample to start fast.
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {data?.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link to={`/configs/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{c.description ?? '—'}</TableCell>
                <TableCell>v{c.currentRevision?.version ?? '—'}</TableCell>
                <TableCell className="space-x-1">
                  {(c.currentRevision?.requiredModules ?? []).map((m) => (
                    <Badge key={m.name} variant="info">
                      {m.name}
                    </Badge>
                  ))}
                  {(c.currentRevision?.requiredModules?.length ?? 0) === 0 && (
                    <span className="text-xs text-muted-foreground">none</span>
                  )}
                </TableCell>
                <TableCell>{c.assignmentCount ?? 0}</TableCell>
                <TableCell className="text-right">
                  <RelativeTime iso={c.updatedAt} />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove config"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => setRemoveTarget(c)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="Remove config?"
        description={
          removeTarget ? (
            <span>
              <span className="font-medium">{removeTarget.name}</span> will be hidden from all lists.
              Revisions and run history are kept in the database (soft-delete). The API rejects this
              if the config still has active or pending-removal assignments — remove those first.
            </span>
          ) : null
        }
        confirmLabel="Remove config"
        destructive
        busy={remove.isPending}
        onConfirm={() => removeTarget && remove.mutate(removeTarget.id)}
      />
    </div>
  );
}
