import { Badge } from '@/components/ui/badge';
import type {
  ServerStatus,
  AssignmentLifecycleState,
  AssignmentPrereqStatus,
  AssignmentLastStatus,
  JobStatus,
} from '@dsc-fleet/shared-types';

type Variant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' | 'muted';

const SERVER: Record<ServerStatus, Variant> = {
  pending: 'muted',
  provisioning: 'info',
  ready: 'success',
  error: 'destructive',
  offline: 'warning',
};

export function ServerStatusPill({ status }: { status: ServerStatus }) {
  return <Badge variant={SERVER[status]}>{status}</Badge>;
}

const LIFECYCLE: Record<AssignmentLifecycleState, Variant> = {
  active: 'success',
  removing: 'warning',
  removed: 'muted',
  removal_expired: 'destructive',
};

export function LifecyclePill({ state }: { state: AssignmentLifecycleState }) {
  return <Badge variant={LIFECYCLE[state]}>{state}</Badge>;
}

const PREREQ: Record<AssignmentPrereqStatus, Variant> = {
  unknown: 'muted',
  installing: 'info',
  ready: 'success',
  failed: 'destructive',
};

export function PrereqPill({ status }: { status: AssignmentPrereqStatus }) {
  return <Badge variant={PREREQ[status]}>{status}</Badge>;
}

const LAST: Record<AssignmentLastStatus, Variant> = {
  success: 'success',
  drift: 'warning',
  error: 'destructive',
  never: 'muted',
};

export function LastStatusPill({ status }: { status: AssignmentLastStatus }) {
  return <Badge variant={LAST[status]}>{status}</Badge>;
}

const JOB: Record<JobStatus, Variant> = {
  queued: 'muted',
  running: 'info',
  success: 'success',
  failed: 'destructive',
  cancelled: 'warning',
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  return <Badge variant={JOB[status]}>{status}</Badge>;
}
