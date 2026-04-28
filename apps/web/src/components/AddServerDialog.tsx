import { useState, type FormEvent } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { apiPost, ApiError } from '@/lib/api';
import { useToast } from './ToastProvider';
import type { ServerCreate, ServerSummary } from '@dsc-fleet/shared-types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddServerDialog({ open, onOpenChange }: Props) {
  const [form, setForm] = useState({
    azureSubscriptionId: '',
    azureResourceGroup: '',
    azureVmName: '',
    name: '',
    labelsJson: '{}',
  });
  const [runAsKind, setRunAsKind] = useState<'system' | 'password' | 'gmsa'>('system');
  const [runAsUser, setRunAsUser] = useState('');
  const [runAsPassword, setRunAsPassword] = useState('');
  const [labelsErr, setLabelsErr] = useState<string | null>(null);
  const [runAsErr, setRunAsErr] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const createServer = useMutation({
    mutationFn: async (input: {
      body: ServerCreate;
      runAs?: { kind: 'password' | 'gmsa'; user: string; password?: string };
    }) => {
      const server = await apiPost<ServerSummary>('/servers', input.body);
      // Best-effort: queue the provision job. The route is /provision-token;
      // a /provision alias also exists for older clients.
      let jobId: string | null = null;
      try {
        const provisionBody: Record<string, unknown> = {};
        if (input.runAs) provisionBody.runAs = input.runAs;
        const r = await apiPost<{ jobId: string }>(
          `/servers/${server.id}/provision-token`,
          provisionBody,
        );
        jobId = r.jobId;
      } catch (e) {
        // 501 = backend not implemented (dev mode) — we still created the row.
        if (!(e instanceof ApiError && e.notImplemented)) {
          // Don't fail the whole add — surface a separate toast and let the
          // user re-run provisioning from Server detail → Prereqs.
          toast({
            title: 'Provision job not queued',
            description: e instanceof Error ? e.message : String(e),
            variant: 'destructive',
          });
        }
      }
      return { server, jobId };
    },
    onSuccess: ({ server, jobId }) => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      toast({
        title: 'Server added',
        description: jobId
          ? `${server.name} queued for provisioning (job ${jobId.slice(0, 8)}).`
          : `${server.name} added. Provisioning was not queued — re-run it from Server detail.`,
        variant: 'success',
      });
      onOpenChange(false);
      reset();
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to create server';
      toast({ title: 'Add server failed', description: msg, variant: 'destructive' });
    },
  });

  function reset() {
    setForm({
      azureSubscriptionId: '',
      azureResourceGroup: '',
      azureVmName: '',
      name: '',
      labelsJson: '{}',
    });
    setRunAsKind('system');
    setRunAsUser('');
    setRunAsPassword('');
    setLabelsErr(null);
    setRunAsErr(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    let labels: Record<string, unknown> = {};
    try {
      labels = JSON.parse(form.labelsJson || '{}');
      if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
        throw new Error('labels must be a JSON object');
      }
    } catch (err) {
      setLabelsErr(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }
    setLabelsErr(null);

    let runAs: { kind: 'password' | 'gmsa'; user: string; password?: string } | undefined;
    if (runAsKind === 'password') {
      if (!runAsUser.trim() || !runAsPassword) {
        setRunAsErr('Username and password are required for password run-as.');
        return;
      }
      runAs = { kind: 'password', user: runAsUser.trim(), password: runAsPassword };
    } else if (runAsKind === 'gmsa') {
      if (!runAsUser.trim()) {
        setRunAsErr('Username (e.g. CONTOSO\\dscgmsa$) is required for gMSA.');
        return;
      }
      runAs = { kind: 'gmsa', user: runAsUser.trim() };
    }
    setRunAsErr(null);

    createServer.mutate({
      body: {
        azureSubscriptionId: form.azureSubscriptionId.trim(),
        azureResourceGroup: form.azureResourceGroup.trim(),
        azureVmName: form.azureVmName.trim(),
        name: form.name.trim() || undefined,
        labels,
      },
      runAs,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Azure VM</DialogTitle>
          <DialogDescription>
            Add a Windows Server VM to the fleet. The dashboard will queue a provisioning job
            using <code>virtualMachines.runCommand</code>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sub">Azure subscription ID</Label>
            <Input
              id="sub"
              required
              placeholder="00000000-0000-0000-0000-000000000000"
              value={form.azureSubscriptionId}
              onChange={(e) => setForm({ ...form, azureSubscriptionId: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rg">Resource group</Label>
            <Input
              id="rg"
              required
              placeholder="rg-fleet-prod"
              value={form.azureResourceGroup}
              onChange={(e) => setForm({ ...form, azureResourceGroup: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vm">VM name</Label>
            <Input
              id="vm"
              required
              placeholder="vm-web-01"
              value={form.azureVmName}
              onChange={(e) => setForm({ ...form, azureVmName: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Friendly name (optional)</Label>
            <Input
              id="name"
              placeholder="Defaults to VM name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="labels">Labels (JSON)</Label>
            <Textarea
              id="labels"
              rows={3}
              value={form.labelsJson}
              onChange={(e) => setForm({ ...form, labelsJson: e.target.value })}
            />
            {labelsErr && <span className="text-xs text-destructive">{labelsErr}</span>}
          </div>
          <div className="grid gap-1.5 border-t pt-3">
            <Label>Run-as identity</Label>
            <p className="text-xs text-muted-foreground">
              Identity that runs <code>DscV3-Apply</code> on the box. Password is encrypted at
              rest, transmitted via a one-time URL, and never persisted in Azure Run-Command
              instance view.
            </p>
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="runAsKind"
                  value="system"
                  checked={runAsKind === 'system'}
                  onChange={() => setRunAsKind('system')}
                />
                SYSTEM
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="runAsKind"
                  value="password"
                  checked={runAsKind === 'password'}
                  onChange={() => setRunAsKind('password')}
                />
                Password account
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="runAsKind"
                  value="gmsa"
                  checked={runAsKind === 'gmsa'}
                  onChange={() => setRunAsKind('gmsa')}
                />
                gMSA
              </label>
            </div>
            {runAsKind !== 'system' && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="runAsUser">
                    {runAsKind === 'gmsa' ? 'gMSA (DOMAIN\\name$)' : 'Username (DOMAIN\\user)'}
                  </Label>
                  <Input
                    id="runAsUser"
                    placeholder={runAsKind === 'gmsa' ? 'CONTOSO\\dscgmsa$' : 'CONTOSO\\dscop'}
                    value={runAsUser}
                    onChange={(e) => setRunAsUser(e.target.value)}
                  />
                </div>
                {runAsKind === 'password' && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="runAsPassword">Password</Label>
                    <Input
                      id="runAsPassword"
                      type="password"
                      autoComplete="new-password"
                      value={runAsPassword}
                      onChange={(e) => setRunAsPassword(e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
            {runAsErr && <span className="text-xs text-destructive">{runAsErr}</span>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createServer.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createServer.isPending}>
              {createServer.isPending ? 'Adding…' : 'Add server'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
