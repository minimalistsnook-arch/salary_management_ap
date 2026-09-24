import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { api } from '../../services/api';
import { Button, Card, EmptyState, ErrorBox, localDateTime, Spinner, useAsync } from '../common/ui';

export function ImportHistoryPage() {
  const navigate = useNavigate();
  const { dataVersion } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.batches(), [dataVersion]);
  return (
    <Card bodyClassName="p-0" title="통장 Excel 가져오기 이력" actions={<Button onClick={() => navigate('/upload')}>새 파일 업로드</Button>}>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState>아직 업로드한 파일이 없습니다.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr className="text-left">
              <th className="px-4 py-2">가져온 시각</th>
              <th className="px-4 py-2">파일명</th>
              <th className="px-4 py-2 text-right">전체 행</th>
              <th className="px-4 py-2 text-right">신규 등록</th>
              <th className="px-4 py-2 text-right">중복(미등록)</th>
              <th className="px-4 py-2 text-right">확정 입금</th>
              <th className="px-4 py-2">파일 hash</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-2 tabular-nums">{localDateTime(b.imported_at)}</td>
                <td className="px-4 py-2 font-medium">{b.filename}</td>
                <td className="px-4 py-2 text-right tabular-nums">{b.total_rows}</td>
                <td className="px-4 py-2 text-right tabular-nums">{b.inserted_rows}</td>
                <td className="px-4 py-2 text-right text-slate-500 tabular-nums">{b.duplicate_rows}</td>
                <td className="px-4 py-2 text-right tabular-nums">{b.confirmed_rows}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-400" title={b.file_hash}>
                  {b.file_hash.slice(0, 12)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
