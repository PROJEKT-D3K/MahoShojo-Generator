'use client';

import type { EntityRatingHistoryItem } from '@mahoshojo/contracts/public-ranking';
import { BaseModal } from '../modal/BaseModal';
import { formatRankingDateTime as formatDateTime } from './presentation';

export type { EntityRatingHistoryItem } from '@mahoshojo/contracts/public-ranking';

export type EntityRatingHistoryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  loading: boolean;
  error: string | null;
  items: EntityRatingHistoryItem[];
  onRetry: () => void;
};

const formatSignedDelta = (value: number): string => (value > 0 ? `+${value}` : String(value));

const resultLabel: Record<EntityRatingHistoryItem['result'], string> = {
  win: '胜',
  loss: '负',
  draw: '平',
};

const resultClassName: Record<EntityRatingHistoryItem['result'], string> = {
  win: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  loss: 'border-rose-200 bg-rose-50 text-rose-700',
  draw: 'border-gray-200 bg-gray-50 text-gray-700',
};

const deltaClassName = (delta: number): string => {
  if (delta > 0) return 'text-emerald-700';
  if (delta < 0) return 'text-rose-700';
  return 'text-gray-700';
};

export function EntityRatingHistoryModal({
  isOpen,
  onClose,
  title = '最近严格排位',
  loading,
  error,
  items,
  onRetry,
}: EntityRatingHistoryModalProps) {
  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={title}
      description="公开显示最近 10 条已计分严格排位，不按当前所选赛季筛选"
      maxWidthClassName="max-w-2xl" zIndexClassName="z-[70]">
      {loading ? (
        <div role="status" className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-600">
          正在加载最近严格排位记录...
        </div>
      ) : error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
          <div>无法加载最近严格排位记录：{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-md bg-white px-3 py-1.5 text-xs text-gray-700 ring-1 ring-red-200 hover:bg-red-50"
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
          暂无严格排位记录
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {items.map((item) => (
            <div key={`${item.generationId}:${item.createdAt}`} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${resultClassName[item.result]}`}
                    >
                      {resultLabel[item.result]}
                    </span>
                    <span className="truncate text-sm font-medium text-gray-900">
                      对手：{item.opponent.displayName || '未知角色'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span title={item.createdAt}>{formatDateTime(item.createdAt)}</span>
                    <span>发起者：{item.initiator.username?.trim() || '未知用户'}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className={`font-semibold ${deltaClassName(item.delta)}`}>{formatSignedDelta(item.delta)}</div>
                  <div className="mt-1 text-xs text-gray-500">赛后 {item.afterRating}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </BaseModal>
  );
}
