export interface FingerprintInput {
  transactionDatetime: string;
  senderRaw: string;
  withdrawalAmount: number;
  depositAmount: number;
  excelRowNumber: number;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** 거래일시 + 보낸분 + 출금액 + 입금액 + Excel 행번호 → 거래 고유 hash */
export function transactionFingerprint(t: FingerprintInput): Promise<string> {
  const src = ['v1', t.transactionDatetime, t.senderRaw, String(t.withdrawalAmount), String(t.depositAmount), String(t.excelRowNumber)].join('\u001f');
  return sha256Hex(src);
}

/** 행번호를 제외한 거래 내용 key (다른 파일에 같은 거래가 있는지 '중복 의심' 경고용) */
export function contentKey(t: Omit<FingerprintInput, 'excelRowNumber'>): string {
  return [t.transactionDatetime, t.senderRaw.trim(), t.withdrawalAmount, t.depositAmount].join('|');
}
