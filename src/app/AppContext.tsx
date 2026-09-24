import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClientsResponse, SyncStatus } from '../domain/dto';
import { normalizeName } from '../domain/normalize';
import type { Client } from '../domain/types';
import { api, errorMessage } from '../services/api';
import { toast } from '../features/common/ui';

interface AppState {
  clients: Client[];
  aliases: ClientsResponse['aliases'];
  clientsError: unknown;
  reloadClients: () => Promise<void>;
  syncStatus: SyncStatus | null;
  syncing: boolean;
  runSync: () => Promise<void>;
  /** 데이터 변경 후 각 화면 재조회용 버전 */
  dataVersion: number;
  bumpData: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [aliases, setAliases] = useState<ClientsResponse['aliases']>([]);
  const [clientsError, setClientsError] = useState<unknown>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  const reloadClients = useCallback(async () => {
    try {
      const r = await api.clients();
      setClients([...r.clients].sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name), 'ko')));
      setAliases(r.aliases);
      setClientsError(null);
    } catch (e) {
      setClientsError(e);
    }
    try {
      setSyncStatus(await api.syncStatus());
    } catch {
      /* 상태 표시만 생략 */
    }
  }, []);

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const r = await api.syncClients();
      setSyncStatus(r.status);
      if (r.ok) {
        toast(`거래처 정보 동기화 완료\n${r.message}${r.warnings.length ? `\n경고 ${r.warnings.length}건` : ''}`);
        await reloadClients();
        bumpData();
      } else toast(r.message, 'err');
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setSyncing(false);
    }
  }, [reloadClients, bumpData]);

  useEffect(() => {
    void reloadClients();
  }, [reloadClients]);

  const value = useMemo(
    () => ({ clients, aliases, clientsError, reloadClients, syncStatus, syncing, runSync, dataVersion, bumpData }),
    [clients, aliases, clientsError, reloadClients, syncStatus, syncing, runSync, dataVersion, bumpData],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider 가 필요합니다.');
  return v;
}
