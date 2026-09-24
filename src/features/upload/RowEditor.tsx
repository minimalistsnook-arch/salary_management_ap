import { useState } from 'react';
import type { PreviewRow, RowDecision } from '../../domain/dto';
import type { Client } from '../../domain/types';
import { ClientPicker } from '../common/ClientPicker';
import { Button, Field, inputCls, Overlay, won } from '../common/ui';

/** 업로드 확인 단계: 거래처 선택 / 첫 적용월 / 비고 */
export function RowEditor({ row, clients, decision, onClose, onApply }: { row: PreviewRow; clients: Client[]; decision: RowDecision; onClose: () => void; onApply: (d: RowDecision) => void }) {
  const [clientId, setClientId] = useState<number | null>(row.clientId);
  const [startMonth, setStartMonth] = useState<string>(decision.startMonth ?? '');
  const [note, setNote] = useState(decision.note ?? '');
  const client = clients.find((c) => c.id === clientId);
  const needsStart = !!client && !client.management_start_month && (row.needsStartMonth || clientId !== row.clientId);

  return (
    <Overlay
      open
      onClose={onClose}
      variant="modal"
      width="max-w-xl"
      title="거래처 · 적용월 지정"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            disabled={clientId == null}
            onClick={() => onApply({ clientId, startMonth: startMonth || null, note: note.trim() || null, selected: true })}
          >
            적용 후 확정
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-3">
          <div>
            <div className="text-xs text-slate-500">통장표기</div>
            <div className="font-medium">{row.senderRaw}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">입금액</div>
            <div className="font-medium tabular-nums">{won(row.depositAmount)}원</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">거래일시</div>
            <div className="tabular-nums">{row.transactionDatetime.slice(0, 16)}</div>
          </div>
        </div>
        {row.autoMatch.isGeneric && <p className="text-amber-700">공통 입금명(CMS집금 등)입니다. 거래처를 직접 선택해주세요. 이 이름은 별칭으로 저장되지 않습니다.</p>}
        <Field label="거래처">
          <ClientPicker clients={clients} value={clientId} onChange={setClientId} candidates={row.autoMatch.candidates} autoFocus />
        </Field>
        {client && (
          <p className="text-xs text-slate-600">
            선택: <b>{client.name}</b> · 월 {won(client.current_contract_amount)}원 · 관리 시작월 {client.management_start_month ?? '미지정'}
          </p>
        )}
        <Field
          label={needsStart ? '첫 적용월 (필수 — 기존 기록이 없는 거래처)' : '첫 적용월 (선택)'}
          hint="비워두면 관리 시작월 이후 가장 오래된 미납월부터 자동 배정합니다. 입금일로 월을 추측하지 않습니다."
        >
          <input type="month" className={inputCls} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
        </Field>
        <Field label="비고">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 대표자 개인 계좌 입금" />
        </Field>
      </div>
    </Overlay>
  );
}
