import type { DashboardResponse } from '../../domain/dto';
import { cx, won } from '../common/ui';

export type SummaryKey = 'monthDeposit' | 'monthWithdrawal' | 'unmatched' | 'partial' | 'unpaidClients';

export function SummaryCards({ data, active, onSelect }: { data: DashboardResponse | null; active?: SummaryKey | null; onSelect: (k: SummaryKey) => void }) {
  const [y, m] = (data?.currentMonth ?? '').split('-');
  const cards: { key: SummaryKey; label: string; value: string; unit: string; tone: string }[] = [
    { key: 'monthDeposit', label: `이번 달 총 입금${m ? ` (${Number(m)}월)` : ''}`, value: won(data?.monthDeposit), unit: '원', tone: 'text-slate-900' },
    { key: 'monthWithdrawal', label: '이번 달 총 출금', value: won(data?.monthWithdrawal), unit: '원', tone: 'text-slate-900' },
    { key: 'unmatched', label: '개별건 (매칭 안 된 입금)', value: won(data?.unmatchedCount), unit: '건', tone: data?.unmatchedCount ? 'text-rose-700' : 'text-slate-900' },
    { key: 'partial', label: '부분납 거래', value: won(data?.partialTxCount), unit: '건', tone: data?.partialTxCount ? 'text-amber-700' : 'text-slate-900' },
    { key: 'unpaidClients', label: '미납 거래처', value: won(data?.unpaidClientCount), unit: '곳', tone: data?.unpaidClientCount ? 'text-rose-700' : 'text-slate-900' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((c) => (
        <button
          key={c.key}
          onClick={() => onSelect(c.key)}
          title={y ? `${y}년 기준` : undefined}
          className={cx('rounded-lg border bg-white px-4 py-3 text-left transition-colors hover:border-blue-400', active === c.key ? 'border-blue-600 ring-2 ring-blue-100' : 'border-slate-200')}
        >
          <div className="text-xs text-slate-500">{c.label}</div>
          <div className={cx('mt-1 text-xl font-semibold tabular-nums', c.tone)}>
            {data ? c.value : '…'}
            <span className="ml-0.5 text-sm font-normal text-slate-500">{c.unit}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
