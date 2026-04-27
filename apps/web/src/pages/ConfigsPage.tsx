import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, FileCode2 } from 'lucide-react';
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
import { apiGet, softFetch } from '@/lib/api';
import { RelativeTime } from '@/components/RelativeTime';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { RefreshButton } from '@/components/ui/RefreshButton';
import type { ConfigSummary } from '@dsc-fleet/shared-types';

export function ConfigsPage() {
  const { data, isLoading } = useQuery<ConfigSummary[] | null>({
    queryKey: ['configs'],
    queryFn: () => softFetch(() => apiGet<ConfigSummary[]>('/configs')),
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

            {!isLoading && (data?.length ?? 0) === 0 && data !== null && (
              <TableRow>
                <TableCell colSpan={6}>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
