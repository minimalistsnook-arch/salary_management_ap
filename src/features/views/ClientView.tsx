import { useMemo, useState } from 'react';
import { buildMonthCell, effectiveStartMonth, type GridAllocation, type MonthCell } from '../../domain/advisoryGrid';
import type { AdvisoryResponse } from '../../domain/dto';
import { addMonths, shortDate } from '../../domain/month';
import { normalizeName } from '../../domain/normalize';
import { Badge, Card, cx, EmptyState, inputCls, won } from '../common/ui';

const STATE_LABEL: Record<MonthCell['state'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  PAID: { label: '완납', tone: 'green' },
  PARTIAL: { label: '부분납', tone: 'amber' },
  UNPAID: { label: '미납', tone: 'red' },
  FUTURE: { label: '예정', tone: 'slate' },
  NOT_MANAGED: { label: '-', tone: 'slate' },
};

/** 거래처별 보기: 관리 시작월부터 월별 납부 내역 */
export function ClientView({ data, initialClientId }: { data: AdvisoryResponse; initialClientId?: number | null }) {
  const [clientId, setClientId] = useState<number | null>(initialClientId ?? data.clients[0]?.id ?? null);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const nq = normalizeName(q);
    return data.clients.filter((c) => !nq || normalizeName(c.name).includes(nq)).sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name), 'ko'));
  }, [data.clients, q]);
  const client = data.clients.find((c) => c.id === clientId) ?? null;
  const allocs = useMemo(() => data.allocations.filter((a) => a.client_id === clientId), [data.allocations, clientId]);

  const cells = useMemo(() => {
    if (!client) return [];
    const start = effectiveStartMonth(client, allocs);
    if (!start) return [];
    const last = [data.currentMonth, ...allocs.map((a) => a.service_month)].sort().pop() as string;
    const grouped = new Map<string, GridAllocation[]>();
    for (const a of [...allocs].sort((x, y) => x.id - y.id)) grouped.set(a.service_month, [...(grouped.get(a.service_month) ?? []), a]);
    const out: MonthCell[] = [];
    for (let m = start, i = 0; m <= last && i < 360; m = addMonths(m, 1), i++) out.push(buildMonthCell(client, m, grouped.get(m) ?? [], start, data.currentMonth));
    return out.reverse();
  }, [client, allocs, data.currentMonth]);

  const outstanding = cells.filter((c) => c.month <= data.currentMonth && (c.state === 'UNPAID' || c.state === 'PARTIAL')).reduce((s, c) => s + c.due - c.paid, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card title="거래처" bodyClassName="p-0">
        <div className="border-b border-slate-200 p-2">
          <input className={inputCls} placeholder="거래처 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-1">
          {list.map((c) => (
            <li key={c.id}>
              <button onClick={() => setClientId(c.id)} className={cx('w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50', c.id === clientId && 'bg-blue-50 font-medium text-blue-800')}>
                {c.name}
                {!c.active && <span className="ml-1 text-xs text-slate-400">(비활성)</span>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title={client ? client.name : '거래처를 선택하세요'}
        actions={
          client && (
            <div className="flex flex-wrap gap-3 text-sm text-slate-600">
              <span>
                계약금액 <b className="text-slate-900 tabular-nums">{won(client.current_contract_amount)}</b>
              </span>
              <span>관리 시작월 {client.management_start_month ?? '미지정'}</span>
              <span>
                미수금 <b className={cx('tabular-nums', outstanding ? 'text-rose-700' : 'text-slate-900')}>{won(outstanding)}</b>
              </span>
            </div>
          )
        }
        bodyClassName="p-0"
      >
        {!client ? null : !cells.length ? (
          <EmptyState>기존 기록과 관리 시작월이 없습니다 — 월 배정 필요. 설정 &gt; 거래처 마스터에서 관리 시작월을 지정하세요.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr className="text-left">
                <th className="px-4 py-2">적용월</th>
                <th className="px-4 py-2 text-right">계약금액</th>
                <th className="px-4 py-2 text-right">납부액</th>
                <th className="px-4 py-2">입금일</th>
                <th className="px-4 py-2">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cells.map((c) => (
                <tr key={c.month}>
                  <td className="px-4 py-2 font-medium tabular-nums">{c.month}</td>
                  <td className="px-4 py-2 text-right text-slate-500 tabular-nums">{won(c.due)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{c.paid ? won(c.paid) : '-'}</td>
                  <td className="px-4 py-2 text-slate-600 tabular-nums">
                    {c.payments.map((p) => `${shortDate(p.payment_date)}${c.payments.length > 1 ? ` (${won(p.allocated_amount)})` : ''}`).join(', ') || '-'}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={STATE_LABEL[c.state].tone}>{STATE_LABEL[c.state].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
