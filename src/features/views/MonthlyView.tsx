import { useMemo, useState } from 'react';
import type { AdvisoryResponse } from '../../domain/dto';
import { monthOfDate, shortDate } from '../../domain/month';
import { Card, EmptyState, inputBase, won } from '../common/ui';

/** 월별 보기: 선택한 달에 들어온 입금이 몇 월분인지 */
export function MonthlyView({ data, initialMonth }: { data: AdvisoryResponse; initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const names = useMemo(() => new Map(data.clients.map((c) => [c.id, c.name])), [data.clients]);
  const rows = useMemo(
    () =>
      data.allocations
        .filter((a) => monthOfDate(a.payment_date) === month)
        .sort((a, b) => a.payment_date.localeCompare(b.payment_date) || (names.get(a.client_id) ?? '').localeCompare(names.get(b.client_id) ?? '', 'ko') || a.service_month.localeCompare(b.service_month)),
    [data.allocations, month, names],
  );
  const total = rows.reduce((s, r) => s + r.allocated_amount, 0);
  const [y, m] = month.split('-');
  return (
    <Card
      title={`${y}년 ${Number(m)}월 입금 · 월분 배정`}
      actions={<input type="month" className={`${inputBase} w-40`} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
      bodyClassName="p-0"
    >
      {!rows.length ? (
        <EmptyState>이 달에 배정된 입금이 없습니다.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr className="text-left">
              <th className="px-4 py-2">거래처</th>
              <th className="px-4 py-2">몇월분</th>
              <th className="px-4 py-2">입금일</th>
              <th className="px-4 py-2 text-right">입금액(배정)</th>
              <th className="px-4 py-2">통장 원본명</th>
              <th className="px-4 py-2">구분</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-medium">{names.get(r.client_id) ?? `#${r.client_id}`}</td>
                <td className="px-4 py-2 tabular-nums">{r.service_month}</td>
                <td className="px-4 py-2 tabular-nums">{shortDate(r.payment_date)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{won(r.allocated_amount)}</td>
                <td className="px-4 py-2 text-slate-600">{r.sender_raw ?? '-'}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{r.source === 'LEGACY' ? '기존 Excel' : r.source === 'MANUAL' ? '수동 배정' : '통장'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 font-medium">
            <tr>
              <td className="px-4 py-2" colSpan={3}>
                합계 {rows.length}건
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{won(total)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}
    </Card>
  );
}
