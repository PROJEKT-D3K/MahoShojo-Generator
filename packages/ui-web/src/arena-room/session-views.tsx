'use client';

import { useEffect, useRef, type ChangeEvent, type ReactNode } from 'react';

import { MAX_ROOM_MEMBERS, type RoomDirectoryEntry, type RoomDirectoryVisibility, type RoomMember } from '@mahoshojo/contracts/arena-room';

import { Button, buttonClassName } from '../card-library/Button';
import type { RoomMembersViewModel, RoomMemberView } from './room-members';

// 保留 Web 房间表单的既有控件样式；不为本切片迁移通用 Input/ActionBar。
const roomControlClassName = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-950 dark:text-gray-100';

const formatRoomActivityTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (deltaMinutes < 1) return '刚刚活跃';
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前活跃`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} 小时前活跃`;
  return `${Math.floor(deltaHours / 24)} 天前活跃`;
};

export type RoomLobbyContentProps = {
  readonly roomTitle: string;
  readonly visibility: RoomDirectoryVisibility;
  readonly joinCode: string;
  readonly rooms: readonly RoomDirectoryEntry[];
  readonly loading: boolean;
  readonly nextCursor?: string | null;
  readonly loadingMore?: boolean;
  readonly nextPageLabel?: string;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly joinCodeHint?: ReactNode;
  readonly onRoomTitleChange: (value: string) => void;
  readonly onVisibilityChange: (value: RoomDirectoryVisibility) => void;
  readonly onJoinCodeChange: (value: string) => void;
  readonly onCreate: () => void;
  readonly onDiscover: () => void;
  readonly onDiscoverMore: () => void;
  readonly onJoin: (roomId: string) => void;
};

/** 房间表单与目录共源；认证、邀请码解析和请求状态仍由宿主拥有。 */
export function RoomLobbyContent({
  roomTitle, visibility, joinCode, rooms, loading, nextCursor, loadingMore, busy, error,
  joinCodeHint, nextPageLabel = '加载更多', onRoomTitleChange, onVisibilityChange, onJoinCodeChange,
  onCreate, onDiscover, onDiscoverMore, onJoin,
}: RoomLobbyContentProps) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-white/70 p-4 dark:border-gray-700 dark:bg-gray-900/60">
          <legend className="px-1 text-sm font-semibold text-gray-950 dark:text-gray-100">创建房间</legend>
          <div>
            <label htmlFor="arena-room-title" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
              房间标题
            </label>
            <input
              id="arena-room-title"
              className={roomControlClassName}
              maxLength={80}
              required
              value={roomTitle}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onRoomTitleChange(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="arena-room-visibility" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
              可发现性
            </label>
            <select
              id="arena-room-visibility"
              className={roomControlClassName}
              value={visibility}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => onVisibilityChange(event.target.value as RoomDirectoryVisibility)}
            >
              <option value="public">公开发现</option>
              <option value="unlisted">仅凭房间码</option>
            </select>
          </div>
          <button type="button" className={buttonClassName({ variant: 'primary' })} disabled={busy || !roomTitle.trim()} onClick={onCreate}>
            创建多人房间
          </button>
        </fieldset>

        <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-white/70 p-4 dark:border-gray-700 dark:bg-gray-900/60">
          <legend className="px-1 text-sm font-semibold text-gray-950 dark:text-gray-100">凭房间码加入</legend>
          <div>
            <label htmlFor="arena-room-join-code" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
              房间码
            </label>
            <input
              id="arena-room-join-code"
              className={roomControlClassName}
              maxLength={1024}
              value={joinCode}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onJoinCodeChange(event.target.value)}
            />
            {joinCodeHint ? <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{joinCodeHint}</p> : null}
          </div>
          <button type="button" className={buttonClassName({ variant: 'primary' })} disabled={busy || !joinCode.trim()} onClick={() => onJoin(joinCode.trim())}>
            加入房间
          </button>
        </fieldset>
      </div>

      <section aria-labelledby="arena-public-room-heading" className="mt-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="arena-public-room-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">公开房间</h4>
          <button type="button" className={buttonClassName()} disabled={busy} onClick={onDiscover}>
            {loading ? '正在加载…' : error ? '重试' : '刷新'}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>
        ) : null}
        {loading && rooms.length === 0 ? (
          <p role="status" className="mt-3 text-sm text-gray-600 dark:text-gray-400">正在加载公开房间…</p>
        ) : rooms.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">暂无公开房间</p>
        ) : (
          <ul className="mt-3 grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" aria-label="公开房间列表">
            {rooms.map((room) => {
              const memberLine = [
                room.hostDisplayName ?? null,
                room.memberCount ? `${room.memberCount}/${room.memberLimit ?? MAX_ROOM_MEMBERS} 人` : null,
              ].filter((part): part is string => Boolean(part)).join(' · ');
              return (
                <li
                  key={room.roomId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white/80 p-3 dark:border-gray-700 dark:bg-gray-900/70"
                  title={room.roomId}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-950 dark:text-gray-100" title={room.title}>{room.title}</p>
                    {memberLine ? (
                      <p className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-400">{memberLine}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-500">{formatRoomActivityTime(room.lastActivityAt)}</p>
                  </div>
                  <Button className="shrink-0" disabled={busy} onClick={() => onJoin(room.roomId)}>
                    加入
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              className={buttonClassName()}
              disabled={Boolean(loadingMore)}
              onClick={onDiscoverMore}
            >
              {loadingMore ? '正在加载更多…' : nextPageLabel}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

export type RoomMembersViewProps = {
  readonly view: RoomMembersViewModel;
  readonly busy?: boolean;
  readonly selfUserId?: string;
  readonly onKick?: (member: RoomMemberView, trigger: HTMLButtonElement) => void;
  readonly membershipHint?: ReactNode;
  readonly emptyHint?: ReactNode;
};

export function RoomMembersView({
  view, busy = false, selfUserId, onKick, membershipHint, emptyHint,
}: RoomMembersViewProps) {
  return (
    <section aria-labelledby="arena-room-members-heading">
      <h3 id="arena-room-members-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">
        房间成员
      </h3>
      {membershipHint ? <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{membershipHint}</p> : null}
      <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="房间成员列表">
        {view.activeMembers.map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/70">
            <span>
              <span className="font-medium text-gray-950 dark:text-gray-100">{member.displayName}</span>
              <span className="ml-2 text-gray-600 dark:text-gray-400">
                {member.role === 'host' ? '房主' : '成员'}
              </span>
              <span className="ml-2 text-xs text-gray-600 dark:text-gray-400" data-member-presence={member.presence}>
                {member.presence === 'unknown' ? '在线状态未知' : member.presence === 'online' ? '在线' : '离线（保留席位）'}
              </span>
            </span>
            {onKick && member.role !== 'host' && member.userId !== selfUserId ? (
              <button
                type="button"
                className={buttonClassName()}
                disabled={busy}
                onClick={(event) => onKick(member, event.currentTarget)}
              >
                移除
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {view.activeCount <= 1 && emptyHint ? (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{emptyHint}</p>
      ) : null}
    </section>
  );
}

export type RoomExitConfirmation = 'close' | 'leave' | null;

export type RoomExitActionsProps = {
  readonly role: RoomMember['role'];
  readonly confirmation: RoomExitConfirmation;
  readonly busy: boolean;
  readonly onConfirmationChange: (confirmation: RoomExitConfirmation) => void;
  readonly onClose: () => void;
  readonly onLeave: () => void;
  /** Web 的停止生成操作与确认保留在宿主，不向其他宿主宣称该能力。 */
  readonly extraActions?: ReactNode;
  readonly extraConfirmation?: ReactNode;
};

export function RoomExitActions({
  role, confirmation, busy, onConfirmationChange, onClose, onLeave, extraActions, extraConfirmation,
}: RoomExitActionsProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation) confirmRef.current?.focus();
  }, [confirmation]);

  return (
    <section aria-labelledby="arena-room-actions-heading" className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
      <h3 id="arena-room-actions-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">
        {role === 'host' ? '房间操作' : '退出房间'}
      </h3>
      {confirmation ? (
        <div role="alertdialog" aria-label="确认房间管理动作" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
          <p>{confirmation === 'close' ? '确定关闭房间吗？所有成员都会断开。' : '确定离开当前房间吗？'}</p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              ref={confirmRef}
              type="button"
              className={buttonClassName({ variant: 'primary' })}
              disabled={busy}
              onClick={() => {
                onConfirmationChange(null);
                if (confirmation === 'close') onClose();
                else onLeave();
              }}
            >
              {confirmation === 'close' ? '确认关闭房间' : '确认离开房间'}
            </button>
            <button
              type="button"
              className={buttonClassName()}
              onClick={() => {
                onConfirmationChange(null);
                queueMicrotask(() => {
                  if (confirmation === 'close') closeRef.current?.focus();
                  else leaveRef.current?.focus();
                });
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : extraConfirmation ?? (role === 'host' ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {extraActions}
          <button
            ref={closeRef}
            type="button"
            className={buttonClassName()}
            disabled={busy}
            onClick={() => onConfirmationChange('close')}
          >
            关闭房间
          </button>
        </div>
      ) : (
        <button
          ref={leaveRef}
          type="button"
          className={buttonClassName({ className: 'mt-3' })}
          disabled={busy}
          onClick={() => onConfirmationChange('leave')}
        >
          离开房间
        </button>
      ))}
    </section>
  );
}
