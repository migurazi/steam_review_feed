'use client';

import { useState } from 'react';

/** 필터 패널의 상태 타입 */
export interface FilterState {
  source: 'wishlist' | 'library' | 'both';
  language: 'koreana' | 'english' | 'japanese' | 'schinese' | 'all';
  minPlaytime: 0 | 1 | 5 | 10;
  minLength: 0 | 50 | 100;
  reviewType: 'all' | 'positive' | 'negative';
  dayRange: 7 | 30 | 90 | 0;
  excludeFree: boolean;
}

/** 필터 기본값. 서버 측 DEFAULT_FILTER_VALUES와 동기화되어야 한다. */
export const DEFAULT_FILTERS: FilterState = {
  source: 'wishlist',
  language: 'koreana',
  minPlaytime: 0,
  minLength: 0,
  reviewType: 'all',
  dayRange: 30,
  excludeFree: true,
};

interface FilterPanelProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">{label}</label>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = options.find((o) => String(o.value) === raw);
          if (opt !== undefined) onChange(opt.value);
        }}
        className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-sm rounded px-2 py-1.5 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function FilterPanel({ filters, onChange }: FilterPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  function update<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-3 font-medium text-sm hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors"
      >
        <span>필터</span>
        <svg
          className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 border-t border-gray-200 dark:border-gray-700">
          <div className="pt-3">
            <SelectField label="언어" value={filters.language} options={[
              { value: 'koreana', label: '한국어' }, { value: 'english', label: '영어' },
              { value: 'japanese', label: '일본어' }, { value: 'schinese', label: '중국어(간체)' },
              { value: 'all', label: '전체' },
            ]} onChange={(v) => update('language', v)} />
          </div>
          <div className="pt-3">
            <SelectField label="최소 플레이타임" value={filters.minPlaytime} options={[
              { value: 0, label: 'off' }, { value: 1, label: '1시간 이상' },
              { value: 5, label: '5시간 이상' }, { value: 10, label: '10시간 이상' },
            ]} onChange={(v) => update('minPlaytime', v)} />
          </div>
          <div className="pt-3">
            <SelectField label="최소 글자수" value={filters.minLength} options={[
              { value: 0, label: 'off' }, { value: 50, label: '50자 이상' },
              { value: 100, label: '100자 이상' },
            ]} onChange={(v) => update('minLength', v)} />
          </div>
          <div className="pt-3">
            <SelectField label="추천/비추" value={filters.reviewType} options={[
              { value: 'all', label: '전체' }, { value: 'positive', label: '추천만' },
              { value: 'negative', label: '비추만' },
            ]} onChange={(v) => update('reviewType', v)} />
          </div>
          <div className="pt-3">
            <SelectField label="기간" value={filters.dayRange} options={[
              { value: 7, label: '7일' }, { value: 30, label: '30일' },
              { value: 90, label: '90일' }, { value: 0, label: '전체' },
            ]} onChange={(v) => update('dayRange', v)} />
          </div>
          <div className="pt-3 flex flex-col gap-1">
            <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">무료 게임 제외</label>
            <button
              type="button"
              onClick={() => update('excludeFree', !filters.excludeFree)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                filters.excludeFree ? 'bg-[#1b6fa8] dark:bg-[#66c0f4]' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                filters.excludeFree ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
