import { useMemo, useState } from 'react';
import { useApp } from '../../app/AppContext';
import type { BaselinePreviewResponse } from '../../domain/dto';
import { api, errorMessage } from '../../services/api';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, Notice, SegmentedControl, Spinner, toast } from '../common/ui';

type Filter = 'all' | 'bank' | 'record' | 'warn' | 'none';

/** 회원사별 마지막 입금(월분·입금일) 기준표 붙여넣기 → 미리보기 → 반영 */
export function BaselinePanel() {
  const { bumpData, reloadClients } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<BaselinePreviewResponse | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.baselinePreview(text));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    const n = preview.rows.filter((r) => r.mode === 'BASELINE').length;
    if (!window.confirm(`회원사 ${n}곳의 마지막 입금을 기준으로 월분 배정을 다시 맞춥니다.\n\n· 기존 통장 입금 배정은 기준표에 맞게 다시 계산됩니다\n· 이후 올리는 통장 입금은 다음 월분부터 자동 배정됩니다\n\n계속할까요?`)) return;
    setBusy(true);
    try {
      const r = await api.baselineApply(text);
      toast(`기준표 반영 완료: 회원사 ${r.clients}곳 · 기존 기록 ${r.baselineRecords}건 · 통장 입금 ${r.deposits}건 재배정`);
      await reloadClients();
      bumpData();
      setPreview(await api.baselinePreview(text));
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    const all = preview?.rows ?? [];
    return all.filter((r) =>
      filter === 'all'
        ? true
        : filter === 'bank'
          ? r.mode === 'BASELINE' && r.deposits.length > 0
          : filter === 'record'
            ? !!r.baselineRecord
            : filter === 'warn'
              ? r.warnings.length > 0
              : r.mode !== 'BASELINE',
    );
  }, [preview, filter]);

  const all = preview?.rows ?? [];
  return (
    <div className="space-y-4">
      <Card title="마지막 입금 기준표 반영">
        <div className="space-y-3 text-sm">
          <Notice>
            엑셀에서 <b>연번 · 회원사 · 계약금액 · 계약형태 · 입금예상일 · N월분 · 입금일(MM/DD) · 담당</b> 열을 복사해 붙여넣으세요. 회원사별 마지막 입금 월분을 기준으로 맞추고, 이후 통장 Excel 입금은
            <b> 그다음 월분부터</b> 자동 배정됩니다. 통장에 같은 날 입금이 있으면 그 입금을 기준 월분으로 두고, 없으면(CMS 묶음 등) 기존 기록으로 남깁니다.
          </Notice>
          <textarea
            className="h-48 w-full rounded-md border border-slate-300 p-2 font-mono text-xs focus:border-blue-600 focus:outline-none"
            placeholder={'1\t세인트팩㈜\t110,000\tCMS\t20\t8월분\t08/21\t민주\n2\t제이튜브\t110,000\tCMS\t말일\t9월분\t09/01\t은혜'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void run()}>
              미리보기
            </Button>
            <Button variant="success" disabled={busy || !preview || !all.some((r) => r.mode === 'BASELINE')} onClick={() => void apply()}>
              반영하기
            </Button>
          </div>
          {busy && <Spinner label="계산 중…" />}
          <ErrorBox error={error} />
          {preview?.errors.length ? (
            <ul className="list-disc pl-5 text-rose-700">
              {preview.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {preview && (
        <Card
          bodyClassName="p-0"
          title={`미리보기 · ${all.length}행 (기준일 ${preview.reference})`}
          actions={
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `전체 ${all.length}` },
                { value: 'bank', label: `통장 입금 재배정 ${all.filter((r) => r.mode === 'BASELINE' && r.deposits.length).length}` },
                { value: 'record', label: `기존 기록 ${all.filter((r) => r.baselineRecord).length}` },
                { value: 'warn', label: `경고 ${all.filter((r) => r.warnings.length).length}` },
                { value: 'none', label: `제외 ${all.filter((r) => r.mode !== 'BASELINE').length}` },
              ]}
            />
          }
        >
          {!rows.length ? (
            <EmptyState>해당하는 행이 없습니다.</EmptyState>
          ) : (
            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs whitespace-nowrap text-slate-500">
                  <tr className="text-left">
                    <th className="px-3 py-2">연번</th>
                    <th className="px-3 py-2">회원사</th>
                    <th className="px-3 py-2">마지막 입금</th>
                    <th className="px-3 py-2">기존 기록</th>
                    <th className="px-3 py-2">통장 입금 → 적용월</th>
                    <th className="px-3 py-2">관리 시작월</th>
                    <th className="px-3 py-2">비고</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.line} className={cx(r.mode !== 'BASELINE' && 'text-slate-400')}>
                      <td className="px-3 py-1.5 align-top tabular-nums">{r.seq}</td>
                      <td className="px-3 py-1.5 align-top">
                        <div className="font-medium">{r.clientName ?? r.name}</div>
                        {r.clientName && r.clientName !== r.name && <div className="text-xs text-slate-500">표: {r.name}</div>}
                      </td>
                      <td className="px-3 py-1.5 align-top whitespace-nowrap tabular-nums">{r.lastMonth ? `${r.lastMonth} · ${r.lastDate}` : '입금기록 없음'}</td>
                      <td className="px-3 py-1.5 align-top text-xs tabular-nums">{r.baselineRecord ? `${r.baselineRecord.month} (${r.baselineRecord.date.slice(5)})` : '-'}</td>
                      <td className="px-3 py-1.5 align-top text-xs">
                        {r.deposits.map((d) => (
                          <div key={d.id} className="whitespace-nowrap tabular-nums">
                            {d.date.slice(5)} {d.amount.toLocaleString('ko-KR')} → <b>{d.after.join(', ') || '-'}</b>
                            {d.before.length > 0 && d.before.join() !== d.after.join() && <span className="ml-1 text-slate-400">(기존 {d.before.join(', ')})</span>}
                            {!d.wasConfirmed && <span className="ml-1 text-amber-700">추천→확정</span>}
                          </div>
                        ))}
                        {!r.deposits.length && '-'}
                      </td>
                      <td className="px-3 py-1.5 align-top tabular-nums">{r.startMonth ?? '-'}</td>
                      <td className="px-3 py-1.5 align-top text-xs">
                        {r.mode === 'NO_CLIENT' && <Badge tone="red">거래처 없음</Badge>}
                        {r.mode === 'NO_RECORD' && <Badge>입금기록 없음 · 부가정보만</Badge>}
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
          )}
        </Card>
      )}
    </div>
  );
}
