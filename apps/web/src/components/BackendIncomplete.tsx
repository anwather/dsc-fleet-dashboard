import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  feature: string;
  className?: string;
}

/** Friendly placeholder when the API returns 501. */
export function BackendIncomplete({ feature, className }: Props) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm',
        className,
      )}
    >
      <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400" />
      <div>
        <div className="font-medium">{feature} — backend not yet wired</div>
        <div className="text-muted-foreground">
          The matching API endpoint returned <code>501 Not Implemented</code>. The other agent is
          still building this. The UI will start working as soon as the backend lands.
        </div>
      </div>
    </div>
  );
}
