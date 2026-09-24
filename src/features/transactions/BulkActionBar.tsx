import { useState } from 'react';
import type { BulkActionRequest, BulkActionResult, TransactionRow } from '../../domain/dto';
import type { Client } from '../../domain/types';
import { api, errorMessage } from '../../services/api';
import { ClientPicker } from '../common/ClientPicker';
import { Button, cx, inputBase, Overlay, toast } from '../common/ui';

const CHUNK = 100;

/** 선택(V)한 거래 일괄 처리 바 */
export function BulkActionBar({
  selected,
  rows,
  clients,
  onClear,
  onDone,
}: {
  selected: number[];
  rows: TransactionRow[];
  clients: Client[];
  onClear: () => void;
  onDone: () => void;
}) {
  const [month, setMonth] = useState('');
  const [includeWarnings, setIncludeWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickClient, setPickClient] = useState<number | null>(null);
  const [report, setReport] = useState<(BulkActionResult & { title: string }) | null>(null);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const sel = selected.map((id) => byId.get(id)).filter((r): r is TransactionRow => !!r);
  const pending = sel.filter((r) => r.deposit_amount > 0 && r.match_status !== 'AUTO_MATCHED' && r.match_status !== 'MANUAL_MATCHED');
  const withSuggestion = pending.filter((r) => r.client_id != null);
  const confirmed = sel.filter((r) => r.match_status === 'AUTO_MATCHED' || r.match_status === 'MANUAL_MATCHED');

  const run = async (title: string, req: Omit<BulkActionRequest, 'ids'>, ids: number[]) => {
    if (!ids.length) return;
    setBusy(true);
    const total: BulkActionResult = { done: 0, skipped: [], failed: [] };
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const r = await api.bulk({ ...req, ids: ids.slice(i, i + CHUNK) });
        total.done += r.done;
        total.skipped.push(...r.skipped);
        total.failed.push(...r.failed);
      }
      toast(`${title}: 완료 ${total.done}건${total.failed.length ? ` · 실패 ${total.failed.length}건` : ''}${total.skipped.length ? ` · 건너뜀 ${total.skipped.length}건` : ''}`, total.failed.length ? 'err' : 'ok');
      if (total.failed.length || total.skipped.length) setReport({ ...total, title });
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const label = (id: number) => {
    const r = byId.get(id);
    return r ? `${r.transaction_datetime.slice(0, 16)} · ${r.sender_raw} · ${r.deposit_amount.toLocaleString('ko-KR')}원` : `#${id}`;
  };

  return (
    <>
      {selected.length > 0 && (
      <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-2 rounded-lg border border-blue-300 bg-white px-4 py-3 shadow-lg">
        <span className="text-sm font-semibold text-blue-800">V {selected.length}건 선택</span>
        <span className="text-xs text-slate-500">
          (미확정 {pending.length} · 추천 있음 {withSuggestion.length} · 확정됨 {confirmed.length})
        </span>
        <label className="ml-2 flex items-center gap-1.5 text-xs text-slate-600">
          첫 적용월
          <input type="month" className={cx(inputBase, 'h-8 w-40')} value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-600" title="수수료 차감 가능성·계약금액 4개월분 이상 입금은 기본으로 건너뜁니다">
          <input type="checkbox" checked={includeWarnings} onChange={(e) => setIncludeWarnings(e.target.checked)} />
          경고 건 포함
        </label>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !withSuggestion.length}
          title="추천 거래처로 확정합니다. 첫 적용월은 관리 시작월·기존 기록이 없는 거래처에만 사용됩니다."
          onClick={() => void run('추천 거래처로 확정', { action: 'confirm', startMonth: month || null, includeWarnings }, withSuggestion.map((r) => r.id))}
        >
          추천 거래처로 확정 ({withSuggestion.length})
        </Button>
        <Button size="sm" disabled={busy || !pending.length} onClick={() => setPickOpen(true)}>
          거래처 지정… ({pending.length})
        </Button>
        <Button
          size="sm"
          disabled={busy || !month || !sel.some((r) => r.deposit_amount > 0 && r.client_id != null)}
          title="선택한 거래의 배정을 지우고 입력한 첫 적용월 이후 가장 오래된 미납월부터 다시 배정합니다."
          onClick={() =>
            window.confirm(`선택한 거래를 ${month}부터 다시 배정합니다. 계속할까요?`) &&
            void run(
              '적용월 일괄 변경',
              { action: 'redate', startMonth: month },
              sel.filter((r) => r.deposit_amount > 0 && r.client_id != null).map((r) => r.id),
            )
          }
        >
          적용월 일괄 변경
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy || !confirmed.length}
          onClick={() => window.confirm(`확정된 ${confirmed.length}건의 확정·배정을 취소할까요?`) && void run('배정 취소', { action: 'unassign' }, confirmed.map((r) => r.id))}
        >
          배정 취소 ({confirmed.length})
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onClear}>
          선택 해제
        </Button>
        {busy && <span className="text-xs text-slate-500">처리 중…</span>}
      </div>
      )}

      <Overlay
        open={pickOpen}
        variant="modal"
        width="max-w-xl"
        onClose={() => setPickOpen(false)}
        title={`거래처 일괄 지정 — 미확정 ${pending.length}건`}
        footer={
          <>
            <Button onClick={() => setPickOpen(false)}>취소</Button>
            <Button
              variant="primary"
              disabled={pickClient == null || busy}
              onClick={() => {
                setPickOpen(false);
                void run('거래처 일괄 지정', { action: 'confirm', clientId: pickClient, startMonth: month || null, includeWarnings }, pending.map((r) => r.id));
              }}
            >
              지정 후 확정
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">선택한 미확정 입금을 모두 아래 거래처로 확정합니다. (예: CMS집금 여러 건) 첫 적용월: {month || '입력 안 함'}</p>
          <ClientPicker clients={clients} value={pickClient} onChange={setPickClient} autoFocus />
        </div>
      </Overlay>

      <Overlay open={!!report} variant="modal" width="max-w-2xl" onClose={() => setReport(null)} title={`${report?.title} 결과`}>
        {report && (
          <div className="space-y-4 text-sm">
            <p>
              완료 <b>{report.done}</b>건 · 실패 <b className="text-rose-700">{report.failed.length}</b>건 · 건너뜀 {report.skipped.length}건
            </p>
            {report.failed.length > 0 && (
              <div>
                <h4 className="mb-1 font-semibold text-rose-700">실패 (확인 필요)</h4>
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {report.failed.map((f) => (
                    <li key={f.id} className="rounded bg-rose-50 px-2 py-1">
                      <div className="text-slate-700">{label(f.id)}</div>
                      <div className="text-xs text-rose-700">{f.error}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.skipped.length > 0 && (
              <details open>
                <summary className="cursor-pointer text-slate-600">건너뜀 {report.skipped.length}건</summary>
                <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto text-xs">
                  {report.skipped.map((s) => (
                    <li key={s.id}>
                      {label(s.id)} — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Overlay>
    </>
  );
}
