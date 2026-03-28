'use client';

import { useState } from 'react';
import { SteamReview } from '@/lib/steam/types';

interface ReviewCardProps {
  review: SteamReview;
  gameName: string;
  gameIcon: string;
  hideGameHeader?: boolean;
}

function minutesToHours(minutes: number): string {
  if (minutes < 60) return `${minutes}분`;
  const h = (minutes / 60).toFixed(1);
  return `${h}시간`;
}

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '방금 전';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  const years = Math.floor(months / 12);
  return `${years}년 전`;
}

export default function ReviewCard({ review, gameName, gameIcon, hideGameHeader }: ReviewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const recommendationUrl = `https://store.steampowered.com/reviews/detail/${review.recommendationid}/`;

  return (
    <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
      {!hideGameHeader && (
        <div className="flex items-center gap-2 mb-3">
          {gameIcon && (
            <img src={gameIcon} alt={gameName} className="w-8 h-8 rounded object-cover flex-shrink-0" />
          )}
          <span className="text-[#1b6fa8] dark:text-[#66c0f4] font-medium text-sm truncate">{gameName}</span>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        {review.voted_up ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" /></svg>
            추천
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
            <svg className="w-3 h-3 rotate-180" fill="currentColor" viewBox="0 0 20 20"><path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" /></svg>
            비추천
          </span>
        )}
      </div>

      <div className="mb-3">
        <p className={`text-gray-700 dark:text-gray-300 text-sm leading-relaxed whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
          {review.review}
        </p>
        {review.review.length > 150 && (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="text-[#1b6fa8] dark:text-[#66c0f4] text-xs mt-1 hover:underline">
            {expanded ? '접기' : '더 보기'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mb-3">
        <span>작성 시점: <span className="text-gray-700 dark:text-gray-300">{minutesToHours(review.author.playtime_at_review)}</span></span>
        <span>총 플레이타임: <span className="text-gray-700 dark:text-gray-300">{minutesToHours(review.author.playtime_forever)}</span></span>
        <span>소유 게임: <span className="text-gray-700 dark:text-gray-300">{review.author.num_games_owned.toLocaleString()}개</span></span>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
        <div className="flex items-center gap-3">
          <span>{relativeTime(review.timestamp_created)}</span>
          {review.votes_up > 0 && (
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.096l-.017.116-.406 2.031A2 2 0 0118.16 16H13a2 2 0 01-2-2v-3.17a2 2 0 01.586-1.414l2-2A2 2 0 0115 7V4" /></svg>
              {review.votes_up.toLocaleString()}명에게 도움됨
            </span>
          )}
        </div>
        <a href={recommendationUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors">
          Steam 원문
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </a>
      </div>
    </div>
  );
}
