import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CellState } from '../../domain/advisoryGrid';
import { MATCH_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '../../domain/labels';
import type { MatchStatus, PaymentStatus } from '../../domain/types';
import { errorMessage } from '../../services/api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const won = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('ko-KR'));

export function localDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 border-blue-700',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
  danger: 'bg-white text-rose-700 hover:bg-rose-50 border-rose-300',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800 border-emerald-700',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
const TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200',
};
export function Badge({ tone = 'slate', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONES[tone])}>
      {children}
    </span>
  );
}

const MATCH_TONE: Record<MatchStatus, Tone> = { AUTO_MATCHED: 'blue', MANUAL_MATCHED: 'violet', REVIEW_REQUIRED: 'amber', UNMATCHED: 'red' };
export const MatchBadge = ({ status }: { status: MatchStatus }) => <Badge tone={MATCH_TONE[status]}>{MATCH_STATUS_LABEL[status]}</Badge>;

const PAY_TONE: Record<PaymentStatus, Tone> = { PAID: 'green', PARTIAL: 'amber', UNPAID: 'red' };
export const PayBadge = ({ status }: { status: PaymentStatus }) => <Badge tone={PAY_TONE[status]}>{PAYMENT_STATUS_LABEL[status]}</Badge>;

export const CELL_CLASS: Record<CellState, string> = {
  PAID: 'bg-emerald-50 text-emerald-900',
  PARTIAL: 'bg-amber-50 text-amber-900',
  UNPAID: 'bg-rose-50 text-rose-800',
  FUTURE: 'bg-white text-slate-400',
  NOT_MANAGED: 'bg-slate-50 text-slate-300',
};

export function ScoreText({ score }: { score: number }) {
  return <span className={cx('tabular-nums', score >= 70 ? 'text-slate-800' : score >= 50 ? 'text-amber-700' : 'text-rose-700')}>{score}%</span>;
}

export function Spinner({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-700" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm whitespace-pre-line text-rose-800">
      <span>{typeof error === 'string' ? error : errorMessage(error)}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'blue', children }: { tone?: 'blue' | 'amber' | 'green'; children: ReactNode }) {
  const cls = { blue: 'border-blue-200 bg-blue-50 text-blue-900', amber: 'border-amber-200 bg-amber-50 text-amber-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900' }[tone];
  return <div className={cx('rounded-md border px-4 py-3 text-sm', cls)}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}

/** 오른쪽 drawer 또는 가운데 modal */
export function Overlay({ open, onClose, title, children, variant = 'drawer', footer, width }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; variant?: 'drawer' | 'modal'; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div
        className={cx(
          'relative flex max-h-full flex-col bg-white shadow-xl',
          variant === 'drawer' ? 'ml-auto h-full w-full' : 'm-auto max-h-[90vh] w-full rounded-lg',
          width ?? (variant === 'drawer' ? 'max-w-2xl' : 'max-w-lg'),
        )}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputBase = 'block h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-800 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 focus:outline-none';
export const inputCls = `${inputBase} w-full`;

export function SegmentedControl<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded px-3 py-1 text-sm whitespace-nowrap', value === o.value ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 비동기 로딩 상태 훅 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await run();
      if (id === seq.current) setData(d);
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** 가벼운 토스트 */
let pushToast: ((msg: string, tone?: 'ok' | 'err') => void) | null = null;
export function toast(msg: string, tone: 'ok' | 'err' = 'ok') {
  pushToast?.(msg, tone);
}
export function ToastHost() {
  const [items, setItems] = useState<{ id: number; msg: string; tone: 'ok' | 'err' }[]>([]);
  useEffect(() => {
    pushToast = (msg, tone = 'ok') => {
      const id = Date.now() + Math.random();
      setItems((s) => [...s, { id, msg, tone }]);
      setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), tone === 'err' ? 7000 : 3500);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {items.map((i) => (
        <div key={i.id} className={cx('max-w-sm rounded-md px-4 py-2.5 text-sm whitespace-pre-line text-white shadow-lg', i.tone === 'ok' ? 'bg-slate-800' : 'bg-rose-700')}>
          {i.msg}
        </div>
      ))}
    </div>
  );
}
