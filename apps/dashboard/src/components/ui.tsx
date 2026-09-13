import type { DataOrigin } from '@cas/contracts';

import { safeText } from '../server/display.ts';
import { isErrorNotice, noticeFor } from '../app/notices.ts';

/** The data origin, shown on every record the dashboard renders. */
export function Origin({ value }: { readonly value: DataOrigin }) {
  return <span className={`origin origin-${value}`}>{value}</span>;
}

/** Hostile stored text, escaped and bounded. */
export function Text({
  value,
  max,
}: {
  readonly value: unknown;
  readonly max?: number | undefined;
}) {
  return <>{safeText(value, max)}</>;
}

export function Notice({ code }: { readonly code: unknown }) {
  const message = noticeFor(code);
  if (message === null) return null;
  return <p className={isErrorNotice(code) ? 'notice notice-error' : 'notice'}>{message}</p>;
}

export function Limitation({ children }: { readonly children: React.ReactNode }) {
  return <p className="limitation">{children}</p>;
}

export function Csrf({ token }: { readonly token: string }) {
  return <input type="hidden" name="csrfToken" value={token} />;
}

export function Instant({ value }: { readonly value: string | null }) {
  return <span className="mono">{value ?? '—'}</span>;
}
