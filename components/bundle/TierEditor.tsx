'use client';

/**
 * 티어 편집기 (작업 지시서 20261012_01 단계 3·4).
 *
 * chart.tiers를 편집한다:
 *   - 티어 추가/삭제/이름 변경
 *   - 가격 규칙 선택(retail·flat·choice·percent) + 규칙별 입력(amount·currency·count·threshold·percent)
 *   - 각 티어의 게임 목록은 GameRowItem. 게임 이동은 티어 선택 드롭다운 + 위/아래 버튼(드래그 금지).
 *
 * 상태의 단일 소스는 부모(page)의 chart다. 이 컴포넌트는 변경된 Chart를 onChange로 돌려준다.
 * Tier.id는 추가 시 crypto.randomUUID()로 부여한다.
 */

import type { Chart, Tier, TierPricing, ChartTotals } from '@/lib/bundle/types';
import { formatMoney } from '@/lib/bundle/format';
import GameRowItem from '@/components/bundle/GameRowItem';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'KRW'] as const;
const PRICING_KINDS: { value: TierPricing['kind']; label: string }[] = [
  { value: 'retail', label: '정가 합 (그룹가 없음)' },
  { value: 'flat', label: '고정가 (이 티어 여는 금액)' },
  { value: 'choice', label: '선택형 (N개 골라 금액)' },
  { value: 'percent', label: '퍼센트 할인 (N개 이상 구매 시)' },
];

/** 가격 규칙 kind를 바꿀 때 기본값으로 초기화한다(필드가 다르므로). */
function defaultPricing(kind: TierPricing['kind']): TierPricing {
  switch (kind) {
    case 'retail':
      return { kind: 'retail' };
    case 'flat':
      return { kind: 'flat', amount: 0, currency: 'USD' };
    case 'choice':
      return { kind: 'choice', count: 1, amount: 0, currency: 'USD' };
    case 'percent':
      return { kind: 'percent', threshold: 2, percent: 10 };
  }
}

export interface TierEditorProps {
  chart: Chart;
  totals: ChartTotals;
  onChange: (chart: Chart) => void;
}

export default function TierEditor({ chart, totals, onChange }: TierEditorProps) {
  const tiers = chart.tiers;
  const tierLabels = tiers.map((t, i) => t.label || `티어 ${i + 1}`);

  function updateTier(index: number, next: Tier) {
    const copy = tiers.slice();
    copy[index] = next;
    onChange({ ...chart, tiers: copy });
  }

  function addTier() {
    const next: Tier = {
      id: crypto.randomUUID(),
      label: `티어 ${tiers.length + 1}`,
      pricing: { kind: 'retail' },
      games: [],
    };
    onChange({ ...chart, tiers: [...tiers, next] });
  }

  function removeTier(index: number) {
    const copy = tiers.slice();
    copy.splice(index, 1);
    onChange({ ...chart, tiers: copy });
  }

  function moveGameWithinTier(tierIndex: number, gameIndex: number, delta: number) {
    const tier = tiers[tierIndex];
    const target = gameIndex + delta;
    if (target < 0 || target >= tier.games.length) return;
    const games = tier.games.slice();
    const [g] = games.splice(gameIndex, 1);
    games.splice(target, 0, g);
    updateTier(tierIndex, { ...tier, games });
  }

  function moveGameToTier(fromTier: number, gameIndex: number, toTier: number) {
    if (fromTier === toTier) return;
    const src = tiers[fromTier];
    const game = src.games[gameIndex];
    if (!game) return;
    const copy = tiers.map((t) => ({ ...t, games: t.games.slice() }));
    copy[fromTier].games.splice(gameIndex, 1);
    copy[toTier].games.push(game);
    onChange({ ...chart, tiers: copy });
  }

  function removeGame(tierIndex: number, gameIndex: number) {
    const tier = tiers[tierIndex];
    const games = tier.games.slice();
    games.splice(gameIndex, 1);
    updateTier(tierIndex, { ...tier, games });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          티어 ({tiers.length})
        </h2>
        <button
          type="button"
          onClick={addTier}
          className="px-3 py-1.5 text-sm text-[#1b6fa8] dark:text-[#66c0f4] border border-[#1b6fa8]/40 dark:border-[#66c0f4]/40 rounded-lg hover:bg-[#1b6fa8]/5 dark:hover:bg-[#66c0f4]/10 transition-colors"
        >
          티어 추가
        </button>
      </div>

      {tiers.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          아직 티어가 없습니다. 위에서 번들을 불러오거나 게임을 추가하면 티어가 생성됩니다.
        </p>
      ) : (
        <div className="space-y-4">
          {tiers.map((tier, ti) => (
            <TierCard
              key={tier.id}
              tier={tier}
              tierIndex={ti}
              tierCount={tiers.length}
              tierLabels={tierLabels}
              totals={totals}
              onLabelChange={(label) => updateTier(ti, { ...tier, label })}
              onPricingChange={(pricing) => updateTier(ti, { ...tier, pricing })}
              onRemoveTier={() => removeTier(ti)}
              onMoveGameUp={(gi) => moveGameWithinTier(ti, gi, -1)}
              onMoveGameDown={(gi) => moveGameWithinTier(ti, gi, 1)}
              onMoveGameToTier={(gi, toTier) => moveGameToTier(ti, gi, toTier)}
              onRemoveGame={(gi) => removeGame(ti, gi)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TierCard({
  tier,
  tierIndex,
  tierCount,
  tierLabels,
  totals,
  onLabelChange,
  onPricingChange,
  onRemoveTier,
  onMoveGameUp,
  onMoveGameDown,
  onMoveGameToTier,
  onRemoveGame,
}: {
  tier: Tier;
  tierIndex: number;
  tierCount: number;
  tierLabels: string[];
  totals: ChartTotals;
  onLabelChange: (label: string) => void;
  onPricingChange: (pricing: TierPricing) => void;
  onRemoveTier: () => void;
  onMoveGameUp: (gameIndex: number) => void;
  onMoveGameDown: (gameIndex: number) => void;
  onMoveGameToTier: (gameIndex: number, toTier: number) => void;
  onRemoveGame: (gameIndex: number) => void;
}) {
  const tt = totals.tiers[tierIndex];

  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
      {/* 티어 헤더: 이름 + 삭제 */}
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`tier-label-${tier.id}`}>
          티어 {tierIndex + 1} 이름
        </label>
        <input
          id={`tier-label-${tier.id}`}
          type="text"
          value={tier.label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={`티어 ${tierIndex + 1}`}
          className="flex-1 min-w-0 px-2 py-1.5 text-sm font-medium bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
        />
        <button
          type="button"
          onClick={onRemoveTier}
          aria-label={`${tier.label || `티어 ${tierIndex + 1}`} 삭제`}
          className="shrink-0 px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded hover:text-red-600 dark:hover:text-red-400 hover:border-red-400 dark:hover:border-red-500 transition-colors"
        >
          티어 삭제
        </button>
      </div>

      {/* 가격 규칙 */}
      <PricingEditor pricing={tier.pricing} tierId={tier.id} onChange={onPricingChange} />

      {/* 티어 합계 */}
      <div className="text-xs text-gray-500 dark:text-gray-400">
        정가 합 {formatMoney({ currency: 'KRW', amount: tt?.retail ?? 0 })}
        {tt && ` · 지불 ${formatMoney(tt.pay)}`}
        {tt && tt.pay.currency !== 'KRW' && tt.payKrw != null &&
          ` (≈${formatMoney({ currency: 'KRW', amount: tt.payKrw })})`}
        {tt?.savings && tt.savings.percent > 0 && ` · ${tt.approxFx ? '≈' : ''}${tt.savings.percent}% 절약`}
        {tt && tt.missingCount > 0 && ` · 가격 미상 ${tt.missingCount}개 제외`}
      </div>

      {/* 게임 목록 */}
      {tier.games.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">이 티어에 게임이 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {tier.games.map((game, gi) => (
            <GameRowItem
              key={`${game.appId}-${gi}`}
              game={game}
              tierCount={tierCount}
              tierIndex={tierIndex}
              tierLabels={tierLabels}
              canMoveUp={gi > 0}
              canMoveDown={gi < tier.games.length - 1}
              onMoveUp={() => onMoveGameUp(gi)}
              onMoveDown={() => onMoveGameDown(gi)}
              onMoveToTier={(toTier) => onMoveGameToTier(gi, toTier)}
              onRemove={() => onRemoveGame(gi)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PricingEditor({
  pricing,
  tierId,
  onChange,
}: {
  pricing: TierPricing;
  tierId: string;
  onChange: (pricing: TierPricing) => void;
}) {
  const numberInputClass =
    'w-24 px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]';
  const selectClass =
    'px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]';

  function num(v: string): number {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  return (
    <div className="flex items-end gap-2 flex-wrap">
      <div>
        <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-kind-${tierId}`}>
          가격 규칙
        </label>
        <select
          id={`pricing-kind-${tierId}`}
          value={pricing.kind}
          onChange={(e) => onChange(defaultPricing(e.target.value as TierPricing['kind']))}
          className={selectClass}
        >
          {PRICING_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      {pricing.kind === 'flat' && (
        <>
          <div>
            <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-amount-${tierId}`}>
              금액
            </label>
            <input
              id={`pricing-amount-${tierId}`}
              type="number"
              min={0}
              step="0.01"
              value={pricing.amount}
              onChange={(e) => onChange({ ...pricing, amount: num(e.target.value) })}
              className={numberInputClass}
            />
          </div>
          <CurrencySelect
            tierId={tierId}
            value={pricing.currency}
            onChange={(currency) => onChange({ ...pricing, currency })}
            selectClass={selectClass}
          />
        </>
      )}

      {pricing.kind === 'choice' && (
        <>
          <div>
            <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-count-${tierId}`}>
              선택 개수
            </label>
            <input
              id={`pricing-count-${tierId}`}
              type="number"
              min={1}
              step="1"
              value={pricing.count}
              onChange={(e) => onChange({ ...pricing, count: Math.max(1, Math.round(num(e.target.value))) })}
              className={numberInputClass}
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-choice-amount-${tierId}`}>
              금액
            </label>
            <input
              id={`pricing-choice-amount-${tierId}`}
              type="number"
              min={0}
              step="0.01"
              value={pricing.amount}
              onChange={(e) => onChange({ ...pricing, amount: num(e.target.value) })}
              className={numberInputClass}
            />
          </div>
          <CurrencySelect
            tierId={tierId}
            value={pricing.currency}
            onChange={(currency) => onChange({ ...pricing, currency })}
            selectClass={selectClass}
          />
        </>
      )}

      {pricing.kind === 'percent' && (
        <>
          <div>
            <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-threshold-${tierId}`}>
              구매 개수 기준
            </label>
            <input
              id={`pricing-threshold-${tierId}`}
              type="number"
              min={1}
              step="1"
              value={pricing.threshold}
              onChange={(e) => onChange({ ...pricing, threshold: Math.max(1, Math.round(num(e.target.value))) })}
              className={numberInputClass}
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-percent-${tierId}`}>
              할인율 (%)
            </label>
            <input
              id={`pricing-percent-${tierId}`}
              type="number"
              min={0}
              max={100}
              step="1"
              value={pricing.percent}
              onChange={(e) => onChange({ ...pricing, percent: Math.min(100, Math.round(num(e.target.value))) })}
              className={numberInputClass}
            />
          </div>
        </>
      )}
    </div>
  );
}

function CurrencySelect({
  tierId,
  value,
  onChange,
  selectClass,
}: {
  tierId: string;
  value: string;
  onChange: (currency: string) => void;
  selectClass: string;
}) {
  return (
    <div>
      <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5" htmlFor={`pricing-currency-${tierId}`}>
        통화
      </label>
      <select
        id={`pricing-currency-${tierId}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        {CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}
