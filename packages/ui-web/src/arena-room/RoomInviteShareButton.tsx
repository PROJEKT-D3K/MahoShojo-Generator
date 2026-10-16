'use client';

import { Button } from '../card-library/Button';

export type RoomInviteCopyStatus = 'idle' | 'copying' | 'copied' | 'error';
export type RoomInviteShareButtonProps = {
  readonly status: RoomInviteCopyStatus;
  readonly disabled?: boolean;
  readonly onCopy: () => void;
};

/** 受控分享入口；产品 origin 与账号/页面/房间能力仍由宿主提供。 */
export function RoomInviteShareButton({ status, disabled, onCopy }: RoomInviteShareButtonProps) {
  return <Button aria-label="复制房间邀请文案" disabled={disabled || status === 'copying'} onClick={onCopy}>
    <span aria-live="polite">{status === 'copied' ? '已复制邀请' : status === 'copying' ? '复制中…' : status === 'error' ? '复制失败，请重试' : '分享房间'}</span>
  </Button>;
}
