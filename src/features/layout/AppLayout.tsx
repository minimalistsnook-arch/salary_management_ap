import { useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { MODULES } from '../../app/modules';
import { Button, cx, localDateTime } from '../common/ui';
import { ExportDialog } from './ExportDialog';

function Sidebar() {
  const item = (m: (typeof MODULES)[number]) => (
    <NavLink
      key={m.key}
      to={m.path}
      end={m.path === '/'}
      className={({ isActive }) =>
        cx(
          'flex items-start gap-2 rounded-md px-3 py-2 text-sm leading-snug',
          isActive ? 'bg-slate-800 font-medium text-white' : m.comingSoon ? 'text-slate-400 hover:bg-slate-800/50' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
        )
      }
    >
      {m.number !== undefined && <span className="w-4 shrink-0 text-slate-500 tabular-nums">{m.number}.</span>}
      <span className="flex-1">
        {m.label}
        {m.comingSoon && <span className="ml-1.5 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">준비중</span>}
      </span>
    </NavLink>
  );
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-200 max-lg:w-52">
      <div className="border-b border-slate-800 px-4 py-4">
        <div className="text-[15px] font-semibold text-white">노무자문 입출금 관리</div>
        <div className="mt-0.5 text-xs text-slate-400">내부 업무용</div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">{MODULES.filter((m) => m.section === 'main').map(item)}</nav>
      <nav className="space-y-0.5 border-t border-slate-800 p-2">{MODULES.filter((m) => m.section === 'bottom').map(item)}</nav>
    </aside>
  );
}

function SyncIndicator() {
  const { syncStatus, syncing, runSync } = useApp();
  const failed = syncStatus?.lastAttempt?.status === 'FAILED';
  const last = syncStatus?.lastSuccess ? localDateTime(syncStatus.lastSuccess.created_at) : '없음';
  return (
    <div className="flex items-center gap-2">
      <div className={cx('text-right text-xs leading-tight', failed ? 'text-rose-700' : 'text-slate-500')} title={failed ? (syncStatus?.lastAttempt?.message ?? '') : undefined}>
        {failed ? <div className="font-medium">거래처 정보 동기화 실패 / 마지막 성공: {last}</div> : <div>거래처 동기화: {last}</div>}
      </div>
      <Button size="sm" onClick={() => void runSync()} disabled={syncing}>
        {syncing ? '동기화 중…' : '거래처 정보 새로고침'}
      </Button>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const [exportOpen, setExportOpen] = useState(false);
  const current = MODULES.find((m) => (m.path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(m.path)));
  return (
    <div className="flex h-screen min-w-[900px] bg-slate-100 text-slate-800">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center gap-3">
            <Button variant="primary" size="lg" onClick={() => navigate('/upload')}>
              ⤒ 통장내역 Excel 업로드
            </Button>
            <Button onClick={() => setExportOpen(true)}>⤓ 전체 Excel 추출</Button>
          </div>
          <SyncIndicator />
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[1600px] p-5">
            {current && current.key !== 'dashboard' && (
              <h1 className="mb-4 text-lg font-semibold text-slate-900">
                {current.number !== undefined && <span className="mr-1 text-slate-400">{current.number}.</span>}
                {current.label}
              </h1>
            )}
            {children}
          </div>
        </main>
      </div>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
