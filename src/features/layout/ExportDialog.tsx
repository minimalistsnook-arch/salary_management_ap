import { useState } from 'react';
import { api, errorMessage } from '../../services/api';
import { downloadWorkbook } from '../../services/excelExport';
import { Button, Field, inputCls, Overlay, toast } from '../common/ui';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [year, setYear] = useState<number | null>(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const data = await api.exportData(new Date().getFullYear());
      const name = await downloadWorkbook(data, year);
      toast(`${name} 다운로드`);
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const years = Array.from({ length: 7 }, (_, i) => new Date().getFullYear() - 4 + i);
  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="modal"
      title="전체 Excel 추출"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? '생성 중…' : '다운로드'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Field label="입출금내역 · 급여관리 · 개별건 기간 (입금일 기준)" hint="노무자문비 시트는 항상 전체 연도(연도별 1~12월)로 추출됩니다.">
          <select className={inputCls} value={year ?? 'all'} onChange={(e) => setYear(e.target.value === 'all' ? null : Number(e.target.value))}>
            <option value="all">전체 기간</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </Field>
        <div className="rounded-md bg-slate-50 p-3 text-slate-600">
          <div className="mb-1 font-medium text-slate-700">추출 양식</div>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>입출금내역 — 수입: 입금일 · 적요(거래처 + 해당 월) · 수입금액</li>
            <li>급여관리 — 번호 · 이름 · 공급가액 · 부가세 · 입금일 · 입금액</li>
            <li>개별건 — 번호 · 상호 · 공급가액 · 부가세 · 입금일 · 입금액</li>
            <li>노무자문비 — [ 매 출 ]-회원사 양식 (연도/월별 입금일)</li>
          </ol>
        </div>
      </div>
    </Overlay>
  );
}
