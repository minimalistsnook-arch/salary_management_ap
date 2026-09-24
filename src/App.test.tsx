// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';

const client = { id: 1, name: '남산운수마을버스㈜', current_contract_amount: 220000, management_start_month: '2026-05', source_row: 8, active: 1, created_at: '', updated_at: '' };
const responses: Record<string, unknown> = {
  '/api/clients': { clients: [client], aliases: [] },
  '/api/clients/sync-status': { lastSuccess: null, lastAttempt: { created_at: '2026-09-24T00:00:00Z', status: 'FAILED', message: 'network' } },
  '/api/dashboard': { currentMonth: '2026-09', monthDeposit: 440000, monthWithdrawal: 0, unmatchedCount: 1, partialTxCount: 0, unpaidClientCount: 1, clientCount: 1, lastImport: null },
  '/api/transactions': [],
  '/api/advisory': {
    year: 2026,
    currentMonth: '2026-09',
    clients: [client],
    allocations: [
      { id: 1, client_id: 1, transaction_id: 1, service_month: '2026-05', payment_date: '2026-09-24', allocated_amount: 220000, contract_amount_snapshot: 220000, source: 'BANK', sender_raw: '남산운수 주식회사', transaction_datetime: '2026-09-24 10:00:00' },
      { id: 2, client_id: 1, transaction_id: 2, service_month: '2026-06', payment_date: '2026-09-24', allocated_amount: 110000, contract_amount_snapshot: 220000, source: 'BANK', sender_raw: '남산운수 주식회사', transaction_datetime: '2026-09-24 10:00:00' },
    ],
  },
  '/api/imports': [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = url.split('?')[0];
    return new Response(JSON.stringify(responses[path] ?? {}), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderAt = (path: string) => {
  window.history.pushState({}, '', path);
  return render(<App />);
};

test('사이드바 4개 대분류 + 준비중 표시, 상단 업로드/추출 버튼', async () => {
  renderAt('/');
  expect(await screen.findByText('거래처 입출금내역정리')).toBeDefined();
  expect(screen.getByText('급여관리 수수료')).toBeDefined();
  expect(screen.getByText('개별건 입금 및 수수료 관리')).toBeDefined();
  expect(screen.getByText('노무 자문비 입출금 관련')).toBeDefined();
  expect(screen.getAllByText('준비중')).toHaveLength(2);
  expect(screen.getAllByText(/통장내역 Excel 업로드/).length).toBeGreaterThan(0);
  expect(screen.getByText(/전체 Excel 추출/)).toBeDefined();
  expect(await screen.findByText(/거래처 정보 동기화 실패 \/ 마지막 성공: 없음/)).toBeDefined();
});

test('노무자문비 grid: 완납/부분납/미납 셀', async () => {
  renderAt('/advisory?year=2026');
  expect(await screen.findByText('110,000 / 220,000')).toBeDefined();
  expect(screen.getAllByText('9/24').length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText('미납').filter((el) => el.closest('td')).length).toBe(3); // 7·8·9월 셀
});

test('준비중 메뉴 placeholder', async () => {
  renderAt('/payroll-fee');
  expect(await screen.findByText(/다음 단계에서 제공됩니다/)).toBeDefined();
});

test('업로드 화면 STEP 표시', async () => {
  renderAt('/upload');
  expect(await screen.findByText(/STEP 1 · Excel 파싱/)).toBeDefined();
  expect(screen.getByText(/STEP 5 · 최종 저장/)).toBeDefined();
});
