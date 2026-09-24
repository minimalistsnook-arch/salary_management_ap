import { useMemo, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { GENERIC_SENDER_NAMES, normalizeName } from '../../domain/normalize';
import type { Client } from '../../domain/types';
import { api, errorMessage } from '../../services/api';
import { StartMonthDialog } from '../advisory/AdvisoryPage';
import { Badge, Button, Card, cx, EmptyState, ErrorBox, inputBase, localDateTime, SegmentedControl, toast, won } from '../common/ui';
import { LegacyImportPanel } from './LegacyImportPanel';

type Tab = 'clients' | 'aliases' | 'legacy' | 'rules';

export function SettingsPage() {
  const { clients, aliases, clientsError, reloadClients, syncStatus, syncing, runSync, bumpData } = useApp();
  const [tab, setTab] = useState<Tab>('clients');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Client | null>(null);
  const failed = syncStatus?.lastAttempt?.status === 'FAILED';

  const list = useMemo(() => {
    const nq = normalizeName(q);
    return clients.filter((c) => !nq || normalizeName(c.name).includes(nq));
  }, [clients, q]);

  return (
    <div className="space-y-4">
      <Card
        title="거래처 마스터 동기화 (Google Sheet · B열 거래처명 / C열 월 계약금액)"
        actions={
          <Button variant="primary" onClick={() => void runSync()} disabled={syncing}>
            {syncing ? '동기화 중…' : '거래처 정보 새로고침'}
          </Button>
        }
      >
        <dl className="grid gap-2 text-sm md:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">마지막 성공</dt>
            <dd>{syncStatus?.lastSuccess ? `${localDateTime(syncStatus.lastSuccess.created_at)} (${syncStatus.lastSuccess.client_count}곳 · ${syncStatus.lastSuccess.message ?? ''})` : '없음'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">마지막 시도</dt>
            <dd className={cx(failed && 'text-rose-700')}>
              {syncStatus?.lastAttempt ? `${localDateTime(syncStatus.lastAttempt.created_at)} · ${syncStatus.lastAttempt.status === 'SUCCESS' ? '성공' : '실패'}` : '없음'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">규칙</dt>
            <dd className="text-slate-600">실패 시 기존 거래처 유지 · 시트에서 빠진 거래처는 비활성 처리 · A열 값은 통장 별칭</dd>
          </div>
        </dl>
        {failed && (
          <p className="mt-2 text-sm text-rose-700">
            거래처 정보 동기화 실패 / 마지막 성공: {syncStatus?.lastSuccess ? localDateTime(syncStatus.lastSuccess.created_at) : '없음'} — {syncStatus?.lastAttempt?.message}
          </p>
        )}
      </Card>

      <SegmentedControl
        value={tab}
        onChange={setTab}
        options={[
          { value: 'clients', label: `거래처 마스터 ${clients.length}` },
          { value: 'aliases', label: `통장 별칭 ${aliases.length}` },
          { value: 'legacy', label: '기존 Excel(노무자문비) 가져오기' },
          { value: 'rules', label: '공통 입금명' },
        ]}
      />
      <ErrorBox error={clientsError} onRetry={reloadClients} />

      {tab === 'clients' && (
        <Card bodyClassName="p-0" title="거래처 마스터" actions={<input className={cx(inputBase, 'w-56')} placeholder="거래처 검색" value={q} onChange={(e) => setQ(e.target.value)} />}>
          {!list.length ? (
            <EmptyState>거래처가 없습니다. [거래처 정보 새로고침]을 실행하세요.</EmptyState>
          ) : (
            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                  <tr className="text-left">
                    <th className="px-4 py-2">거래처명</th>
                    <th className="px-4 py-2 text-right">월 계약금액</th>
                    <th className="px-4 py-2">관리 시작월</th>
                    <th className="px-4 py-2">상태</th>
                    <th className="px-4 py-2 text-right">시트 행</th>
                    <th className="px-4 py-2">수정일시</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-1.5 font-medium">{c.name}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{won(c.current_contract_amount)}</td>
                      <td className="px-4 py-1.5">
                        <button className={cx('hover:underline', c.management_start_month ? 'tabular-nums' : 'text-violet-700')} onClick={() => setEditing(c)}>
                          {c.management_start_month ?? '미지정 · 지정하기'}
                        </button>
                      </td>
                      <td className="px-4 py-1.5">{c.active ? <Badge tone="green">활성</Badge> : <Badge>비활성</Badge>}</td>
                      <td className="px-4 py-1.5 text-right text-slate-500 tabular-nums">{c.source_row ?? '-'}</td>
                      <td className="px-4 py-1.5 text-xs text-slate-500">{localDateTime(c.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'aliases' && (
        <Card bodyClassName="p-0" title="통장 별칭 (수동 확정 시 자동 학습 · 시트 A열)">
          {!aliases.length ? (
            <EmptyState>등록된 별칭이 없습니다.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr className="text-left">
                  <th className="px-4 py-2">통장 표기</th>
                  <th className="px-4 py-2">거래처</th>
                  <th className="px-4 py-2">출처</th>
                  <th className="px-4 py-2">등록일시</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {aliases.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-1.5 font-medium">{a.raw_sender}</td>
                    <td className="px-4 py-1.5">{a.client_name}</td>
                    <td className="px-4 py-1.5">{a.source === 'SHEET' ? <Badge tone="blue">시트</Badge> : <Badge tone="violet">수동 확정</Badge>}</td>
                    <td className="px-4 py-1.5 text-xs text-slate-500">{localDateTime(a.created_at)}</td>
                    <td className="px-4 py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm(`별칭 '${a.raw_sender}' → ${a.client_name} 을(를) 삭제할까요? 기존 거래 기록은 바뀌지 않습니다.`)) return;
                          try {
                            await api.deleteAlias(a.id);
                            await reloadClients();
                            toast('별칭 삭제');
                          } catch (e) {
                            toast(errorMessage(e), 'err');
                          }
                        }}
                      >
                        삭제
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'legacy' && <LegacyImportPanel />}

      {tab === 'rules' && (
        <Card title="공통 입금명 (자동 매칭·별칭 저장 금지)">
          <p className="mb-3 text-sm text-slate-600">아래 이름(또는 CMS·카드로 시작하는 이름)으로 들어온 입금은 여러 거래처가 함께 쓰므로 '거래처 확인 필요'로 보내고 사람이 직접 선택합니다.</p>
          <div className="flex flex-wrap gap-1.5">
            {GENERIC_SENDER_NAMES.map((n) => (
              <Badge key={n}>{n}</Badge>
            ))}
          </div>
        </Card>
      )}

      {editing && (
        <StartMonthDialog
          client={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reloadClients();
            bumpData();
          }}
        />
      )}
    </div>
  );
}
