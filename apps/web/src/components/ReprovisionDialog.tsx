import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPost } from '@/lib/api';
import { useToast } from './ToastProvider';
import { buildProvisionTokenBody, type RunAsKind } from '@/lib/runAsBody';

export interface ReprovisionDialogRunAs {
  kind: RunAsKind;
  user: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverName: string;
  /** What the dashboard currently has stored for this server, if anything. */
  currentRunAs?: ReprovisionDialogRunAs;
}

/**
 * Opens when the user clicks "Re-run provisioning" on a server whose stored
 * run-as identity is anything other than SYSTEM. We never silently re-use the
 * persisted password — every reprovision must explicitly confirm the
 * credentials. (For SYSTEM we don't open this dialog at all and just fire the
 * empty-body POST.)
 */
export function ReprovisionDialog({
  open,
  onOpenChange,
  serverId,
  serverName,
  currentRunAs,
}: Props) {
  const initialKind: RunAsKind = currentRunAs?.kind ?? 'password';
  const [kind, setKind] = useState<RunAsKind>(initialKind);
  const [user, setUser] = useState<string>(currentRunAs?.user ?? '');
  const [password, setPassword] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  // Re-seed every time the dialog (re)opens so we never persist stale form
  // state from a previous server.
  useEffect(() => {
    if (open) {
      setKind(currentRunAs?.kind ?? 'password');
      setUser(currentRunAs?.user ?? '');
      setPassword('');
      setErr(null);
    }
  }, [open, currentRunAs?.kind, currentRunAs?.user]);

  // Switching to SYSTEM should clear the username — we don't want a half-filled
  // form to look like the user is overriding it.
  useEffect(() => {
    if (kind === 'system') setUser('');
  }, [kind]);

  const submit = useMutation({
    mutationFn: () => {
      const body = buildProvisionTokenBody({ kind, user, password });
      return apiPost<{ jobId: string }>(`/servers/${serverId}/provision-token`, body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['jobs', { serverId }] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast({
        title: 'Provisioning queued',
        description: `${serverName}: job ${r.jobId.slice(0, 8)}.`,
        variant: 'success',
      });
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to queue provisioning';
      setErr(msg);
      toast({ title: 'Re-run failed', description: msg, variant: 'destructive' });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (kind === 'password') {
      if (!user.trim() || !password) {
        setErr('Username and password are required for password run-as.');
        return;
      }
    } else if (kind === 'gmsa') {
      if (!user.trim()) {
        setErr('gMSA name is required.');
        return;
      }
    }
    submit.mutate();
  }

  const previousLabel =
    currentRunAs?.kind === 'system'
      ? 'SYSTEM'
      : currentRunAs?.user
        ? `${currentRunAs.user} (${currentRunAs.kind})`
        : currentRunAs?.kind ?? 'unknown';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-run provisioning — {serverName}</DialogTitle>
          <DialogDescription>
            Confirm the run-as identity that will own <code>DscV3-Apply</code> after this
            provision. Currently stored: <strong>{previousLabel}</strong>. Passwords are not
            re-used silently — re-enter to confirm.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Run-as identity</Label>
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reprovKind"
                  value="system"
                  checked={kind === 'system'}
                  onChange={() => setKind('system')}
                />
                SYSTEM
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reprovKind"
                  value="password"
                  checked={kind === 'password'}
                  onChange={() => setKind('password')}
                />
                Password account
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="reprovKind"
                  value="gmsa"
                  checked={kind === 'gmsa'}
                  onChange={() => setKind('gmsa')}
                />
                gMSA
              </label>
            </div>
          </div>
          {kind !== 'system' && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="reprovUser">
                  {kind === 'gmsa' ? 'gMSA (DOMAIN\\name$)' : 'Username (DOMAIN\\user)'}
                </Label>
                <Input
                  id="reprovUser"
                  placeholder={kind === 'gmsa' ? 'CONTOSO\\dscgmsa$' : 'CONTOSO\\dscop'}
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {kind === 'password' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="reprovPassword">Password</Label>
                  <Input
                    id="reprovPassword"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          {err && <span className="text-xs text-destructive">{err}</span>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submit.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? 'Queuing…' : 'Re-run provisioning'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
