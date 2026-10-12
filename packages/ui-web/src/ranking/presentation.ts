export function formatRankingDateTime(value?: string | number | Date | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate()
    .toString()
    .padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

/** Hosts keep their native error types; classify only stable public status/code fields. */
export function isMissingRankingArchive(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.code === 'not-found' || value.status === 404;
}
