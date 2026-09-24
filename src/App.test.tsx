// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';

const client = { id: 1, name: '남산운수마을버스㈜', current_contract_amount: 220000, management_start_month: '2026-05', source_row: 8, active: 1, created_at: '', updated_at: '' };
const responses: Record<string, unknown> = {
  '/api/clients': { clients: [client], aliases: [] },
  '/api/clients/sync-status': { lastSuccess: null, lastAttempt: { created_at: '2026-09-24T00:00:00Z', status: 'FAILED', message: 'network' } },
  '/api/dashboard': { currentMonth: '2026-09', monthDeposit: 440000, monthWithdrawal: 0, unmatchedCount: 1, partialTxCount: 0, unpaidClientCount: 1, clientCount: 1, lastImport: null },
  '/api/transactions': [
    { id: 1, import_batch_id: 1, excel_row_number: 2, bank_row_no: '1', transaction_datetime: '2026-09-24 10:00:00', sender_raw: '남산운수 주식회사', withdrawal_amount: 0, deposit_amount: 220000, transaction_hash: 'a', created_at: '', filename: 'a.xlsx', client_id: 1, client_name: '남산운수마을버스㈜', contract_amount: 220000, similarity_score: 80, match_type: 'MANUAL', match_status: 'MANUAL_MATCHED', note: null, allocations: [] },
    { id: 2, import_batch_id: 1, excel_row_number: 3, bank_row_no: '2', transaction_datetime: '2026-09-24 11:00:00', sender_raw: '홍길동상회', withdrawal_amount: 0, deposit_amount: 50000, transaction_hash: 'b', created_at: '', filename: 'a.xlsx', client_id: null, client_name: null, contract_amount: null, similarity_score: 30, match_type: 'NONE', match_status: 'UNMATCHED', note: null, allocations: [] },
  ],
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
  '/api/individual': [
    { id: 9, import_batch_id: 1, excel_row_number: 3, bank_row_no: '2', transaction_datetime: '2026-09-24 11:00:00', sender_raw: '남산상운', withdrawal_amount: 0, deposit_amount: 50000, transaction_hash: 'x', created_at: '', filename: 'a.xlsx', client_id: null, client_name: null, contract_amount: null, similarity_score: 0, match_type: 'NONE', match_status: 'UNMATCHED', note: null, allocations: [], bestCandidate: { clientId: 1, clientName: '남산운수마을버스㈜', score: 45 }, similar: true, isGeneric: false },
  ],
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
  expect(screen.getAllByText('준비중')).toHaveLength(1); // 2번만 준비중, 3번은 개별건 구현
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

test('개별건: 매칭되지 않은 입금 목록 + 40% 이상 유사 표시', async () => {
  renderAt('/case-fee');
  expect(await screen.findByText('남산상운')).toBeDefined();
  expect(screen.getByText('45%')).toBeDefined();
  expect(screen.getAllByText('유사').filter((el) => el.closest('td'))).toHaveLength(1);
});

test('거래처 입출금내역정리에는 확정된 입금만, 매칭 안 된 입금은 개별건으로 안내', async () => {
  renderAt('/transactions?year=2026');
  expect(await screen.findByText('남산운수 주식회사')).toBeDefined();
  expect(screen.queryByText('홍길동상회')).toBeNull();
  expect(screen.getByText(/매칭 안 된 입금 1건/)).toBeDefined();
});
