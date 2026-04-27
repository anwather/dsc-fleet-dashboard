import { useIsFetching, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  /**
   * One or more react-query keys to invalidate on click. Each is matched as a
   * prefix (the same way react-query treats partial keys), so passing
   * `['servers']` invalidates `['servers']`, `['servers', { … }]`, etc.
   */
  queryKeys: QueryKey[];
  /** Optional override label; default is icon-only with sr-only "Refresh". */
  label?: string;
  className?: string;
  size?: 'default' | 'sm' | 'icon';
}

/**
 * Manual refresh control. Shows a spinning icon while any of the watched
 * queries are fetching (initial load or background revalidation).
 */
export function RefreshButton({ queryKeys, label, className, size = 'sm' }: Props) {
  const qc = useQueryClient();
  // useIsFetching returns the count of in-flight queries matching the predicate.
  const fetching = useIsFetching({
    predicate: (q) =>
      queryKeys.some((key) => {
        const k = q.queryKey;
        if (!Array.isArray(key) || !Array.isArray(k)) return false;
        if (k.length < key.length) return false;
        return key.every((part, i) => JSON.stringify(part) === JSON.stringify(k[i]));
      }),
  });
  const spinning = fetching > 0;

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      onClick={() => {
        for (const key of queryKeys) qc.invalidateQueries({ queryKey: key });
      }}
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw className={cn('h-4 w-4', spinning && 'animate-spin')} />
      {label ? <span>{label}</span> : <span className="sr-only">Refresh</span>}
    </Button>
  );
}
