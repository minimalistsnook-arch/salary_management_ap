import type { ComponentType } from 'react';
import { AdvisoryPage } from '../features/advisory/AdvisoryPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { IndividualCasesPage } from '../features/individual/IndividualCasesPage';
import { ImportHistoryPage } from '../features/imports/ImportHistoryPage';
import { ComingSoonPage } from '../features/placeholder/ComingSoonPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TransactionsPage } from '../features/transactions/TransactionsPage';
import { UploadPage } from '../features/upload/UploadPage';

/**
 * 메뉴 모듈 등록부. 새 업무 기능(급여관리 수수료 등)은 여기에 페이지를 연결하면 된다.
 */
export interface AppModule {
  key: string;
  path: string;
  label: string;
  number?: number;
  section: 'main' | 'bottom' | 'hidden';
  comingSoon?: boolean;
  Component: ComponentType;
}

const soon = (title: string, description: string) => () => <ComingSoonPage title={title} description={description} />;

export const MODULES: AppModule[] = [
  { key: 'dashboard', path: '/', label: '대시보드', section: 'main', Component: DashboardPage },
  { key: 'ledger', path: '/transactions', label: '거래처 입출금내역정리', number: 1, section: 'main', Component: TransactionsPage },
  {
    key: 'payroll-fee',
    path: '/payroll-fee',
    label: '급여관리 수수료',
    number: 2,
    section: 'main',
    comingSoon: true,
    Component: soon('급여관리 수수료', '급여관리 수수료 규칙과 정산 기능은 다음 단계에서 제공됩니다.'),
  },
  {
    key: 'case-fee',
    path: '/case-fee',
    label: '개별건 입금 및 수수료 관리',
    number: 3,
    section: 'main',
    Component: IndividualCasesPage,
  },
  { key: 'advisory', path: '/advisory', label: '노무 자문비 입출금 관련', number: 4, section: 'main', Component: AdvisoryPage },
  { key: 'settings', path: '/settings', label: '설정', section: 'bottom', Component: SettingsPage },
  { key: 'imports', path: '/imports', label: '가져오기 이력', section: 'bottom', Component: ImportHistoryPage },
  { key: 'upload', path: '/upload', label: '통장내역 Excel 업로드', section: 'hidden', Component: UploadPage },
];
