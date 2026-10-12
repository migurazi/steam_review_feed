/**
 * IsThereAnyDeal(ITAD) API 응답 타입 — 번들 차트 메이커(/bundle)가 쓰는 필드만 선언한다
 * (작업 지시서 20261012_01 단계 1-1). 외부 응답은 필드 누락·타입 불일치가 흔하므로
 * client/chart에서 방어적으로 파싱한다. 여기 타입은 "정상 응답이면 이런 모양" 계약일 뿐이다.
 *
 * base: https://api.isthereanydeal.com, 인증 쿼리 key=<ITAD_API_KEY>. Steam shopId=61.
 */

/** 번들 티어에 포함된 게임(또는 DLC) 한 건. id는 ITAD game UUID. */
export interface ItadTierGame {
  /** ITAD game UUID (lookup의 키). */
  id: string;
  slug: string;
  title: string;
  /** "game" | "dlc" 등. app-item 선택 규칙(단계 1-3)에서 참조. */
  type: string;
  mature?: boolean;
  assets?: unknown;
}

/** 번들 한 티어. 티어 가격(상점 통화) + 포함 게임 목록. */
export interface ItadTier {
  /**
   * 티어를 여는 가격. amount는 상점 통화의 실수 금액(예 8.99), currency는 통화 코드.
   * **null이면 고정 티어가가 없다** — Fanatical "Build Your Own"(품목당 가격·픽앤믹스)이 대표적이다.
   * ITAD는 이런 번들을 단일 티어·price:null로 주고 품목당 단가 스케줄은 주지 않는다(사용자가 직접 입력).
   */
  price: { amount: number; currency: string } | null;
  /** 이 티어가 애드온(기존 구매자 추가분)인지. */
  addon?: boolean;
  games: ItadTierGame[];
}

/** 번들을 판매하는 상점 정보. 실측 필드명: page (shop 아님). */
export interface ItadShop {
  id?: number;
  name?: string;
  shopId?: number;
}

/** ITAD 번들 한 건. 필드명은 2026-10-12 실측 응답 기준. */
export interface ItadBundle {
  id: number;
  title: string;
  /** 상점 정보. 실측 필드명: page (이전 예시의 shop 아님). */
  page?: ItadShop;
  /** 번들 구매 링크. */
  url?: string;
  /** ITAD 상세 페이지. */
  details?: string;
  /** 성인 콘텐츠 여부. 실측 필드명: isMature (이전 예시의 mature 아님). */
  isMature?: boolean;
  /** 공개 시각 (ISO 8601). 실측 필드명: publish (이전 예시의 published 아님). */
  publish?: string;
  /** 만료 시각 (ISO 8601). 실측 필드명: expiry (이전 예시의 expires 아님). */
  expiry?: string;
  note?: string;
  counts?: { games?: number; media?: number };
  tiers: ItadTier[];
}

/**
 * POST /lookup/shop/61/id/v1 응답 — UUID → shop item id 문자열 배열("app/<n>", "sub/<n>", ...).
 */
export type ItadLookupResponse = Record<string, string[]>;
