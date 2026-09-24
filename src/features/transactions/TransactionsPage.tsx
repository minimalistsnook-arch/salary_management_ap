import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import type { TransactionRow } from '../../domain/dto';
import { isIndividualCase, MATCH_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '../../domain/labels';
import { currentYearMonth } from '../../domain/month';
import { normalizeName } from '../../domain/normalize';
import type { MatchStatus, PaymentStatus } from '../../domain/types';
import { api } from '../../services/api';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, inputBase, inputCls, MatchBadge, PayBadge, ScoreText, SegmentedControl, Spinner, useAsync, won } from '../common/ui';
import { summaryLink } from '../dashboard/DashboardPage';
import { SummaryCards, type SummaryKey } from '../dashboard/SummaryCards';
import { ClientView } from '../views/ClientView';
import { MonthlyView } from '../views/MonthlyView';
import { BulkActionBar } from './BulkActionBar';
import { TransactionDrawer } from './TransactionDrawer';

type View = 'list' | 'monthly' | 'client';
const PAGE = 300;

function worstStatus(t: TransactionRow): PaymentStatus | null {
  if (!t.allocations.length) return null;
  if (t.allocations.some((a) => a.month_status === 'UNPAID')) return 'UNPAID';
  if (t.allocations.some((a) => a.month_status === 'PARTIAL')) return 'PARTIAL';
  return 'PAID';
}

export function TransactionsPage() {
  const navigate = useNavigate();
  const { dataVersion, clients, bumpData } = useApp();
  const [params, setParams] = useSearchParams();
  const now = currentYearMonth();

  const year = params.get('year') ?? (params.get('match') || params.get('partial') ? 'all' : now.slice(0, 4));
  const month = params.get('period') === 'this-month' ? now.slice(5) : (params.get('month') ?? '');
  const dir = params.get('dir') ?? '';
  const match = params.get('match') ?? '';
  const partial = params.get('partial') === '1';
  const clientFilter = params.get('client') ?? '';
  useEffect(() => {
    if (params.get('match') === 'NEEDS_REVIEW' || params.get('match') === 'REVIEW_REQUIRED' || params.get('match') === 'UNMATCHED') navigate('/case-fee', { replace: true });
  }, [params, navigate]);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('list');
  const [openId, setOpenId] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const toggle = (id: number, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const [limit, setLimit] = useState(PAGE);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    if ('month' in patch || 'year' in patch) next.delete('period');
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
    setLimit(PAGE);
  };

  const effectiveYear = params.get('period') === 'this-month' ? now.slice(0, 4) : year;
  const txs = useAsync(() => api.transactions(effectiveYear === 'all' ? undefined : Number(effectiveYear)), [effectiveYear, dataVersion]);
  const dash = useAsync(() => api.dashboard(), [dataVersion]);
  const advisory = useAsync(() => (view === 'list' ? Promise.resolve(null) : api.advisory(Number(effectiveYear === 'all' ? now.slice(0, 4) : effectiveYear))), [view, effectiveYear, dataVersion]);

  // 매칭되지 않은 입금은 '3. 개별건'으로 — 여기에는 거래처로 확정된 입금(과 출금)만
  const ledgerRows = useMemo(() => (txs.data ?? []).filter((t) => !isIndividualCase(t)), [txs.data]);
  const individualCount = (txs.data ?? []).length - ledgerRows.length;

  const filtered = useMemo(() => {
    const nq = normalizeName(q);
    return ledgerRows.filter((t) => {
      if (month && t.transaction_datetime.slice(5, 7) !== month) return false;
      if (dir === 'deposit' && !(t.deposit_amount > 0)) return false;
      if (dir === 'withdrawal' && !(t.withdrawal_amount > 0)) return false;
      if (match && t.match_status !== match) return false;
      if (partial && !t.allocations.some((a) => a.month_status === 'PARTIAL')) return false;
      if (clientFilter && String(t.client_id ?? '') !== clientFilter) return false;
      if (q.trim()) {
        const hay = [t.sender_raw, t.client_name ?? ''];
        if (!hay.some((h) => h.includes(q.trim()) || (nq && normalizeName(h).includes(nq)))) return false;
      }
      return true;
    });
  }, [ledgerRows, month, dir, match, partial, clientFilter, q]);

  const activeCard: SummaryKey | null = params.get('period') === 'this-month' ? (dir === 'withdrawal' ? 'monthWithdrawal' : 'monthDeposit') : partial ? 'partial' : null;
  const onCard = (k: SummaryKey) => {
    if (k === 'unpaidClients' || k === 'unmatched') return navigate(summaryLink(k));
    setParams(new URLSearchParams(summaryLink(k).split('?')[1]), { replace: true });
    setView('list');
  };

  const years = Array.from({ length: 6 }, (_, i) => String(Number(now.slice(0, 4)) + 1 - i));
  const totals = filtered.reduce((s, t) => ({ dep: s.dep + t.deposit_amount, wd: s.wd + t.withdrawal_amount }), { dep: 0, wd: 0 });

  return (
    <div className="space-y-4">
      <SummaryCards data={dash.data} active={activeCard} onSelect={onCard} />

      <Card bodyClassName="p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            연도
            <select className={cx(inputBase, 'mt-0.5 w-28')} value={effectiveYear} onChange={(e) => set({ year: e.target.value, month: params.get('period') ? month : null })}>
              <option value="all">전체</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            월
            <select className={cx(inputBase, 'mt-0.5 w-24')} value={month} onChange={(e) => set({ month: e.target.value, year: effectiveYear })}>
              <option value="">전체</option>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                <option key={m} value={m}>
                  {Number(m)}월
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            거래처
            <select className={cx(inputBase, 'mt-0.5 w-52')} value={clientFilter} onChange={(e) => set({ client: e.target.value })}>
              <option value="">전체</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            입금/출금
            <select className={cx(inputBase, 'mt-0.5 w-24')} value={dir} onChange={(e) => set({ dir: e.target.value })}>
              <option value="">전체</option>
              <option value="deposit">입금</option>
              <option value="withdrawal">출금</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            매칭상태
            <select className={cx(inputBase, 'mt-0.5 w-32')} value={match} onChange={(e) => set({ match: e.target.value })}>
              <option value="">전체</option>
              {(['AUTO_MATCHED', 'MANUAL_MATCHED'] as MatchStatus[]).map((s) => (
                <option key={s} value={s}>
                  {MATCH_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-48 flex-1 text-xs text-slate-500">
            검색 (통장 원본명 · 거래처 정식명)
            <input className={cx(inputCls, 'mt-0.5')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="예: 남산운수" />
          </label>
          {partial && (
            <Button size="sm" onClick={() => set({ partial: null })}>
              부분납 필터 해제 ✕
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setParams(new URLSearchParams(), { replace: true });
              setQ('');
            }}
          >
            초기화
          </Button>
          <div className="ml-auto">
            <SegmentedControl
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: '거래내역' },
                { value: 'monthly', label: '월별 보기' },
                { value: 'client', label: '거래처별 보기' },
              ]}
            />
          </div>
        </div>
      </Card>

      {view !== 'list' ? (
        advisory.loading || !advisory.data ? (
          <Spinner />
        ) : view === 'monthly' ? (
          <MonthlyView data={advisory.data} initialMonth={month ? `${effectiveYear === 'all' ? now.slice(0, 4) : effectiveYear}-${month}` : now} />
        ) : (
          <ClientView data={advisory.data} initialClientId={clientFilter ? Number(clientFilter) : null} />
        )
      ) : (
        <Card
          bodyClassName="p-0"
          title={
            <span>
              거래 {filtered.length.toLocaleString('ko-KR')}건 <span className="ml-2 font-normal text-slate-500">입금 {won(totals.dep)} · 출금 {won(totals.wd)}</span>
            </span>
          }
          actions={
            <>
              {individualCount > 0 && (
                <Button size="sm" onClick={() => navigate('/case-fee')} title="거래처에 매칭되지 않은 입금은 3. 개별건에서 확인·확정합니다">
                  매칭 안 된 입금 {individualCount}건 → 개별건
                </Button>
              )}
              <Button size="sm" onClick={() => setSel(new Set(filtered.filter((t) => t.deposit_amount > 0).map((t) => t.id)))}>
                V 입금 전체 선택
              </Button>
            </>
          }
        >
          <ErrorBox error={txs.error} onRetry={txs.reload} />
          {txs.loading && !txs.data ? (
            <Spinner />
          ) : !filtered.length ? (
            <EmptyState>조건에 맞는 거래가 없습니다. 상단 [통장내역 Excel 업로드]로 거래를 가져오세요.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs whitespace-nowrap text-slate-500">
                  <tr className="text-left">
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="전체 선택"
                        checked={filtered.length > 0 && filtered.every((t) => sel.has(t.id))}
                        onChange={(e) => setSel(e.target.checked ? new Set(filtered.map((t) => t.id)) : new Set())}
                      />
                    </th>
                    <th className="px-2 py-2">거래일시</th>
                    <th className="px-2 py-2">통장 원본명</th>
                    <th className="px-2 py-2">거래처명</th>
                    <th className="px-2 py-2 text-right">매칭률</th>
                    <th className="px-2 py-2 text-right">입금액</th>
                    <th className="px-2 py-2 text-right">출금액</th>
                    <th className="px-2 py-2 text-right">계약금액</th>
                    <th className="px-2 py-2">적용 월</th>
                    <th className="px-2 py-2 text-right">배정금액</th>
                    <th className="px-2 py-2">상태</th>
                    <th className="px-2 py-2">비고</th>
                    <th className="px-3 py-2">업로드 파일명</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.slice(0, limit).map((t) => {
                    const ws = worstStatus(t);
                    const allocated = t.allocations.reduce((s, a) => s + a.allocated_amount, 0);
                    return (
                      <tr key={t.id} className={cx('cursor-pointer hover:bg-blue-50/40', sel.has(t.id) && 'bg-blue-50/70')} onClick={() => setOpenId(t.id)}>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label="선택" checked={sel.has(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} />
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap tabular-nums">{t.transaction_datetime.slice(0, 16)}</td>
                        <td className="max-w-44 px-2 py-2">{t.sender_raw}</td>
                        <td className="px-2 py-2 font-medium">{t.client_name ?? <span className="font-normal text-slate-400">-</span>}</td>
                        <td className="px-2 py-2 text-right">{!t.client_name ? '-' : t.match_type === 'MANUAL' ? <span className="text-xs text-slate-500">수동</span> : <ScoreText score={t.similarity_score} />}</td>
                        <td className="px-2 py-2 text-right font-medium tabular-nums">{t.deposit_amount ? won(t.deposit_amount) : ''}</td>
                        <td className="px-2 py-2 text-right text-slate-600 tabular-nums">{t.withdrawal_amount ? won(t.withdrawal_amount) : ''}</td>
                        <td className="px-2 py-2 text-right text-slate-500 tabular-nums">{t.contract_amount != null ? won(t.contract_amount) : '-'}</td>
                        <td className="px-2 py-2 text-xs tabular-nums">
                          {t.allocations.length === 0
                            ? '-'
                            : t.allocations.length === 1
                              ? t.allocations[0].service_month
                              : (
                                  <span className="whitespace-nowrap">
                                    {t.allocations[0].service_month} ~ {t.allocations[t.allocations.length - 1].service_month.slice(5)}월
                                    <span className="ml-1 text-slate-400">▶{t.allocations.length}</span>
                                  </span>
                                )}
                        </td>
                        <td className={cx('px-2 py-2 text-right tabular-nums', t.deposit_amount > 0 && allocated > 0 && allocated < t.deposit_amount && 'text-amber-700')}>{allocated ? won(allocated) : '-'}</td>
                        <td className="px-2 py-2">
                          <div className="flex flex-col items-start gap-0.5">
                            {t.deposit_amount > 0 || t.client_id ? <MatchBadge status={t.match_status} /> : <Badge>출금</Badge>}
                            {ws && <PayBadge status={ws} />}
                            {t.deposit_amount > 0 && !ws && (t.match_status === 'AUTO_MATCHED' || t.match_status === 'MANUAL_MATCHED') && <Badge tone="violet">미배정</Badge>}
                          </div>
                        </td>
                        <td className="max-w-32 truncate px-2 py-2 text-xs text-slate-600" title={t.note ?? ''}>
                          {t.note}
                        </td>
                        <td className="max-w-36 truncate px-3 py-2 text-xs text-slate-500" title={t.filename}>
                          {t.filename}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length > limit && (
                <div className="border-t border-slate-200 p-3 text-center">
                  <Button onClick={() => setLimit((l) => l + PAGE)}>더 보기 ({(filtered.length - limit).toLocaleString('ko-KR')}건 남음)</Button>
                </div>
              )}
            </div>
          )}
          <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            상태: {Object.values(PAYMENT_STATUS_LABEL).join(' / ')} — 적용 월의 현재 납부 상태입니다. 행을 클릭하면 원본/배정 상세와 수정 기능을 볼 수 있습니다.
          </div>
        </Card>
      )}

      {view === 'list' && (
        <BulkActionBar
          selected={[...sel]}
          rows={txs.data ?? []}
          clients={clients}
          onClear={() => setSel(new Set())}
          onDone={() => {
            setSel(new Set());
            bumpData();
          }}
        />
      )}

      {openId !== null && (
        <TransactionDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            bumpData();
          }}
        />
      )}
    </div>
  );
}
