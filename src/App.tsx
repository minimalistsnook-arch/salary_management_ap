import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './app/AppContext';
import { MODULES } from './app/modules';
import { ToastHost } from './features/common/ui';
import { AppLayout } from './features/layout/AppLayout';
import { ComingSoonPage } from './features/placeholder/ComingSoonPage';

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppLayout>
          <Routes>
            {MODULES.map((m) => (
              <Route key={m.key} path={m.path} element={<m.Component />} />
            ))}
            <Route path="*" element={<ComingSoonPage title="페이지를 찾을 수 없습니다" description="왼쪽 메뉴에서 이동해주세요." />} />
          </Routes>
        </AppLayout>
        <ToastHost />
      </AppProvider>
    </BrowserRouter>
  );
}
