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
  const [labelsErr, setLabelsErr] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const createServer = useMutation({
    mutationFn: async (body: ServerCreate) => {
      const server = await apiPost<ServerSummary>('/servers', body);
      // Best-effort: kick off provision token + provision job. Both endpoints
      // may still be 501 — surface only a "queued" toast in that case.
      try {
        await apiPost(`/servers/${server.id}/provision`, {});
      } catch (e) {
        if (!(e instanceof ApiError && e.notImplemented)) throw e;
      }
      return server;
    },
    onSuccess: (server) => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast({
        title: 'Server added',
        description: `${server.name} queued for provisioning.`,
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
    setLabelsErr(null);
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

    createServer.mutate({
      azureSubscriptionId: form.azureSubscriptionId.trim(),
      azureResourceGroup: form.azureResourceGroup.trim(),
      azureVmName: form.azureVmName.trim(),
      name: form.name.trim() || undefined,
      labels,
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
