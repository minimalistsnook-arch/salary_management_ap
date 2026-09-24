import { useMemo, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { INDIVIDUAL_SIMILAR_THRESHOLD } from '../../domain/matching';
import { normalizeName } from '../../domain/normalize';
import { api } from '../../services/api';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, inputBase, Notice, SegmentedControl, Spinner, useAsync, won } from '../common/ui';
import { TransactionDrawer } from '../transactions/TransactionDrawer';

type SimFilter = 'all' | 'similar' | 'none';

/**
 * 3. 개별건 입금: 통장 Excel 에서 거래처에 매칭되지 않은 입금을 모두 모아 보여준다.
 * 유사도 40% 이상 거래처가 있으면 표시한다. 거래처를 지정하면 이 목록에서 빠지고 월분 배정된다.
 */
export function IndividualCasesPage() {
  const { dataVersion, bumpData } = useApp();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<string>('all');
  const [sim, setSim] = useState<SimFilter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, error, loading, reload } = useAsync(() => api.individual(year === 'all' ? undefined : Number(year)), [year, dataVersion]);

  const rows = useMemo(() => {
    const nq = normalizeName(q);
    return (data ?? []).filter((r) => {
      if (sim === 'similar' && !r.similar) return false;
      if (sim === 'none' && r.similar) return false;
      if (q.trim()) {
        const hay = [r.sender_raw, r.bestCandidate?.clientName ?? '', r.note ?? ''];
        if (!hay.some((h) => h.includes(q.trim()) || (nq && normalizeName(h).includes(nq)))) return false;
      }
      return true;
    });
  }, [data, sim, q]);

  const all = data ?? [];
  const similarCount = all.filter((r) => r.similar).length;
  const total = rows.reduce((s, r) => s + r.deposit_amount, 0);

  return (
    <div className="space-y-4">
      <Notice>
        통장 Excel에서 <b>거래처에 매칭되지 않은 입금</b>(미매칭·확인필요)이 모두 여기에 모입니다. 거래처와 유사도 <b>{INDIVIDUAL_SIMILAR_THRESHOLD}% 이상</b>인 건은
        <span className="mx-1 rounded bg-amber-100 px-1.5 text-amber-900">유사</span>로 표시됩니다. [거래처 지정]을 하면 노무자문비로 배정되고 이 목록에서 빠집니다. 개별건 수수료 규칙은 다음 단계에서
        추가됩니다.
      </Notice>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['개별건 (미매칭 입금)', `${all.length.toLocaleString('ko-KR')}건`, ''],
          [`유사 ${INDIVIDUAL_SIMILAR_THRESHOLD}% 이상`, `${similarCount.toLocaleString('ko-KR')}건`, 'text-amber-700'],
          [`유사 ${INDIVIDUAL_SIMILAR_THRESHOLD}% 미만`, `${(all.length - similarCount).toLocaleString('ko-KR')}건`, ''],
          ['개별건 입금 합계', `${won(all.reduce((s, r) => s + r.deposit_amount, 0))}원`, ''],
        ].map(([k, v, tone]) => (
          <div key={k} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{k}</div>
            <div className={cx('mt-1 text-xl font-semibold tabular-nums', tone)}>{data ? v : '…'}</div>
          </div>
        ))}
      </div>

      <Card
        bodyClassName="p-0"
        title={
          <span>
            개별건 {rows.length.toLocaleString('ko-KR')}건 <span className="ml-2 font-normal text-slate-500">입금 {won(total)}</span>
          </span>
        }
        actions={
          <>
            <select className={cx(inputBase, 'w-28')} value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">전체 연도</option>
              {Array.from({ length: 6 }, (_, i) => String(thisYear + 1 - i)).map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
            <SegmentedControl
              value={sim}
              onChange={setSim}
              options={[
                { value: 'all', label: '전체' },
                { value: 'similar', label: `유사 ${INDIVIDUAL_SIMILAR_THRESHOLD}% 이상` },
                { value: 'none', label: `${INDIVIDUAL_SIMILAR_THRESHOLD}% 미만` },
              ]}
            />
            <input className={cx(inputBase, 'w-52')} placeholder="통장명 · 거래처 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        }
      >
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner />
        ) : !rows.length ? (
          <EmptyState>{all.length ? '조건에 맞는 개별건이 없습니다.' : '매칭되지 않은 입금이 없습니다.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-slate-50 text-xs whitespace-nowrap text-slate-500">
                <tr className="text-left">
                  <th className="px-3 py-2">거래일시</th>
                  <th className="px-2 py-2">통장 원본명</th>
                  <th className="px-2 py-2 text-right">입금액</th>
                  <th className="px-2 py-2">유사 거래처</th>
                  <th className="px-2 py-2 text-right">유사도</th>
                  <th className="px-2 py-2">상태</th>
                  <th className="px-2 py-2">비고</th>
                  <th className="px-2 py-2">업로드 파일</th>
                  <th className="px-3 py-2 text-right">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={cx(r.similar && 'bg-amber-50/60')}>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.transaction_datetime.slice(0, 16)}</td>
                    <td className="px-2 py-2 font-medium">{r.sender_raw}</td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">{won(r.deposit_amount)}</td>
                    <td className="px-2 py-2">
                      {r.isGeneric ? (
                        <span className="text-xs text-slate-500">공통 입금명 — 직접 선택</span>
                      ) : r.similar && r.bestCandidate ? (
                        <div>
                          <Badge tone="amber">유사</Badge> <span className="font-medium">{r.bestCandidate.clientName}</span>
                          {r.bestCandidate.viaAlias && <div className="text-xs text-slate-500">시트 A열 '{r.bestCandidate.viaAlias}'과 유사</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">유사 거래처 없음</span>
                      )}
                    </td>
                    <td className={cx('px-2 py-2 text-right tabular-nums', r.similar ? 'font-medium text-amber-800' : 'text-slate-400')}>
                      {r.bestCandidate && !r.isGeneric ? `${r.bestCandidate.score}%` : '-'}
                    </td>
                    <td className="px-2 py-2">{r.match_status === 'REVIEW_REQUIRED' ? <Badge tone="amber">확인필요</Badge> : <Badge tone="red">미매칭</Badge>}</td>
                    <td className="max-w-40 truncate px-2 py-2 text-xs text-slate-600" title={r.note ?? ''}>
                      {r.note}
                    </td>
                    <td className="max-w-36 truncate px-2 py-2 text-xs text-slate-500" title={r.filename}>
                      {r.filename}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant={r.similar ? 'primary' : 'secondary'} onClick={() => setOpenId(r.id)}>
                        거래처 지정
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId !== null && <TransactionDrawer id={openId} onClose={() => setOpenId(null)} onChanged={bumpData} />}
    </div>
  );
}
