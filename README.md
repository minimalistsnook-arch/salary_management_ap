# 노무자문 입출금 관리

거래처별 입금·출금, 월별 노무자문료 납입 현황을 관리하는 내부 업무용 웹 프로그램입니다.

| 메뉴 | 상태 |
| --- | --- |
| 1. 거래처 입출금내역정리 | 구현 |
| 2. 급여관리 수수료 | 준비중 (placeholder) |
| 3. 개별건 입금 및 수수료 관리 | 준비중 (placeholder) |
| 4. 노무 자문비 입출금 관련 | 구현 |

스택: React 18 · TypeScript · Vite · Tailwind CSS v4 · Cloudflare Pages Functions · Cloudflare D1(SQLite) · SheetJS(xlsx)

## 실행

```bash
npm install
npm start            # http://localhost:3000 (화면 + /api 로컬 서버)
```

- 로컬 개발에서는 Vite 플러그인(`server/dev/viteApiPlugin.ts`)이 `/api/*`를 운영과 같은 라우터(`server/router.ts`)로 처리합니다.
- 로컬 DB는 `.data/local.sqlite`(node:sqlite, Node 22.5 이상)이며, `migrations/*.sql`이 자동 적용됩니다. 새로고침이나 재시작 후에도 데이터가 유지됩니다.
- 처음 실행하면 상단 **[거래처 정보 새로고침]**으로 Google Sheet 거래처를 불러옵니다.

> 기본 Codespaces 이미지(Ubuntu 20.04, glibc 2.31)에서는 Cloudflare 로컬 런타임(workerd)이 실행되지 않습니다. 그래서 위 방식으로 개발합니다. glibc 2.35 이상 환경에서는 `npm run dev:cf`로 wrangler + 로컬 D1을 쓸 수 있습니다.

## 테스트 / 빌드

```bash
npm test             # vitest: 도메인 단위 + 서버 통합(실제 migration SQL) + UI smoke
npm run typecheck
npm run build        # tsc --noEmit && vite build
```

요구사항의 테스트 케이스 위치:

| 케이스 | 파일 |
| --- | --- |
| CASE 1 남산운수 440,000 → 5·6월 PAID | `src/domain/allocation.test.ts`, `server/services/integration.test.ts` |
| CASE 2 660,000 → 3개월 | `src/domain/allocation.test.ts` |
| CASE 3 330,000 → PAID + PARTIAL | `src/domain/allocation.test.ts` |
| CASE 4 같은 파일 2번 업로드 → 0건 | `server/services/integration.test.ts` |
| CASE 5 69% → REVIEW_REQUIRED | `src/domain/matching.test.ts` |
| CASE 6 82% / 80% → REVIEW_REQUIRED | `src/domain/matching.test.ts` |
| CASE 7 2026-11부터 3개월 → 2027-01 | `src/domain/allocation.test.ts` |
| CASE 8 부분납 110,000 + 110,000 → PAID | `src/domain/allocation.test.ts` |
| CASE 9 CMS집금 → 자동지정 금지 | `src/domain/matching.test.ts`, `server/services/integration.test.ts` |

## 배포 (Cloudflare Pages + D1)

```bash
npx wrangler login
npx wrangler d1 create labor-advisory-ledger     # 출력된 database_id를 wrangler.toml에 입력
npm run db:migrate:remote
npm run deploy                                   # build + wrangler pages deploy
```

Pages 프로젝트 설정 > Functions > D1 bindings에 `DB`가 연결되어 있어야 합니다.

## 환경변수

`wrangler.toml`의 `[vars]`에 두고, 비밀값은 `wrangler pages secret put` 또는 로컬 `.dev.vars`에 넣습니다.

| 이름 | 설명 | 기본값 |
| --- | --- | --- |
| `GOOGLE_SHEET_ID` | 거래처 마스터 Google Sheet ID | 제공된 시트 |
| `GOOGLE_SHEET_GID` | 시트 탭 gid | `0` |
| `CLIENT_SOURCE_MODE` | `csv`(공개 링크) 또는 `api`(Sheets API) | `csv` |
| `GOOGLE_API_KEY` | `api` 모드용 API Key (secret) | - |
| `GOOGLE_SHEET_RANGE` | `api` 모드 읽기 범위 | `A:C` |
| `LOCAL_DB_PATH` | 로컬 개발 DB 경로 | `.data/local.sqlite` |

## 구조

```
src/domain/            순수 로직 (브라우저·서버 공용, 단위 테스트 대상)
  normalize.ts           거래처명 정규화, 공통 입금명(CMS집금 등)
  matching.ts            유사도 · 70% / 5% 차이 매칭 판정
  allocation.ts          계약금액 기준 월분 배정 (가장 오래된 미납월부터, snapshot)
  bankExcelParser.ts     통장 Excel 파서 (헤더 자동 탐지, 행 단위 오류)
  legacyAdvisoryParser.ts 기존 '노무자문비' 시트 파서
  clientSheet.ts         거래처 마스터 시트 해석 (B=거래처명, C=계약금액, A=별칭)
  fingerprint.ts         거래/파일 SHA-256
  advisoryGrid.ts        연간 12개월 셀 상태 계산
  feeCheck.ts            수수료 차감 가능성 경고
server/
  router.ts              /api 라우터 (Pages Functions와 로컬 dev가 공용)
  services/bankImport/       업로드 preview/commit
  services/clientMatching/   매칭 인덱스, alias 학습
  services/paymentAllocation/ 배정 계획, 거래처 변경·수동 배정·취소
  services/clientSync/       Google Sheet adapter(CSV/API) + 동기화
  services/legacyImport/     최종시트.xlsx 노무자문비 초기 가져오기
  services/query/            목록·대시보드·Excel 추출 데이터
  dev/                   로컬 개발용 node:sqlite + Vite 플러그인
functions/api/[[path]].ts Cloudflare Pages Function 진입점
migrations/0001_init.sql D1 스키마
src/app/modules.tsx      메뉴 등록부 (새 업무 모듈은 여기에 추가)
src/features/*           화면
src/services/            API 클라이언트, Excel 읽기, Excel 전체 추출
```

## 핵심 규칙

- 입금 월분은 입금일로 추측하지 않고, 관리 시작월 이후 **가장 오래된 미납월부터** 순서대로 배정합니다.
- 기존 기록도 관리 시작월도 없으면 **"월 배정 필요"**로 표시하고, 사용자가 첫 적용월을 선택합니다.
- 유사도 70% 이상이고 2위와 5%p 이상 차이가 나면 자동매칭 후보입니다. 확정은 사용자가 합니다([선택 항목 확정]/[전체 확정]).
  - 50~69%는 추천만 표시(확인필요), 50% 미만은 미매칭입니다.
  - 통장 표기가 여러 거래처명에 동시에 포함되면(예: `청진`) 확인필요로 보냅니다.
- CMS집금·카드결제 같은 공통 입금명은 자동 지정하지 않고 alias로도 저장하지 않습니다.
- 계약금액과 조금 다른 입금은 **"수수료 차감 가능성"** 경고만 표시하고, 자동 보정하지 않으며 [전체 확정]에서도 제외합니다.
- 통장 원본(`bank_transactions`)은 DB 트리거로 수정을 막습니다. 가공 데이터는 `transaction_client_matches`와 `payment_allocations`에 따로 저장합니다.
- 중복 방지: 거래 hash(거래일시+보낸분+출금액+입금액+행번호)에 UNIQUE, 파일 hash에 UNIQUE를 겁니다.
- 배정마다 당시 계약금액을 `contract_amount_snapshot`으로 보존합니다. 모든 금액은 정수(원)입니다.
- 모든 수정은 `audit_logs`에 기록됩니다.
