import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { api } from '../../services/api';
import { Button, Card, ErrorBox, localDateTime, Notice, useAsync } from '../common/ui';
import { SummaryCards, type SummaryKey } from './SummaryCards';

export const summaryLink = (k: SummaryKey) =>
  ({
    monthDeposit: '/transactions?period=this-month&dir=deposit',
    monthWithdrawal: '/transactions?period=this-month&dir=withdrawal',
    unmatched: '/case-fee',
    partial: '/transactions?partial=1',
    unpaidClients: '/advisory?filter=UNPAID',
  })[k];

export function DashboardPage() {
  const navigate = useNavigate();
  const { dataVersion, clients, syncStatus, runSync, syncing } = useApp();
  const { data, error, reload } = useAsync(() => api.dashboard(), [dataVersion]);
  const noStart = clients.filter((c) => c.active && !c.management_start_month).length;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">대시보드</h1>
      <ErrorBox error={error} onRetry={reload} />
      <SummaryCards data={data} onSelect={(k) => navigate(summaryLink(k))} />

      {clients.length === 0 && (
        <Notice tone="amber">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>등록된 거래처가 없습니다. Google Sheet에서 거래처 정보를 먼저 불러와 주세요.</span>
            <Button variant="primary" size="sm" onClick={() => void runSync()} disabled={syncing}>
              거래처 정보 새로고침
            </Button>
          </div>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="바로가기">
          <div className="grid gap-2">
            <Button variant="primary" onClick={() => navigate('/upload')}>
              통장내역 Excel 업로드
            </Button>
            <Button onClick={() => navigate('/transactions')}>1. 거래처 입출금내역정리</Button>
            <Button onClick={() => navigate('/advisory')}>4. 노무 자문비 입출금 관련</Button>
          </div>
        </Card>
        <Card title="최근 상태">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">활성 거래처</dt>
              <dd className="tabular-nums">{data?.clientCount ?? '-'}곳</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">관리 시작월 미지정</dt>
              <dd className="tabular-nums">{noStart}곳</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">마지막 업로드</dt>
              <dd className="truncate text-right">{data?.lastImport ? `${data.lastImport.filename} (${localDateTime(data.lastImport.imported_at)})` : '없음'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">거래처 동기화</dt>
              <dd>{syncStatus?.lastSuccess ? localDateTime(syncStatus.lastSuccess.created_at) : '없음'}</dd>
            </div>
          </dl>
        </Card>
        <Card title="처리 원칙">
          <ul className="list-disc space-y-1 pl-4 text-sm text-slate-600">
            <li>입금은 입금일이 아니라 가장 오래된 미납월부터 순서대로 배정합니다.</li>
            <li>유사도 70% 미만이거나 후보가 비슷하면 사람이 확인합니다.</li>
            <li>CMS집금 등 공통 입금명은 자동 지정하지 않습니다.</li>
            <li>통장 원본 데이터는 수정되지 않습니다.</li>
          </ul>
        </Card>
      </div>
      {noStart > 0 && (
        <Notice>
          관리 시작월이 없는 거래처가 {noStart}곳 있습니다. 기존 <b>최종시트.xlsx</b>의 노무자문비를 가져오거나(설정 &gt; 기존 Excel 가져오기), 업로드 확인 단계에서 [첫 적용월 선택]으로 지정하세요.
        </Notice>
      )}
    </div>
  );
}
