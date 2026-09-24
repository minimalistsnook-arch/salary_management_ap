import { useMemo, useState } from 'react';
import type { MatchCandidate } from '../../domain/matching';
import { normalizeName } from '../../domain/normalize';
import type { Client } from '../../domain/types';
import { cx, inputCls, won } from './ui';

/** 거래처 검색 선택 (추천 후보 우선 표시) */
export function ClientPicker({
  clients,
  value,
  onChange,
  candidates = [],
  autoFocus,
}: {
  clients: Client[];
  value: number | null;
  onChange: (id: number) => void;
  candidates?: MatchCandidate[];
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const active = useMemo(() => clients.filter((c) => c.active), [clients]);
  const list = useMemo(() => {
    const nq = normalizeName(q);
    if (!nq) {
      const cand = candidates.map((c) => active.find((a) => a.id === c.clientId)).filter((c): c is Client => !!c);
      const rest = active.filter((c) => !cand.includes(c));
      return [...cand, ...rest];
    }
    return active.filter((c) => normalizeName(c.name).includes(nq) || c.name.includes(q.trim()));
  }, [q, active, candidates]);
  const candOf = (id: number) => candidates.find((c) => c.clientId === id);

  return (
    <div className="rounded-md border border-slate-300">
      <div className="border-b border-slate-200 p-2">
        <input autoFocus={autoFocus} className={inputCls} placeholder="거래처명 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {list.slice(0, 200).map((c) => {
          const cand = candOf(c.id);
          const s = cand?.score;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onChange(c.id)}
                className={cx('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-blue-50', value === c.id && 'bg-blue-50 font-medium text-blue-800')}
              >
                <span className="truncate">
                  {c.name}
                  {s !== undefined && <span className="ml-2 text-xs text-slate-500">추천 {s}%{cand?.viaAlias ? ` · A열 '${cand.viaAlias}'` : ''}</span>}
                </span>
                <span className="shrink-0 text-xs text-slate-500 tabular-nums">{won(c.current_contract_amount)}원</span>
              </button>
            </li>
          );
        })}
        {!list.length && <li className="px-3 py-4 text-center text-sm text-slate-500">검색 결과가 없습니다.</li>}
      </ul>
    </div>
  );
}
