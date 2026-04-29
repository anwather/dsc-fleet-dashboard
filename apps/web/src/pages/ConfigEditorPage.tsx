import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, AlertTriangle, Save, CheckCircle2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MonacoYamlEditor, type MonacoYamlEditorHandle } from '@/components/MonacoYamlEditor';
import { useToast } from '@/components/ToastProvider';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError, softFetch } from '@/lib/api';
import { SAMPLES, BLANK_YAML, type Sample } from '@/lib/samples';
import { cn } from '@/lib/utils';
import type {
  ConfigSummary,
  ConfigRevisionDetail,
  YamlParseResult,
  RequiredModule,
} from '@dsc-fleet/shared-types';

export function ConfigEditorPage() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  // ---- Existing config (when editing) -------------------------------------
  const existing = useQuery<ConfigSummary | null>({
    queryKey: ['config', id],
    queryFn: () => softFetch(() => apiGet<ConfigSummary>(`/configs/${id}`)),
    enabled: !isNew,
  });

  const existingRevision = useQuery<ConfigRevisionDetail | null>({
    queryKey: ['configRevision', id, existing.data?.currentRevision?.id],
    queryFn: () => {
      const revId = existing.data?.currentRevision?.id;
      if (!revId) return null;
      return softFetch(() => apiGet<ConfigRevisionDetail>(`/configs/${id}/revisions/${revId}`));
    },
    enabled: !isNew && !!existing.data?.currentRevision?.id,
  });

  // ---- Form state ---------------------------------------------------------
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [yaml, setYaml] = useState(BLANK_YAML);
  const [parseResult, setParseResult] = useState<YamlParseResult | null>(null);
  const [activeSample, setActiveSample] = useState<Sample | null>(null);
  const editorRef = useRef<MonacoYamlEditorHandle | null>(null);

  // Format the current YAML in Monaco, sync the formatted text into our
  // state, and return it. Called before validate/save so users can't trip
  // on YAML alignment mistakes the formatter would have fixed.
  const formatNow = async () => {
    const formatted = (await editorRef.current?.format()) ?? yaml;
    if (formatted !== yaml) setYaml(formatted);
    return formatted;
  };

  // Hydrate when existing config loads.
  useEffect(() => {
    if (!isNew && existing.data) {
      setName(existing.data.name);
      setDescription(existing.data.description ?? '');
    }
  }, [isNew, existing.data]);

  useEffect(() => {
    if (!isNew && existingRevision.data) {
      setYaml(existingRevision.data.yamlBody);
    }
  }, [isNew, existingRevision.data]);

  // ---- Mutations ----------------------------------------------------------
  const validate = useMutation({
    mutationFn: async (body: string) =>
      apiPost<YamlParseResult>('/configs/parse', { yamlBody: body }),
    onSuccess: (r) => setParseResult(r),
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.notImplemented) {
        toast({
          title: 'Validation unavailable',
          description: 'POST /configs/parse not yet implemented on the API.',
          variant: 'info',
        });
      } else {
        toast({
          title: 'Validation failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        });
      }
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        return apiPost<ConfigSummary>('/configs', {
          name: name.trim(),
          description: description.trim() || undefined,
          yamlBody: yaml,
        });
      }
      return apiPatch<ConfigSummary>(`/configs/${id}`, {
        name: name.trim(),
        description: description.trim() || undefined,
        yamlBody: yaml,
      });
    },
    onSuccess: (c) => {
      toast({ title: isNew ? 'Config created' : 'Config saved', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['configs'] });
      qc.invalidateQueries({ queryKey: ['config', c.id] });
      if (isNew) navigate(`/configs/${c.id}`);
    },
    onError: (e: unknown) => {
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    },
  });

  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => apiDelete(`/configs/${id}`),
    onSuccess: () => {
      toast({
        title: 'Config removed',
        description: existing.data?.name ? `${existing.data.name} hidden. Revision history retained.` : undefined,
        variant: 'success',
      });
      qc.invalidateQueries({ queryKey: ['configs'] });
      navigate('/configs');
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError && e.body && typeof e.body === 'object' && 'message' in e.body
          ? String((e.body as { message?: unknown }).message ?? e.message)
          : e instanceof Error
            ? e.message
            : 'Failed to remove config';
      toast({ title: 'Remove failed', description: msg, variant: 'destructive' });
      setRemoveOpen(false);
    },
  });

  // Required modules — prefer last validate result, fall back to existing.
  const requiredModules: RequiredModule[] =
    parseResult?.requiredModules ?? existing.data?.currentRevision?.requiredModules ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Link
            to="/configs"
            className="text-sm text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> back to configs
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {isNew ? 'New configuration' : `Edit ${existing.data?.name ?? '…'}`}
          </h1>
        </div>
        {!isNew && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRemoveOpen(true)}
            title="Soft-delete this config"
          >
            <Trash2 className="h-4 w-4" /> Remove
          </Button>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400" />
        <div>
          <strong>Do not store secrets in YAML.</strong> Database backups contain config content
          verbatim. Use a secret store and reference at apply time.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
        {/* Left rail: samples */}
        <div className="space-y-3">
          <div className="text-sm font-medium text-muted-foreground">Start from sample</div>
          {SAMPLES.map((s) => (
            <Card key={s.id} className="overflow-hidden">
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm leading-tight">{s.title}</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <div className="text-xs text-muted-foreground">{s.blurb}</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setActiveSample(s)}
                >
                  Use this
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Center: editor */}
        <div className="flex flex-col h-[70vh] min-h-[500px]">
          <div className="mb-2 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => validate.mutate(await formatNow())}
              disabled={validate.isPending}
            >
              <CheckCircle2 className="h-4 w-4" />
              {validate.isPending ? 'Validating…' : 'Validate'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || name.trim().length === 0}
              title={
                name.trim().length === 0
                  ? 'Enter a name in the right-hand panel before saving.'
                  : undefined
              }
            >
              <Save className="h-4 w-4" />
              {save.isPending ? 'Saving…' : isNew ? 'Create' : 'Save new revision'}
            </Button>
            {name.trim().length === 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Name required to save →
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <MonacoYamlEditor ref={editorRef} value={yaml} onChange={setYaml} />
          </div>
        </div>

        {/* Right: metadata + parse result */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cfg-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cfg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="baseline-registry"
              aria-invalid={name.trim().length === 0}
            />
            {name.trim().length === 0 && (
              <p className="text-xs text-muted-foreground">
                Required. The Create button is disabled until you fill this in.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="cfg-desc">Description</Label>
            <Textarea
              id="cfg-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this config do?"
            />
          </div>

          <div className="space-y-2">
            <Label>Required modules</Label>
            {requiredModules.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                None detected. Click <em>Validate</em> to refresh.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {requiredModules.map((m) => (
                  <Badge key={m.name} variant="info">
                    {m.name}
                    {m.minVersion ? ` ≥ ${m.minVersion}` : ''}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {parseResult && parseResult.errors.length > 0 && (
            <div className="space-y-1">
              <Label className="text-destructive">Errors</Label>
              <ul className="text-xs text-destructive space-y-1">
                {parseResult.errors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}
          {parseResult && parseResult.warnings.length > 0 && (
            <div className="space-y-1">
              <Label className="text-amber-600">Warnings</Label>
              <ul className="text-xs text-amber-700 space-y-1">
                {parseResult.warnings.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <SampleFormDialog
        sample={activeSample}
        onClose={() => setActiveSample(null)}
        onApply={(rendered) => {
          setYaml(rendered);
          setActiveSample(null);
          toast({ title: 'Sample applied to editor', variant: 'success' });
        }}
      />

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove config?"
        description={
          <span>
            <span className="font-medium">{existing.data?.name ?? 'This config'}</span> will be
            hidden from all lists. Revisions and run history are kept in the database (soft-delete).
            The API rejects this if the config still has active or pending-removal assignments —
            remove those first.
          </span>
        }
        confirmLabel="Remove config"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

interface SampleFormDialogProps {
  sample: Sample | null;
  onClose: () => void;
  onApply: (yaml: string) => void;
}

function SampleFormDialog({ sample, onClose, onApply }: SampleFormDialogProps) {
  const [values, setValues] = useState<Record<string, string | number>>({});

  // Reset values whenever the sample changes.
  useEffect(() => {
    if (!sample) return;
    const init: Record<string, string | number> = {};
    for (const f of sample.fields) init[f.name] = f.default;
    setValues(init);
  }, [sample]);

  if (!sample) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{sample.title}</DialogTitle>
        </DialogHeader>
        <div className={cn('space-y-3 max-h-[60vh] overflow-auto pr-1')}>
          {sample.fields.map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={`f-${f.name}`}>{f.label}</Label>
              {f.type === 'select' ? (
                <Select
                  value={String(values[f.name] ?? f.default)}
                  onValueChange={(v) => setValues((c) => ({ ...c, [f.name]: v }))}
                >
                  <SelectTrigger id={`f-${f.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.options ?? []).map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea
                  id={`f-${f.name}`}
                  rows={4}
                  value={String(values[f.name] ?? '')}
                  onChange={(e) => setValues((c) => ({ ...c, [f.name]: e.target.value }))}
                />
              ) : (
                <Input
                  id={`f-${f.name}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={String(values[f.name] ?? '')}
                  onChange={(e) => setValues((c) => ({ ...c, [f.name]: e.target.value }))}
                  placeholder={f.placeholder}
                  required={f.required}
                />
              )}
              {f.helpText && <div className="text-xs text-muted-foreground">{f.helpText}</div>}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onApply(sample.render(values))}>Insert into editor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
