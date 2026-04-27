import { relativeTime } from '@/lib/utils';

export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  return (
    <span title={iso ?? 'never'} className="tabular-nums">
      {relativeTime(iso)}
    </span>
  );
}
