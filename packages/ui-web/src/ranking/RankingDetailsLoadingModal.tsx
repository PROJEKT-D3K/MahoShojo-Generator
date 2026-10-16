'use client';

import { BaseModal } from '../modal/BaseModal';
import type { RankingDetailsTarget } from './RankingPageView';

export type RankingDetailsLoadingModalProps = {
  entityType: RankingDetailsTarget['entityType'];
  pendingNotice?: string | null;
  error?: string | null;
  onRetry: () => void;
  onClose: () => void;
};

/** 详情读取与重试仍由宿主持有；只共享加载、失败和榜单提示的展示。 */
export function RankingDetailsLoadingModal({ entityType, pendingNotice, error, onRetry, onClose }: RankingDetailsLoadingModalProps) {
  return (
    <BaseModal isOpen onClose={onClose} title={entityType === 'preset' ? '预设角色详情' : '数据卡详情'} maxWidthClassName="max-w-md">
      {pendingNotice ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {pendingNotice}
        </div>
      ) : null}
      <div className="mt-4 text-sm text-gray-600">
        {error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">
            <div>加载失败：{error}</div>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md bg-white px-2 py-1 text-xs text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              重试
            </button>
          </div>
        ) : <div role="status">正在加载角色详情...</div>}
      </div>
    </BaseModal>
  );
}
