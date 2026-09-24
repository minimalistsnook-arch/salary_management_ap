import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { parseBankRows, type BankParseResult } from '../../domain/bankExcelParser';
import type { ImportCommitResponse, ImportPreviewRequest, ImportPreviewResponse, PreviewRow, RowDecision } from '../../domain/dto';
import { api, errorMessage } from '../../services/api';
import { readExcelFile } from '../../services/excelRead';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, localDateTime, MatchBadge, Notice, ScoreText, SegmentedControl, Spinner, toast, won } from '../common/ui';
import { RowEditor } from './RowEditor';

const STEPS = ['Excel 파싱', '거래처 자동 매칭', '월별 자문료 자동 배정', '사용자 확인', '최종 저장'];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <li
            key={label}
            className={cx(
              'flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
              state === 'done' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              state === 'current' && 'border-blue-300 bg-blue-50 font-medium text-blue-800',
              state === 'todo' && 'border-slate-200 bg-white text-slate-400',
            )}
          >
            <span className={cx('flex h-5 w-5 items-center justify-center rounded-full text-xs', state === 'done' ? 'bg-emerald-600 text-white' : state === 'current' ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-500')}>
              {state === 'done' ? '✓' : n}
            </span>
            STEP {n} · {label}
          </li>
        );
      })}
    </ol>
  );
}

type Filter = 'all' | 'confirmed' | 'waiting' | 'review' | 'unmatched' | 'warning' | 'duplicate' | 'withdrawal';

function rowState(r: PreviewRow): { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue' | 'violet' } {
  if (r.duplicate) return { label: '이미 등록된 거래', tone: 'slate' };
  if (r.depositAmount <= 0) return { label: '출금', tone: 'slate' };
  if (r.selected) return { label: '확정', tone: 'green' };
  if (r.needsStartMonth) return { label: '월 배정 필요', tone: 'violet' };
  if (r.matchStatus === 'UNMATCHED') return { label: '미매칭', tone: 'red' };
  if (r.matchStatus === 'REVIEW_REQUIRED') return { label: '거래처 확인 필요', tone: 'amber' };
  if (r.allocationError && !r.allocation.length) return { label: '배정 불가', tone: 'red' };
  return { label: '확인대기', tone: 'blue' };
}

const isWarning = (r: PreviewRow) => !r.duplicate && (!!r.feeWarning || !!r.duplicateSuspect || (!!r.allocationError && r.allocation.length > 0));

export function UploadPage() {
  const navigate = useNavigate();
  const { clients, bumpData } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<{ filename: string; fileHash: string; sheet: string } | null>(null);
  const [parse, setParse] = useState<BankParseResult | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<number, RowDecision>>({});
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<PreviewRow | null>(null);
  const [result, setResult] = useState<ImportCommitResponse | null>(null);

  const step = result ? 6 : preview ? 4 : parse && !parse.errors.length ? 2 : 1;

  const request = useCallback(
    (d: Record<number, RowDecision>): ImportPreviewRequest | null => (file && parse ? { filename: file.filename, fileHash: file.fileHash, rows: parse.rows, decisions: d } : null),
    [file, parse],
  );

  const refresh = async (d: Record<number, RowDecision>) => {
    const req = request(d);
    if (!req) return;
    setBusy('배정 다시 계산 중…');
    try {
      setPreview(await api.previewImport(req));
      setDecisions(d);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setParse(null);
    setPreview(null);
    setDecisions({});
    setChecked(new Set());
    setResult(null);
    setError(null);
    setFilter('all');
    if (inputRef.current) inputRef.current.value = '';
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    reset();
    if (!/\.xlsx?$/i.test(f.name)) {
      setError(`지원하지 않는 파일 형식입니다: ${f.name}\n은행에서 받은 .xlsx 파일을 올려주세요.`);
      return;
    }
    setBusy('STEP 1 · Excel 파싱 중…');
    try {
      const wb = await readExcelFile(f);
      let chosen: { sheet: string; result: BankParseResult } | null = null;
      for (const s of wb.sheets) {
        const r = parseBankRows(s.rows, s.firstRowNumber);
        if (!r.errors.length) {
          chosen = { sheet: s.name, result: r };
          break;
        }
        if (!chosen || r.errors.length < chosen.result.errors.length) chosen = { sheet: s.name, result: r };
      }
      if (!chosen) throw new Error('Excel 파일에 시트가 없습니다.');
      setFile({ filename: wb.filename, fileHash: wb.fileHash, sheet: chosen.sheet });
      setParse(chosen.result);
      if (chosen.result.errors.length) return;
      setBusy('STEP 2~3 · 거래처 매칭 및 월분 배정 계산 중…');
      setPreview(await api.previewImport({ filename: wb.filename, fileHash: wb.fileHash, rows: chosen.result.rows, decisions: {} }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const setDecision = (row: number, patch: RowDecision) => refresh({ ...decisions, [row]: { ...decisions[row], ...patch } });

  const bulkConfirm = (rows: PreviewRow[]) => {
    const d = { ...decisions };
    for (const r of rows) d[r.excelRowNumber] = { ...d[r.excelRowNumber], selected: true };
    setChecked(new Set());
    return refresh(d);
  };
  const bulkUnconfirm = (rows: PreviewRow[]) => {
    const d = { ...decisions };
    for (const r of rows) d[r.excelRowNumber] = { ...d[r.excelRowNumber], selected: false };
    setChecked(new Set());
    return refresh(d);
  };

  const rows = preview?.rows ?? [];
  const eligible = (r: PreviewRow) => r.selectable && !r.selected && (r.matchStatus === 'AUTO_MATCHED' || r.matchStatus === 'MANUAL_MATCHED');
  const allConfirmable = rows.filter((r) => eligible(r) && !isWarning(r));
  const warningEligible = rows.filter((r) => eligible(r) && isWarning(r));
  const checkedRows = rows.filter((r) => checked.has(r.excelRowNumber));

  const filtered = useMemo(() => {
    const f: Record<Filter, (r: PreviewRow) => boolean> = {
      all: () => true,
      confirmed: (r) => r.selected,
      waiting: (r) => !r.selected && !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'AUTO_MATCHED',
      review: (r) => !r.duplicate && r.depositAmount > 0 && (r.matchStatus === 'REVIEW_REQUIRED' || r.needsStartMonth),
      unmatched: (r) => !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'UNMATCHED',
      warning: isWarning,
      duplicate: (r) => r.duplicate,
      withdrawal: (r) => r.depositAmount <= 0,
    };
    return rows.filter(f[filter]);
  }, [rows, filter]);

  const count = (f: Filter) =>
    rows.filter((r) =>
      ({
        all: true,
        confirmed: r.selected,
        waiting: !r.selected && !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'AUTO_MATCHED',
        review: !r.duplicate && r.depositAmount > 0 && (r.matchStatus === 'REVIEW_REQUIRED' || r.needsStartMonth),
        unmatched: !r.duplicate && r.depositAmount > 0 && r.matchStatus === 'UNMATCHED',
        warning: isWarning(r),
        duplicate: r.duplicate,
        withdrawal: r.depositAmount <= 0,
      })[f],
    ).length;

  const commit = async () => {
    const req = request(decisions);
    if (!req || !preview) return;
    const confirmedN = rows.filter((r) => r.selected).length;
    const newN = rows.filter((r) => !r.duplicate).length;
    if (!window.confirm(`최종 저장합니다.\n\n신규 거래 ${newN}건 저장 (원본 보존)\n확정·월분 배정 ${confirmedN}건\n나머지는 '확인필요/미매칭'으로 저장되어 메뉴 1에서 처리할 수 있습니다.`)) return;
    setBusy('STEP 5 · 저장 중…');
    try {
      const res = await api.commitImport(req);
      setResult(res);
      bumpData();
      toast('저장 완료');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Stepper step={step} />

      {!preview && !result && (
        <Card title="STEP 1 · 통장 거래내역 Excel 선택">
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
          >
            <div className="text-sm text-slate-600">은행에서 받은 거래내역 Excel(.xlsx) 파일을 끌어다 놓거나 선택하세요.</div>
            <div className="text-xs text-slate-500">필수 컬럼: 거래일시 · 보낸분/받는분 · 출금액 · 입금액 (번호 선택)</div>
            <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()} disabled={!!busy}>
              파일 선택
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">업로드한 파일은 확인 후 [최종 저장]을 눌러야 저장됩니다. 같은 파일·같은 거래는 다시 등록되지 않습니다.</p>
        </Card>
      )}

      {busy && <Spinner label={busy} />}
      <ErrorBox error={error} />

      {parse && parse.errors.length > 0 && (
        <Card title={`Excel 형식 오류 — ${file?.filename} (${file?.sheet} 시트)`} actions={<Button onClick={reset}>다른 파일 선택</Button>}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-rose-700">
            {parse.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Card>
      )}

      {preview && !result && file && parse && (
        <>
          <Card
            title={
              <span>
                {file.filename} <span className="font-normal text-slate-500">· {file.sheet} 시트 · 헤더 {parse.headerRowNumber}행</span>
              </span>
            }
            actions={<Button onClick={reset}>다른 파일 선택</Button>}
          >
            {preview.alreadyImportedFile && (
              <div className="mb-3">
                <Notice tone="amber">이미 업로드된 파일입니다 ({localDateTime(preview.alreadyImportedFile.imported_at)}). 모든 거래가 '이미 등록된 거래'로 표시되며 다시 저장되지 않습니다.</Notice>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4 xl:grid-cols-8">
              {[
                ['전체 행', preview.summary.total],
                ['입금', preview.summary.deposits],
                ['출금', preview.summary.withdrawals],
                ['이미 등록된 거래', preview.summary.duplicates],
                ['자동매칭', preview.summary.autoMatched],
                ['확인필요', preview.summary.review],
                ['미매칭', preview.summary.unmatched],
                ['확정', preview.summary.selected],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md bg-slate-50 px-3 py-2">
                  <div className="text-xs text-slate-500">{k}</div>
                  <div className="text-lg font-semibold tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            {parse.warnings.length > 0 && (
              <details className="mt-3 text-xs text-slate-600">
                <summary className="cursor-pointer">파싱 참고사항 {parse.warnings.length}건</summary>
                <ul className="mt-1 list-disc pl-5">
                  {parse.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          <Card
            title="STEP 4 · 확인 및 확정"
            bodyClassName="p-0"
            actions={
              <>
                <Button onClick={() => void bulkUnconfirm(checkedRows.filter((r) => r.selected))} disabled={!checkedRows.some((r) => r.selected) || !!busy}>
                  선택 확정 해제
                </Button>
                <Button variant="primary" onClick={() => void bulkConfirm(checkedRows.filter(eligible))} disabled={!checkedRows.some(eligible) || !!busy}>
                  선택 항목 확정 ({checkedRows.filter(eligible).length})
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void bulkConfirm(allConfirmable)}
                  disabled={!allConfirmable.length || !!busy}
                  title="유사도 70% 이상 자동매칭 항목만 확정합니다. 경고 항목은 개별 확인이 필요합니다."
                >
                  전체 확정 ({allConfirmable.length})
                </Button>
              </>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
              <SegmentedControl
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `전체 ${count('all')}` },
                  { value: 'confirmed', label: `확정 ${count('confirmed')}` },
                  { value: 'waiting', label: `확인대기 ${count('waiting')}` },
                  { value: 'review', label: `확인필요 ${count('review')}` },
                  { value: 'unmatched', label: `미매칭 ${count('unmatched')}` },
                  { value: 'warning', label: `경고 ${count('warning')}` },
                  { value: 'duplicate', label: `중복 ${count('duplicate')}` },
                  { value: 'withdrawal', label: `출금 ${count('withdrawal')}` },
                ]}
              />
              {warningEligible.length > 0 && <span className="text-xs text-amber-700">경고 {warningEligible.length}건은 [전체 확정]에서 제외됩니다. 개별 확인 후 확정하세요.</span>}
            </div>
            <PreviewTable
              rows={filtered}
              checked={checked}
              onCheck={(n, v) =>
                setChecked((s) => {
                  const next = new Set(s);
                  if (v) next.add(n);
                  else next.delete(n);
                  return next;
                })
              }
              onCheckAll={(v) => setChecked(v ? new Set(filtered.filter((r) => !r.duplicate && r.depositAmount > 0).map((r) => r.excelRowNumber)) : new Set())}
              onConfirmSuggestion={(r) => void setDecision(r.excelRowNumber, { clientId: r.clientId, selected: true })}
              onToggle={(r) => void setDecision(r.excelRowNumber, { selected: !r.selected })}
              onEdit={setEditing}
              disabled={!!busy}
            />
          </Card>

          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-sm text-slate-600">
              STEP 5 · 신규 {rows.filter((r) => !r.duplicate).length}건 저장 · <b className="text-emerald-700">확정 {rows.filter((r) => r.selected).length}건</b> (배정{' '}
              {rows.filter((r) => r.selected).reduce((s, r) => s + r.allocation.length, 0)}개월) · 확인필요/미매칭 {rows.filter((r) => !r.duplicate && !r.selected && r.depositAmount > 0).length}건은 검토대기로 저장
            </div>
            <Button variant="success" size="lg" onClick={() => void commit()} disabled={!!busy || rows.every((r) => r.duplicate)}>
              최종 저장
            </Button>
          </div>
        </>
      )}

      {result && (
        <Card title="저장 완료">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
            {[
              ['신규 등록', result.inserted],
              ['중복(미등록)', result.duplicates],
              ['확정', result.confirmed],
              ['월분 배정', result.allocations],
              ['검토대기', result.pendingReview],
              ['별칭 학습', result.aliasesLearned],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">{k}</div>
                <div className="text-lg font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => navigate('/transactions')}>
              거래처 입출금내역 보기
            </Button>
            {result.pendingReview > 0 && <Button onClick={() => navigate('/transactions?match=NEEDS_REVIEW')}>검토대기 {result.pendingReview}건 처리</Button>}
            <Button onClick={reset}>다른 파일 업로드</Button>
          </div>
        </Card>
      )}

      {editing && preview && (
        <RowEditor
          row={editing}
          clients={clients}
          decision={decisions[editing.excelRowNumber] ?? {}}
          onClose={() => setEditing(null)}
          onApply={(patch) => {
            setEditing(null);
            void setDecision(editing.excelRowNumber, patch);
          }}
        />
      )}
    </div>
  );
}

function PreviewTable({
  rows,
  checked,
  onCheck,
  onCheckAll,
  onConfirmSuggestion,
  onToggle,
  onEdit,
  disabled,
}: {
  rows: PreviewRow[];
  checked: Set<number>;
  onCheck: (row: number, v: boolean) => void;
  onCheckAll: (v: boolean) => void;
  onConfirmSuggestion: (r: PreviewRow) => void;
  onToggle: (r: PreviewRow) => void;
  onEdit: (r: PreviewRow) => void;
  disabled: boolean;
}) {
  if (!rows.length) return <EmptyState>해당하는 행이 없습니다.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr className="text-left">
            <th className="w-8 px-3 py-2">
              <input type="checkbox" aria-label="전체 선택" onChange={(e) => onCheckAll(e.target.checked)} />
            </th>
            <th className="px-2 py-2">거래일시</th>
            <th className="px-2 py-2">통장명</th>
            <th className="px-2 py-2">추천 거래처</th>
            <th className="px-2 py-2 text-right">매칭률</th>
            <th className="px-2 py-2 text-right">입금액</th>
            <th className="px-2 py-2">추천 적용월</th>
            <th className="px-2 py-2">상태</th>
            <th className="px-2 py-2 text-right">작업</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => {
            const st = rowState(r);
            const canCheck = !r.duplicate && r.depositAmount > 0;
            return (
              <tr key={r.excelRowNumber} className={cx(r.duplicate && 'text-slate-400', r.selected && 'bg-emerald-50/40')}>
                <td className="px-3 py-2 align-top">
                  <input type="checkbox" disabled={!canCheck} checked={checked.has(r.excelRowNumber)} onChange={(e) => onCheck(r.excelRowNumber, e.target.checked)} />
                </td>
                <td className="px-2 py-2 align-top whitespace-nowrap tabular-nums">
                  {r.transactionDatetime.slice(0, 16)}
                  <div className="text-xs text-slate-400">Excel {r.excelRowNumber}행</div>
                </td>
                <td className="px-2 py-2 align-top font-medium">{r.senderRaw || <span className="text-slate-400">(빈 값)</span>}</td>
                <td className="px-2 py-2 align-top">
                  {r.clientName ? (
                    <div>
                      <span className="text-slate-400">→ </span>
                      {r.clientName}
                      {r.contractAmount !== null && <div className="text-xs text-slate-500">월 {won(r.contractAmount)}원</div>}
                    </div>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                  {r.autoMatch.reason && r.matchStatus !== 'MANUAL_MATCHED' && r.autoMatch.matchType !== 'ALIAS' && !r.duplicate && (
                    <div className={cx('mt-0.5 text-xs', r.matchStatus === 'AUTO_MATCHED' ? 'text-slate-500' : 'text-amber-700')}>{r.autoMatch.reason}</div>
                  )}
                </td>
                <td className="px-2 py-2 text-right align-top">{r.clientName || r.similarity ? <ScoreText score={r.similarity} /> : '-'}</td>
                <td className="px-2 py-2 text-right align-top whitespace-nowrap tabular-nums">
                  {r.depositAmount > 0 && <div className="font-medium">{won(r.depositAmount)}</div>}
                  {r.withdrawalAmount > 0 && <div className="text-xs text-slate-500">출금 {won(r.withdrawalAmount)}</div>}
                </td>
                <td className="px-2 py-2 align-top">
                  {r.allocation.length > 0 && !r.duplicate ? (
                    <div className="space-y-0.5 text-xs">
                      {r.allocation.map((l) => (
                        <div key={l.serviceMonth} className="whitespace-nowrap tabular-nums">
                          {l.serviceMonth} · {won(l.amount)} <span className={l.status === 'PAID' ? 'text-emerald-700' : 'text-amber-700'}>{l.status === 'PAID' ? '완납' : '부분납'}</span>
                        </div>
                      ))}
                      {!r.selected && <div className="text-slate-400">(확정 시 예상)</div>}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">-</span>
                  )}
                  {r.allocationError && !r.needsStartMonth && !r.duplicate && r.depositAmount > 0 && r.clientId != null && <div className="mt-0.5 text-xs text-rose-700">{r.allocationError}</div>}
                </td>
                <td className="px-2 py-2 align-top">
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {!r.duplicate && r.depositAmount > 0 && r.matchStatus !== 'UNMATCHED' && <MatchBadge status={r.matchStatus} />}
                    {r.feeWarning && !r.duplicate && <span className="text-xs text-amber-700">⚠ {r.feeWarning}</span>}
                    {r.duplicateSuspect && !r.duplicate && <span className="text-xs text-amber-700">⚠ {r.duplicateSuspect}</span>}
                    {r.note && <span className="text-xs text-slate-500">비고: {r.note}</span>}
                  </div>
                </td>
                <td className="px-2 py-2 text-right align-top whitespace-nowrap">
                  {canCheck && (
                    <div className="flex justify-end gap-1">
                      {r.matchStatus === 'REVIEW_REQUIRED' && r.clientId != null && (
                        <Button size="sm" variant="primary" disabled={disabled} onClick={() => onConfirmSuggestion(r)}>
                          확정
                        </Button>
                      )}
                      {r.selectable && (r.matchStatus === 'AUTO_MATCHED' || r.matchStatus === 'MANUAL_MATCHED') && (
                        <Button size="sm" variant={r.selected ? 'secondary' : 'primary'} disabled={disabled} onClick={() => onToggle(r)}>
                          {r.selected ? '확정 해제' : '확정'}
                        </Button>
                      )}
                      <Button size="sm" disabled={disabled} onClick={() => onEdit(r)}>
                        {r.needsStartMonth ? '첫 적용월' : r.clientId == null ? '거래처 선택' : '변경'}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
