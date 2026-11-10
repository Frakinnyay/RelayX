import type { DeliveryStatus } from '../types';

export const Badge = ({ status }: { status: DeliveryStatus | string | null }) => (
  <span className={`badge ${status ?? ''}`}>{status ?? '—'}</span>
);

export const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleTimeString() : '—');

export function countdown(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  return s > 0 ? `in ${s}s` : 'due now';
}

export const ErrorLine = ({ error }: { error: string | undefined }) => (error ? <p className="err">{error}</p> : null);
