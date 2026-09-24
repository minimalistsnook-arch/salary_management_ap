import { useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import type { LegacyPreviewResponse } from '../../domain/dto';
import { parseLegacyAdvisorySheet, type LegacyParseResult } from '../../domain/legacyAdvisoryParser';
import { api } from '../../services/api';
import { readExcelFile, type ReadWorkbook } from '../../services/excelRead';
import { Badge, Button, Card, ErrorBox, inputBase, inputCls, Notice, ScoreText, Spinner, toast, won } from '../common/ui';

/** 기존 '최종시트.xlsx' 의 '노무자문비' 시트 → 초기 월별 입금 상태 (최초 1회) */
export function LegacyImportPanel() {
  const { clients, bumpData, reloadClients } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [wb, setWb] = useState<ReadWorkbook | null>(null);
  const [sheet, setSheet] = useState('');
  const [startYear, setStartYear] = useState('');
  const [parsed, setParsed] = useState<LegacyParseResult | null>(null);
  const [preview, setPreview] = useState<LegacyPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (w: ReadWorkbook, sheetName: string, sy: string, map: Record<number, number | null>) => {
    setError(null);
    const s = w.sheets.find((x) => x.name === sheetName);
    if (!s) return;
    const p = parseLegacyAdvisorySheet(s.rows, s.firstRowNumber, sy ? Number(sy) : undefined);
    setParsed(p);
    setPreview(null);
    if (p.errors.length) return;
    setBusy(true);
    try {
      setPreview(await api.legacyPreview({ clients: p.clients, mapping: map }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const w = await readExcelFile(f);
      setWb(w);
      const name = w.sheets.find((s) => s.name.replace(/\s/g, '').includes('노무자문비'))?.name ?? w.sheets[0]?.name ?? '';
      setSheet(name);
      setMapping({});
      await run(w, name, startYear, {});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!parsed || !preview) return;
    const target = preview.rows.filter((r) => r.clientId != null && r.snapshotAmount);
    const months = target.reduce((s, r) => s + r.monthCount - r.existingMonths, 0);
    if (!window.confirm(`거래처 ${target.length}곳, 약 ${months}개월의 기존 입금 기록을 가져옵니다.\n이미 배정이 있는 월은 건너뜁니다. 계속할까요?`)) return;
    setBusy(true);
    try {
      const r = await api.legacyCommit({ clients: parsed.clients, mapping });
      toast(`가져오기 완료: 거래처 ${r.clients}곳 · 배정 ${r.allocations}건 · 건너뜀 ${r.skippedMonths}개월`);
      await reloadClients();
      bumpData();
      await run(wb as ReadWorkbook, sheet, startYear, mapping);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const changeMap = (row: number, v: string) => {
    const next = { ...mapping, [row]: v === '' ? null : Number(v) };
    setMapping(next);
    if (wb) void run(wb, sheet, startYear, next);
  };

  return (
    <div className="space-y-4">
      <Card title="기존 Excel(최종시트.xlsx) · 노무자문비 시트 가져오기">
        <div className="space-y-3 text-sm">
          <Notice>
            거래처별 행 / 연도·월 열 / 셀에 입금일(예: 9/24)이 있는 시트를 읽어 기존 월별 입금 상태를 만듭니다. 입금일이 있는 월은 계약금액 전액 납부(완납)로 기록하며, 원본 Excel은 수정하지
            않습니다. 이미 배정이 있는 월은 건너뛰므로 여러 번 실행해도 중복되지 않습니다.
          </Notice>
          <div className="flex flex-wrap items-end gap-2">
            <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={busy}>
              Excel 파일 선택
            </Button>
            {wb && (
              <>
                <label className="text-xs text-slate-500">
                  시트
                  <select
                    className={`${inputBase} mt-0.5 w-44`}
                    value={sheet}
                    onChange={(e) => {
                      setSheet(e.target.value);
                      void run(wb, e.target.value, startYear, mapping);
                    }}
                  >
                    {wb.sheets.map((s) => (
                      <option key={s.name}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-500">
                  시작 연도 (헤더에 연도가 없을 때)
                  <input className={`${inputBase} mt-0.5 w-32`} placeholder="예: 2024" value={startYear} onChange={(e) => setStartYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                </label>
                <Button onClick={() => void run(wb, sheet, startYear, mapping)} disabled={busy}>
                  다시 읽기
                </Button>
                <span className="text-xs text-slate-500">{wb.filename}</span>
              </>
            )}
          </div>
          {busy && <Spinner />}
          <ErrorBox error={error} />
          {parsed?.errors.length ? (
            <ul className="list-disc pl-5 text-rose-700">
              {parsed.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {parsed && parsed.warnings.length > 0 && (
            <details className="text-xs text-amber-800">
              <summary className="cursor-pointer">읽지 못한 셀 {parsed.warnings.length}건</summary>
              <ul className="mt-1 list-disc pl-5">
                {parsed.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Card>

      {preview && (
        <Card
          bodyClassName="p-0"
          title={`미리보기 · ${preview.rows.length}행 (연결 ${preview.rows.filter((r) => r.clientId != null).length}곳)`}
          actions={
            <Button variant="success" onClick={() => void commit()} disabled={busy || !preview.rows.some((r) => r.clientId != null)}>
              가져오기 실행
            </Button>
          }
        >
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                <tr className="text-left">
                  <th className="px-3 py-2">행</th>
                  <th className="px-3 py-2">Excel 거래처명</th>
                  <th className="px-3 py-2">연결할 거래처 (정식명)</th>
                  <th className="px-3 py-2 text-right">유사도</th>
                  <th className="px-3 py-2 text-right">기록 계약금액</th>
                  <th className="px-3 py-2">입금 월</th>
                  <th className="px-3 py-2">비고</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.rows.map((r) => (
                  <tr key={r.excelRowNumber}>
                    <td className="px-3 py-1.5 text-xs text-slate-400 tabular-nums">{r.excelRowNumber}</td>
                    <td className="px-3 py-1.5 font-medium">{r.name}</td>
                    <td className="px-3 py-1.5">
                      <select className={`${inputCls} h-8`} value={r.clientId ?? ''} onChange={(e) => changeMap(r.excelRowNumber, e.target.value)}>
                        <option value="">가져오지 않음</option>
                        {r.autoMatch.candidates.map((c) => (
                          <option key={`c${c.clientId}`} value={c.clientId}>
                            ★ {c.clientName} ({c.score}%)
                          </option>
                        ))}
                        {clients
                          .filter((c) => c.active && !r.autoMatch.candidates.some((x) => x.clientId === c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right">{r.autoMatch.candidates[0] ? <ScoreText score={r.autoMatch.candidates[0].score} /> : '-'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{won(r.snapshotAmount)}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums">
                      {r.monthCount ? `${r.firstMonth} 부터 ${r.monthCount}개월` : '-'}
                      {r.existingMonths > 0 && <span className="ml-1 text-slate-500">(기존 {r.existingMonths} 건너뜀)</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.clientId == null && r.autoMatch.status !== 'AUTO_MATCHED' && <Badge tone="amber">거래처 확인 필요</Badge>}
                      {r.warnings.map((w) => (
                        <div key={w} className="text-amber-700">
                          {w}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
