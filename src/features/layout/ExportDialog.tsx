import { useState } from 'react';
import { api, errorMessage } from '../../services/api';
import { downloadWorkbook } from '../../services/excelExport';
import { Button, Field, inputCls, Overlay, toast } from '../common/ui';

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const data = await api.exportData(year);
      const name = await downloadWorkbook(data);
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
        <Field label="노무자문비 시트 기준 연도">
          <select className={inputCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </Field>
        <div className="rounded-md bg-slate-50 p-3 text-slate-600">
          포함 시트: 거래처입출금내역 · 노무자문비 · 미매칭검토 · 개별건 · 거래처마스터 · 가져오기이력
        </div>
      </div>
    </Overlay>
  );
}
