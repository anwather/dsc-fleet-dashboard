import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { JobStatusPill } from '@/components/StatusPill';
import { RelativeTime } from '@/components/RelativeTime';
import { BackendIncomplete } from '@/components/BackendIncomplete';
import { apiGet, softFetch } from '@/lib/api';
import { useWsTopic } from '@/hooks/useWebSocket';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { JobSummary, JobStatus } from '@dsc-fleet/shared-types';

const STATUSES: ('all' | JobStatus)[] = ['all', 'queued', 'running', 'success', 'failed', 'cancelled'];

export function JobsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | JobStatus>('all');

  const { data, isLoading } = useQuery<JobSummary[] | null>({
    queryKey: ['jobs', { status }],
    queryFn: () =>
      softFetch(() =>
        apiGet<JobSummary[]>(`/jobs${status === 'all' ? '' : `?status=${status}`}`),
      ),
  });

  // Live updates: any job:* event refreshes the list and the per-job entry.
  useWsTopic('*', (ev) => {
    if (ev.topic.startsWith('job:')) {
      qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Background work — provisioning, module installs, removals. Live-updated over WebSocket.
          </p>
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as 'all' | JobStatus)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {data === null && <BackendIncomplete feature="Jobs" />}
      {isLoading && <Skeleton className="h-40 w-full" />}

      {(data ?? []).length === 0 && data !== null && !isLoading && (
        <div className="rounded-md border py-12 text-center text-sm text-muted-foreground">
          No jobs match.
        </div>
      )}

      <div className="space-y-3">
        {data?.map((j) => (
          <Card key={j.id}>
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <div className="flex-1">
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  <span>{j.type}</span>
                  <JobStatusPill status={j.status} />
                  {j.attempts > 0 && <Badge variant="muted">attempts: {j.attempts}</Badge>}
                </CardTitle>
                <div className="mt-1 text-xs text-muted-foreground space-x-3">
                  {j.serverId && (
                    <Link to={`/servers/${j.serverId}`} className="hover:underline">
                      server: {j.serverId.slice(0, 8)}
                    </Link>
                  )}
                  <span>requested <RelativeTime iso={j.requestedAt} /></span>
                  {j.startedAt && <span>started <RelativeTime iso={j.startedAt} /></span>}
                  {j.finishedAt && <span>finished <RelativeTime iso={j.finishedAt} /></span>}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {j.errorCode && (
                <div className="text-xs text-destructive mb-2">error: {j.errorCode}</div>
              )}
              {j.log ? (
                <pre className="text-xs font-mono bg-muted p-3 rounded max-h-48 overflow-auto whitespace-pre-wrap">
                  {j.log}
                </pre>
              ) : (
                <div className="text-xs text-muted-foreground">No log output.</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
