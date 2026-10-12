/**
 * 번들 차트 메이커(/bundle)의 데이터 모델 — 모든 하위 모듈(파서·포맷터·ITAD 정규화·API·UI)이
 * 공유하는 계약(contract). 레퍼런스: SteamGifts "Lex's SG Chart Maker".
 *
 * 차트 = **티어(그룹)의 배열**. 각 티어는 가격 규칙(TierPricing)과 게임 목록을 가진다.
 * 티어가 하나뿐이면 평범한 "게임 목록" 번들이고, 여러 개면 Humble식 티어 번들이다.
 *
 * 금액 단위: 게임 가격(GameRowPrice)은 Steam GetItems 기준으로 1/100 단위 정수
 * (SteamPriceOverview와 동일 — 예 5490000 = ₩54,900, 통화 KRW 고정). 티어 가격(TierPricing)은
 * 번들 상점(ITAD) 통화의 실수 금액(amount)으로, 소수 2자리 실수다(예 8.99 USD). 두 체계가 다르므로
 * 절약률은 통화가 같을 때만 계산한다(computeChartTotals 참조).
 */

/** 게임 한 줄의 가격. Steam GetItems(KRW) 기준. null = 무료/미판매/미상(GameRow.price). */
export interface GameRowPrice {
  /** 통화 코드. 이 기능에서는 항상 "KRW". */
  currency: string;
  /** 정가 (1/100 단위 정수, 예: 5490000 = ₩54,900). */
  initial: number;
  /** 현재가 (1/100 단위 정수). */
  final: number;
  /** 할인율 (%). 0 = 할인 없음. */
  discountPercent: number;
  /** 정가 표시 문자열 (예: "₩54,900"). */
  initialFormatted: string;
  /** 현재가 표시 문자열. */
  finalFormatted: string;
  /**
   * 이번 조회가 실패해 마지막으로 확인한 가격(last-known)으로 채웠다. 표시는 하되(회색) 신뢰도 낮음을
   * 알린다. PriceSnapshot.fallback과 같은 의미.
   */
  fallback?: boolean;
}

/** 게임 한 줄의 리뷰 요약 (호평률 배지용). null = 리뷰 요약 없음. */
export interface GameReview {
  /** 호평률 (0~100). totalPositive / totalReviews. */
  positivePercent: number;
  /** 총 리뷰 수. */
  total: number;
  /** 등급 설명 (예: "매우 긍정적"). */
  desc: string;
}

/** 차트의 게임(또는 DLC) 한 줄. */
export interface GameRow {
  appId: number;
  name: string;
  /** 헤더 이미지 URL. 조회 실패 시 "". */
  headerImage: string;
  /** 스토어 링크. https://store.steampowered.com/app/{appId}/ */
  storeUrl: string;
  /** 번들 내 분류. ITAD가 구분해 주면 반영, 수동 추가는 "game". */
  type: "game" | "dlc";
  /** 가격. null = 무료/미판매(확인됨). priceUnknown=true면 조회 실패(미상). */
  price: GameRowPrice | null;
  review: GameReview | null;
  /** 가격 조회가 실패해 가격을 알 수 없다(무료와 구분). */
  priceUnknown?: boolean;
  /**
   * 이름 검색으로 매칭된 게임 — 정확한 Steam appid가 아닐 수 있다(동명·다른 에디션·리마스터 등).
   * UI는 게임명 옆 "?" 배지로, 출력은 게임명 뒤 "(?)"로 링크 확인을 유도한다.
   * ITAD UUID 매핑·수동 appID/URL·Steam 패키지 전개로 들어온 행은 false(정확).
   */
  uncertain?: boolean;
}

/**
 * 티어(그룹)의 가격 규칙.
 *   - retail  : 그룹 가격 미지정 → 포함 게임의 정가 합을 그대로 쓴다(할인 없는 묶음).
 *   - flat    : 이 티어를 여는 고정 가격(예: "₩5,000 티어", Humble "Pay $X to unlock").
 *   - choice  : "아무거나 count개 고르면 amount" (Fanatical Build Your Own, Humble choice).
 *   - percent : "threshold개 이상 구매 시 percent% 할인" (Steam "세트 완성" 류).
 * flat/choice의 금액(amount)·통화(currency)는 번들 상점 통화 그대로다(KRW가 아닐 수 있음).
 */
export type TierPricing =
  | { kind: "retail" }
  | { kind: "flat"; amount: number; currency: string }
  | { kind: "choice"; count: number; amount: number; currency: string }
  | { kind: "percent"; threshold: number; percent: number };

export interface Tier {
  /** 클라이언트 로컬 id (드래그·삭제용 키). 서버 저장 안 함. */
  id: string;
  /** 티어 이름 (예: "티어 1", "Beat the Average", "Pay $14 or more"). */
  label: string;
  pricing: TierPricing;
  games: GameRow[];
}

/** 차트 출처(ITAD 번들). 수동 작성이면 생략. */
export interface ChartSource {
  /** 상점 이름 (예: "Fanatical", "Humble Bundle"). */
  shop?: string;
  /** 번들 구매 링크. */
  url?: string;
  /** ITAD 상세 페이지. */
  details?: string;
  /** 만료 시각 (ISO 8601). */
  expires?: string;
  /** 비고. */
  note?: string;
}

/** 번들 차트 전체. 포맷터의 입력이자 UI의 편집 상태. */
export interface Chart {
  title: string;
  source?: ChartSource;
  /**
   * 자유 텍스트 가격 메모(선택). 정형 티어가로 표현 못 하는 가격을 그대로 적어 출처 줄에 덧붙인다.
   * 대표 예: Fanatical "Build Your Own" 품목당 단가 스케줄("품목당: 5+개 ₩1,610 · 7+개 ₩1,556 · 12+개 ₩1,489").
   * ITAD는 이런 스케줄을 주지 않으므로 사용자가 직접 입력한다.
   */
  priceNote?: string;
  tiers: Tier[];
}

/** 복사 출력 포맷. */
export type ChartFormat = "steamgifts" | "bbcode" | "markdown" | "html";

// ============================================================================
// 합계 계산 (포맷터·UI 공용)
// ============================================================================
//
// 금액 단위 정책: 합계의 모든 amount는 **major 단위**다 — KRW는 원(정수, GameRowPrice의
// 1/100 cents를 /100 한 값), 그 외 통화(USD 등)는 소수 금액(예 8.99). GameRowPrice가 cents인
// 것과 달리 합계는 통화 간 비교를 위해 major로 통일한다.

/** 지불 금액 (major 단위). */
export interface Money {
  /** 통화 코드 (예: "KRW", "USD"). */
  currency: string;
  /** 금액 (major 단위 — KRW 원, USD 달러). */
  amount: number;
}

/** 한 티어의 합계. */
export interface TierTotals {
  /** 포함 게임의 개별 현재가 합 (KRW 원). 가격 미상(null·priceUnknown) 게임은 제외. */
  retail: number;
  /** 가격 미상이라 retail 합에서 빠진 게임 수. */
  missingCount: number;
  /**
   * 이 티어를 사는 데 드는 금액.
   *   - retail  : { KRW, retail }
   *   - flat    : 지정 금액(상점 통화)
   *   - choice  : 지정 금액 (count개 선택 기준 — retail과 대상이 달라 savings는 계산 안 함)
   *   - percent : { KRW, retail * (1 - percent/100) }
   */
  pay: Money;
  /**
   * pay를 KRW로 환산한 금액(원, 정수). pay가 KRW면 그 값, 비-KRW면 환율로 환산한 값, 환산 불가면 undefined.
   * savings는 이 값(payKrw)으로 계산한다.
   */
  payKrw?: number;
  /** payKrw가 환율 환산을 거쳤으면 true(=근사). pay가 처음부터 KRW면 false. */
  approxFx?: boolean;
  /**
   * 절약 금액·절약률. payKrw != null 이고 retail>0 이고 choice가 아닐 때 계산(KRW거나 환산 가능하면).
   * amount는 KRW 원. 아니면 null.
   */
  savings: { amount: number; percent: number } | null;
}

/** 차트 전체 합계. */
export interface ChartTotals {
  tiers: TierTotals[];
  /** 전체 고유 게임 현재가 합 (KRW 원). 중복 appid는 한 번만. */
  retail: number;
  /** 전체 지불 추정. 모든 티어 pay의 통화가 같을 때만 합산(아니면 null — 통화 혼재). */
  pay: Money | null;
  /** 전체 지불을 KRW로 환산한 금액(원). 모든 티어가 payKrw != null 일 때만 그 합, 아니면 undefined. */
  payKrw?: number;
  /** 티어 중 하나라도 환율 환산을 썼으면 true(=근사). */
  approxFx?: boolean;
  savings: { amount: number; percent: number } | null;
  /** 전체 고유 게임 수 (중복 appid 제외). */
  gameCount: number;
}

/**
 * ITAD 번들 → Chart 변환 시 Steam appid로 매핑하지 못한 게임 (작업 지시서 20261012_01 단계 1-3 M1).
 * UI가 이름 검색으로 appid를 확정해 지정 티어에 채워 넣는다(unmatched→검색→단건 보강→삽입 왕복).
 */
export interface UnmatchedGame {
  /** ITAD game UUID. */
  uuid: string;
  title: string;
  slug: string;
  /** 원래 속한 티어의 인덱스 (0부터). 보강 후 이 티어에 삽입. */
  tierIndex: number;
}
