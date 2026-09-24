import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { MATCH_TYPE_LABEL } from '../../domain/labels';
import { addMonths, isYearMonth } from '../../domain/month';
import { api, ApiError, errorMessage } from '../../services/api';
import { ClientPicker } from '../common/ClientPicker';
import { Badge, Button, ErrorBox, Field, inputCls, localDateTime, MatchBadge, Overlay, PayBadge, ScoreText, Spinner, toast, useAsync, won } from '../common/ui';

type Mode = null | 'client' | 'start' | 'alloc';

const ACTION_LABEL: Record<string, string> = {
  ASSIGN_CLIENT: '거래처 지정/변경',
  EDIT_ALLOCATIONS: '배정 수정',
  UNASSIGN_CLIENT: '배정 취소',
  EDIT_NOTE: '비고 수정',
};

export function TransactionDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { clients } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.transaction(id), [id]);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [pickClient, setPickClient] = useState<number | null>(null);
  const [startMonth, setStartMonth] = useState('');
  const [needStart, setNeedStart] = useState(false);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ serviceMonth: string; amount: string }[]>([]);

  const t = data?.transaction;
  useEffect(() => {
    if (!t) return;
    setNote(t.note ?? '');
    setPickClient(t.client_id);
    setLines(t.allocations.map((a) => ({ serviceMonth: a.service_month, amount: String(a.allocated_amount) })));
  }, [t]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setMode(null);
      setNeedStart(false);
      await reload();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && (e.details as { code?: string } | null)?.code === 'NEEDS_START_MONTH') {
        setNeedStart(true);
        toast('기존 기록이 없는 거래처입니다. 첫 적용월을 선택해주세요.', 'err');
      } else toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const assign = (clientId: number, sm?: string) => act(() => api.assign(id, { clientId, startMonth: sm || null }), '거래처 배정 완료');

  const sumLines = lines.reduce((s, l) => s + (Number(l.amount.replace(/,/g, '')) || 0), 0);
  const saveLines = () => {
    const parsed = lines.map((l) => ({ serviceMonth: l.serviceMonth, amount: Number(l.amount.replace(/,/g, '')) }));
    for (const l of parsed) {
      if (!isYearMonth(l.serviceMonth)) return toast(`적용월을 확인해주세요: ${l.serviceMonth || '(빈 값)'}`, 'err');
      if (!Number.isSafeInteger(l.amount) || l.amount <= 0) return toast('배정금액은 1원 이상의 정수여야 합니다.', 'err');
    }
    return act(() => api.setAllocations(id, { lines: parsed }), '배정 수정 완료');
  };

  const isMatched = t && (t.match_status === 'AUTO_MATCHED' || t.match_status === 'MANUAL_MATCHED');

  return (
    <Overlay open onClose={onClose} title="거래 상세">
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : t ? (
        <div className="space-y-5 text-sm">
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500">RAW · 통장 원본 (수정 불가)</h4>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-3">
              <dt className="text-slate-500">거래일시</dt>
              <dd className="tabular-nums">{t.transaction_datetime}</dd>
              <dt className="text-slate-500">보낸분/받는분</dt>
              <dd className="font-medium">{t.sender_raw}</dd>
              <dt className="text-slate-500">입금액</dt>
              <dd className="tabular-nums">{won(t.deposit_amount)}</dd>
              <dt className="text-slate-500">출금액</dt>
              <dd className="tabular-nums">{won(t.withdrawal_amount)}</dd>
              <dt className="text-slate-500">업로드 파일</dt>
              <dd className="truncate" title={t.filename}>
                {t.filename} · {t.excel_row_number}행{t.bank_row_no ? ` (번호 ${t.bank_row_no})` : ''}
              </dd>
              <dt className="text-slate-500">거래 hash</dt>
              <dd className="font-mono text-xs text-slate-500">{t.transaction_hash.slice(0, 16)}…</dd>
            </dl>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500">PROCESSED · 프로그램 처리</h4>
            <div className="space-y-3 rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{t.client_name ?? '거래처 미지정'}</span>
                {t.category === 'INDIVIDUAL' ? <Badge tone="violet">개별건 확정</Badge> : t.category === 'DUPLICATE' ? <Badge>중복 건너뜀</Badge> : <MatchBadge status={t.match_status} />}
                {t.client_name && (
                  <span className="text-xs text-slate-500">
                    유사도 <ScoreText score={t.similarity_score} /> · {MATCH_TYPE_LABEL[t.match_type]}
                  </span>
                )}
              </div>
              {t.contract_amount != null && <div className="text-slate-600">현재 월 계약금액 {won(t.contract_amount)}원</div>}

              {t.deposit_amount > 0 && (
                <div className="flex flex-wrap gap-2">
                  {t.match_status === 'REVIEW_REQUIRED' && t.client_id && (
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void assign(t.client_id as number)}>
                      추천 거래처로 확정
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setMode(mode === 'client' ? null : 'client')}>
                    {t.client_id ? '다른 거래처 선택' : '거래처 선택'}
                  </Button>
                  {t.category !== 'INDIVIDUAL' && t.category !== 'DUPLICATE' && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        window.confirm('이 입금을 거래처가 아닌 개별건으로 확정할까요? (노무자문비 배정은 지워집니다)') &&
                        void act(() => api.bulk({ action: 'individual', ids: [id] }), '개별건으로 지정')
                      }
                    >
                      개별건으로 지정
                    </Button>
                  )}
                  {isMatched && (
                    <>
                      <Button size="sm" onClick={() => setMode(mode === 'start' ? null : 'start')}>
                        첫 적용월 변경
                      </Button>
                      <Button size="sm" onClick={() => setMode(mode === 'alloc' ? null : 'alloc')}>
                        적용월·배정금액 수정
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => window.confirm('이 거래의 거래처 확정과 월분 배정을 취소하고 확인필요 상태로 되돌릴까요?') && void act(() => api.unassign(id), '배정 취소 완료')}
                      >
                        배정 취소
                      </Button>
                    </>
                  )}
                </div>
              )}

              {(mode === 'client' || needStart) && (
                <div className="space-y-3 rounded-md bg-slate-50 p-3">
                  <ClientPicker clients={clients} value={pickClient} onChange={setPickClient} candidates={data.candidates} />
                  {needStart && <p className="text-xs text-violet-700">월 배정 필요 — 이 거래처는 기존 기록과 관리 시작월이 없습니다. 첫 적용월을 선택하세요.</p>}
                  <Field label={needStart ? '첫 적용월 (필수)' : '첫 적용월 (선택)'} hint="비워두면 가장 오래된 미납월부터 자동 배정합니다.">
                    <input type="month" className={inputCls} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => (setMode(null), setNeedStart(false))}>
                      취소
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy || pickClient == null || (needStart && !startMonth)} onClick={() => pickClient != null && void assign(pickClient, startMonth)}>
                      적용 (재배정)
                    </Button>
                  </div>
                </div>
              )}

              {mode === 'start' && t.client_id && (
                <div className="space-y-3 rounded-md bg-slate-50 p-3">
                  <Field label="첫 적용월" hint="기존 배정을 지우고, 선택한 월 이후 가장 오래된 미납월부터 다시 배정합니다.">
                    <input type="month" className={inputCls} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setMode(null)}>
                      취소
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy || !startMonth} onClick={() => void assign(t.client_id as number, startMonth)}>
                      재배정
                    </Button>
                  </div>
                </div>
              )}

              {mode === 'alloc' && (
                <div className="space-y-2 rounded-md bg-slate-50 p-3">
                  {lines.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <input type="month" className={inputCls} value={l.serviceMonth} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serviceMonth: e.target.value } : x)))} />
                      <input
                        className={`${inputCls} text-right`}
                        inputMode="numeric"
                        value={l.amount}
                        onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d,]/g, '') } : x)))}
                      />
                      <Button size="md" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="삭제">
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    onClick={() => {
                      const last = lines[lines.length - 1]?.serviceMonth;
                      setLines([...lines, { serviceMonth: last && isYearMonth(last) ? addMonths(last, 1) : '', amount: String(t.contract_amount ?? '') }]);
                    }}
                  >
                    + 월 추가
                  </Button>
                  <div className={sumLines > t.deposit_amount ? 'text-rose-700' : 'text-slate-600'}>
                    배정 합계 {won(sumLines)} / 입금액 {won(t.deposit_amount)} (미배정 {won(t.deposit_amount - sumLines)})
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setMode(null)}>
                      취소
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy || sumLines > t.deposit_amount || !lines.length} onClick={() => void saveLines()}>
                      저장
                    </Button>
                  </div>
                </div>
              )}

              <Field label="비고">
                <div className="flex gap-2">
                  <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button disabled={busy || note === (t.note ?? '')} onClick={() => void act(() => api.setNote(id, note), '비고 저장')}>
                    저장
                  </Button>
                </div>
              </Field>
            </div>
          </section>

          {t.allocations.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500">
                ▶ 배정내역 · 총 입금 {won(t.deposit_amount)}원 · 입금일 {t.transaction_datetime.slice(0, 10)}
              </h4>
              <table className="w-full rounded-md border border-slate-200">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr className="text-left">
                    <th className="px-3 py-1.5">적용월</th>
                    <th className="px-3 py-1.5 text-right">배정금액</th>
                    <th className="px-3 py-1.5 text-right">당시 계약금액</th>
                    <th className="px-3 py-1.5">월 상태</th>
                    <th className="px-3 py-1.5">구분</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {t.allocations.map((a) => (
                    <tr key={a.id}>
                      <td className="px-3 py-1.5 font-medium tabular-nums">{a.service_month}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{won(a.allocated_amount)}</td>
                      <td className="px-3 py-1.5 text-right text-slate-500 tabular-nums">{won(a.contract_amount_snapshot)}</td>
                      <td className="px-3 py-1.5">
                        <PayBadge status={a.month_status} />
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{a.source === 'MANUAL' ? '수동' : '자동'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500">수정 이력</h4>
            {data.audit.length ? (
              <ul className="space-y-2">
                {data.audit.map((a) => (
                  <li key={a.id} className="rounded-md border border-slate-200 p-2 text-xs">
                    <div className="flex justify-between">
                      <Badge>{ACTION_LABEL[a.action] ?? a.action}</Badge>
                      <span className="text-slate-500">{localDateTime(a.created_at)}</span>
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-slate-500">변경 내용</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] whitespace-pre-wrap">
                        이전: {a.before_data ?? '-'}
                        {'\n'}이후: {a.after_data ?? '-'}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">수정 이력이 없습니다.</p>
            )}
          </section>
        </div>
      ) : null}
    </Overlay>
  );
}
