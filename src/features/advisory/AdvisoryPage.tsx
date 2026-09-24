import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { buildClientYearRow, type ClientYearRow, type GridAllocation, type MonthCell } from '../../domain/advisoryGrid';
import { shortDate } from '../../domain/month';
import { normalizeName } from '../../domain/normalize';
import type { Client } from '../../domain/types';
import { api, errorMessage } from '../../services/api';
import { Badge, Button, CELL_CLASS, cx, EmptyState, ErrorBox, Field, inputBase, inputCls, Overlay, SegmentedControl, Spinner, toast, useAsync, won } from '../common/ui';
import { TransactionDrawer } from '../transactions/TransactionDrawer';
import { ClientView } from '../views/ClientView';
import { MonthlyView } from '../views/MonthlyView';

type Filter = 'ALL' | 'PAID' | 'UNPAID' | 'PARTIAL';
type View = 'grid' | 'monthly' | 'client';

function CellContent({ cell }: { cell: MonthCell }) {
  const dates = [...new Set(cell.payments.map((p) => shortDate(p.payment_date)))];
  switch (cell.state) {
    case 'PAID':
      return (
        <>
          <div className="font-medium">{dates.join(', ')}</div>
          <div className="text-[11px] opacity-75">{won(cell.paid)}</div>
        </>
      );
    case 'PARTIAL':
      return (
        <>
          <div className="font-medium">{dates.join(', ')}</div>
          <div className="text-[11px]">
            {won(cell.paid)} / {won(cell.due)}
          </div>
        </>
      );
    case 'UNPAID':
      return (
        <>
          <div className="font-medium">미납</div>
          <div className="text-[11px] opacity-75">{won(cell.due)}</div>
        </>
      );
    case 'FUTURE':
      return <div className="text-[11px]">-</div>;
    default:
      return <div>·</div>;
  }
}

export function AdvisoryPage() {
  const { dataVersion, bumpData, reloadClients } = useApp();
  const [params, setParams] = useSearchParams();
  const thisYear = new Date().getFullYear();
  const year = Number(params.get('year') ?? thisYear);
  const filter = (params.get('filter') as Filter) || 'ALL';
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('grid');
  const [cellOpen, setCellOpen] = useState<{ row: ClientYearRow; cell: MonthCell } | null>(null);
  const [startFor, setStartFor] = useState<Client | null>(null);
  const [txOpen, setTxOpen] = useState<number | null>(null);
  const { data, error, loading, reload } = useAsync(() => api.advisory(year), [year, dataVersion]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const byClient = new Map<number, GridAllocation[]>();
    for (const a of data.allocations) byClient.set(a.client_id, [...(byClient.get(a.client_id) ?? []), a]);
    return data.clients
      .map((c) => buildClientYearRow(c, byClient.get(c.id) ?? [], year, data.currentMonth))
      .sort((a, b) => normalizeName(a.client.name).localeCompare(normalizeName(b.client.name), 'ko'));
  }, [data, year]);

  const visible = useMemo(() => {
    const nq = normalizeName(q);
    return rows.filter((r) => {
      if (nq && !normalizeName(r.client.name).includes(nq) && !r.client.name.includes(q.trim())) return false;
      if (filter === 'PAID') return r.isFullyPaid;
      if (filter === 'UNPAID') return r.hasUnpaid;
      if (filter === 'PARTIAL') return r.hasPartial;
      return true;
    });
  }, [rows, q, filter]);

  const totals = visible.reduce((s, r) => ({ due: s.due + r.annualDue, paid: s.paid + r.annualPaid, recv: s.recv + r.receivable }), { due: 0, paid: 0, recv: 0 });
  const monthTotals = Array.from({ length: 12 }, (_, i) => visible.reduce((s, r) => s + r.cells[i].paid, 0));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" onClick={() => setParam('year', String(year - 1))}>
            ‹ {year - 1}
          </Button>
          <span className="px-3 text-lg font-semibold tabular-nums">{year}</span>
          <Button variant="ghost" onClick={() => setParam('year', String(year + 1))}>
            {year + 1} ›
          </Button>
        </div>
        <input className={cx(inputBase, 'w-56')} placeholder="거래처 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <SegmentedControl
          value={filter}
          onChange={(v) => setParam('filter', v === 'ALL' ? null : v)}
          options={[
            { value: 'ALL', label: '전체' },
            { value: 'PAID', label: '완납' },
            { value: 'UNPAID', label: '미납' },
            { value: 'PARTIAL', label: '부분납' },
          ]}
        />
        <div className="ml-auto">
          <SegmentedControl
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: '연간 현황' },
              { value: 'monthly', label: '월별 보기' },
              { value: 'client', label: '거래처별 보기' },
            ]}
          />
        </div>
      </div>

      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : !data ? null : view === 'monthly' ? (
        <MonthlyView data={data} initialMonth={year === thisYear ? data.currentMonth : `${year}-12`} />
      ) : view === 'client' ? (
        <ClientView data={data} />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 text-sm">
            <span>
              거래처 {visible.length}곳 · 연간 계약 <b className="tabular-nums">{won(totals.due)}</b> · 연간 입금 <b className="tabular-nums">{won(totals.paid)}</b> · 미수금{' '}
              <b className={cx('tabular-nums', totals.recv > 0 && 'text-rose-700')}>{won(totals.recv)}</b>
            </span>
            <span className="flex flex-wrap gap-2 text-xs text-slate-500">
              <span className={cx('rounded px-1.5', CELL_CLASS.PAID)}>완납</span>
              <span className={cx('rounded px-1.5', CELL_CLASS.PARTIAL)}>부분납</span>
              <span className={cx('rounded px-1.5', CELL_CLASS.UNPAID)}>미납</span>
              <span className="rounded border border-slate-200 px-1.5">향후</span>
              <span className={cx('rounded px-1.5', CELL_CLASS.NOT_MANAGED)}>관리 전</span>
            </span>
          </div>
          {!visible.length ? (
            <EmptyState>{data.clients.length ? '조건에 맞는 거래처가 없습니다.' : '거래처가 없습니다. [거래처 정보 새로고침]을 먼저 실행하세요.'}</EmptyState>
          ) : (
            <div className="max-h-[calc(100vh-260px)] overflow-auto">
              <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-20 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="sticky left-0 z-30 w-56 min-w-56 border-r border-b border-slate-200 bg-slate-50 px-3 py-2 text-left">거래처명</th>
                    <th className="border-b border-slate-200 px-2 py-2 text-right">월 계약금액</th>
                    {Array.from({ length: 12 }, (_, i) => (
                      <th key={i} className={cx('w-[84px] min-w-[84px] border-b border-slate-200 px-1 py-2 text-center', `${year}-${String(i + 1).padStart(2, '0')}` === data.currentMonth && 'text-blue-700')}>
                        {i + 1}월
                      </th>
                    ))}
                    <th className="border-b border-l border-slate-200 px-2 py-2 text-right">연간 계약금액</th>
                    <th className="border-b border-slate-200 px-2 py-2 text-right">연간 입금액</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">미수금</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.client.id} className="group">
                      <td className="sticky left-0 z-10 border-r border-b border-slate-200 bg-white px-3 py-1.5 group-hover:bg-slate-50">
                        <div className="truncate font-medium" title={r.client.name}>
                          {r.client.name}
                        </div>
                        {!r.effectiveStart ? (
                          <button className="text-xs text-violet-700 hover:underline" onClick={() => setStartFor(r.client as Client)}>
                            월 배정 필요 · 관리 시작월 지정
                          </button>
                        ) : (
                          !(r.client as Client).active && <Badge>비활성</Badge>
                        )}
                      </td>
                      <td className="border-b border-slate-200 px-2 py-1.5 text-right text-slate-600 tabular-nums">{won(r.client.current_contract_amount)}</td>
                      {r.cells.map((c) => (
                        <td key={c.month} className="border-b border-l border-slate-100 border-b-slate-200 p-0">
                          <button
                            onClick={() => setCellOpen({ row: r, cell: c })}
                            className={cx('block h-full min-h-[44px] w-full px-1 py-1 text-center leading-tight tabular-nums hover:ring-2 hover:ring-blue-300 hover:ring-inset', CELL_CLASS[c.state])}
                          >
                            <CellContent cell={c} />
                          </button>
                        </td>
                      ))}
                      <td className="border-b border-l border-slate-200 px-2 py-1.5 text-right tabular-nums">{won(r.annualDue)}</td>
                      <td className="border-b border-slate-200 px-2 py-1.5 text-right tabular-nums">{won(r.annualPaid)}</td>
                      <td className={cx('border-b border-slate-200 px-3 py-1.5 text-right font-medium tabular-nums', r.receivable > 0 ? 'text-rose-700' : 'text-slate-400')}>{won(r.receivable)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 z-20 bg-slate-100 text-xs font-medium">
                  <tr>
                    <td className="sticky left-0 z-30 border-t border-r border-slate-300 bg-slate-100 px-3 py-2">합계 (입금)</td>
                    <td className="border-t border-slate-300" />
                    {monthTotals.map((v, i) => (
                      <td key={i} className="border-t border-slate-300 px-1 py-2 text-center tabular-nums">
                        {v ? won(v) : ''}
                      </td>
                    ))}
                    <td className="border-t border-l border-slate-300 px-2 py-2 text-right tabular-nums">{won(totals.due)}</td>
                    <td className="border-t border-slate-300 px-2 py-2 text-right tabular-nums">{won(totals.paid)}</td>
                    <td className="border-t border-slate-300 px-3 py-2 text-right text-rose-700 tabular-nums">{won(totals.recv)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {cellOpen && data && (
        <Overlay open variant="modal" onClose={() => setCellOpen(null)} title={`${cellOpen.row.client.name} · ${cellOpen.cell.month}`}>
          <CellDetail
            cell={cellOpen.cell}
            allocations={data.allocations}
            onOpenTx={(id) => {
              setCellOpen(null);
              setTxOpen(id);
            }}
          />
        </Overlay>
      )}
      {startFor && (
        <StartMonthDialog
          client={startFor}
          onClose={() => setStartFor(null)}
          onSaved={async () => {
            setStartFor(null);
            await reloadClients();
            bumpData();
          }}
        />
      )}
      {txOpen !== null && <TransactionDrawer id={txOpen} onClose={() => setTxOpen(null)} onChanged={bumpData} />}
    </div>
  );
}

function CellDetail({ cell, allocations, onOpenTx }: { cell: MonthCell; allocations: { id: number; sender_raw: string | null }[]; onOpenTx: (id: number) => void }) {
  const status = { PAID: '완납', PARTIAL: '부분납', UNPAID: '미납', FUTURE: '향후 월', NOT_MANAGED: '관리 시작 전' }[cell.state];
  const sender = new Map(allocations.map((a) => [a.id, a.sender_raw]));
  return (
    <div className="space-y-3 text-sm">
      <div className={cx('rounded-md px-3 py-2', CELL_CLASS[cell.state])}>
        <b>{status}</b> {cell.state !== 'NOT_MANAGED' && <span className="tabular-nums">· {won(cell.paid)} / {won(cell.due)}원</span>}
        {cell.state === 'PARTIAL' && <span className="ml-1">(잔액 {won(cell.due - cell.paid)}원)</span>}
      </div>
      {cell.payments.length ? (
        <table className="w-full">
          <thead className="text-xs text-slate-500">
            <tr className="text-left">
              <th className="py-1">입금일</th>
              <th className="py-1 text-right">금액</th>
              <th className="py-1 pl-3">통장 원본명</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cell.payments.map((p) => (
              <tr key={p.id}>
                <td className="py-1.5 tabular-nums">{p.payment_date}</td>
                <td className="py-1.5 text-right tabular-nums">{won(p.allocated_amount)}</td>
                <td className="py-1.5 pl-3 text-slate-600">{p.source === 'LEGACY' ? '기존 Excel 가져오기' : (sender.get(p.id) ?? '-')}</td>
                <td className="py-1.5 text-right">
                  {p.transaction_id && (
                    <Button size="sm" variant="ghost" onClick={() => onOpenTx(p.transaction_id as number)}>
                      거래 보기
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-slate-500">이 달에 배정된 입금이 없습니다.</p>
      )}
    </div>
  );
}

export function StartMonthDialog({ client, onClose, onSaved }: { client: Client; onClose: () => void; onSaved: () => void }) {
  const [month, setMonth] = useState(client.management_start_month ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.setStartMonth(client.id, month || null);
      toast('관리 시작월 저장');
      onSaved();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay
      open
      variant="modal"
      onClose={onClose}
      title={`관리 시작월 — ${client.name}`}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            저장
          </Button>
        </>
      }
    >
      <Field label="관리 시작월" hint="이 월부터 미납 여부를 계산하고, 이후 입금을 가장 오래된 미납월부터 자동 배정합니다. 이미 배정된 내역은 바뀌지 않습니다.">
        <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />
      </Field>
    </Overlay>
  );
}
