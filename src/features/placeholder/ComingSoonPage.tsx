import { Card } from '../common/ui';

export function ComingSoonPage({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <div className="py-16 text-center">
        <div className="mx-auto mb-3 inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">준비중</div>
        <h2 className="text-base font-semibold text-slate-800">{title}</h2>
        <p className="mt-2 text-sm text-slate-500">{description}</p>
      </div>
    </Card>
  );
}
