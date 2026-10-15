'use client';
import { useId } from 'react';
import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import type { ArenaConfigDiffEntry } from './config-diff';

const toneClass: Record<ArenaConfigDiffEntry['tone'], string> = {
  add: 'text-emerald-700 dark:text-emerald-300',
  remove: 'text-red-700 dark:text-red-300',
  change: 'text-amber-800 dark:text-amber-200',
};

const toneMark: Record<ArenaConfigDiffEntry['tone'], string> = {
  add: '＋',
  remove: '－',
  change: '～',
};

const CATEGORY_ORDER: readonly ArenaConfigDiffEntry['category'][] = [
  '角色',
  '行动引导',
  '队伍',
  '主情景',
  '辅助情景',
  '素材',
  '模式与故事',
  '共享历史设置',
  '其他',
];

export function RoomConfigDiffView({ roomConfig, localConfig, revision, entries, emptyMessage }: {
  roomConfig: ArenaRoomSharedConfig; localConfig: ArenaRoomSharedConfig | null; revision: number;
  entries: readonly ArenaConfigDiffEntry[]; emptyMessage: string;
}) {
  const headingId = useId();
  const grouped = CATEGORY_ORDER
    .map((category) => ({
      category,
      items: entries.filter((entry) => entry.category === category),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <section aria-labelledby={headingId} className="mt-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-3 border-b pb-3 dark:border-gray-800">
        <div>
          <h3 id={headingId} className="font-semibold text-gray-950 dark:text-gray-100">
            与房间当前设置相比，本地修改了
          </h3>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            仅展示可共享的设置，不包含房主本地正文。
          </p>
        </div>
      </div>
      {grouped.length === 0 ? (
        <p className="pt-3 text-sm text-gray-600 dark:text-gray-400">
          {localConfig ? emptyMessage : '当前本地草稿无法转换为可共享配置，未进行比较。'}
        </p>
      ) : (
        <div className="space-y-3 pt-3">
          {grouped.map((group) => (
            <div key={group.category}>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">{group.category}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {group.items.map((entry) => (
                  <li key={entry.id} className={toneClass[entry.tone]}>
                    <span aria-hidden="true" className="mr-1.5 font-mono">{toneMark[entry.tone]}</span>
                    {entry.label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <details className="mt-3 border-t pt-2 dark:border-gray-800">
        <summary className="cursor-pointer select-none text-xs text-gray-600 dark:text-gray-400">技术详情</summary>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400">当前房间 · 配置版本 {revision}</h4>
            <pre className="mt-1 overflow-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100">{JSON.stringify(roomConfig, null, 2)}</pre>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400">本地编辑草稿</h4>
            <pre className="mt-1 overflow-auto rounded-lg bg-gray-950 p-3 text-xs text-gray-100">{localConfig ? JSON.stringify(localConfig, null, 2) : '当前本地草稿无法转换为可共享配置'}</pre>
          </div>
        </div>
      </details>
    </section>
  );
}
