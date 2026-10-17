'use client';

import { useId } from 'react';
import { Button } from '../card-library/Button';

export type ProfileAvatarFieldProps = {
  avatarDataUrl: string | null;
  uploadAvatar: (file: File) => Promise<unknown>;
  clearAvatar: () => Promise<unknown>;
  isUploadingAvatar: boolean;
  isClearingAvatar: boolean;
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function ProfileAvatarField({
  avatarDataUrl,
  uploadAvatar,
  clearAvatar,
  isUploadingAvatar,
  isClearingAvatar,
}: ProfileAvatarFieldProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const busy = isUploadingAvatar || isClearingAvatar;
  const avatarSize = avatarDataUrl ? formatBytes(avatarDataUrl.length) : null;

  return (
    <div aria-busy={busy}>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-900">头像</label>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="h-14 w-14 overflow-hidden rounded-2xl border bg-gradient-to-br from-pink-100 via-purple-100 to-blue-100">
          {avatarDataUrl ? (
            <img src={avatarDataUrl} alt="头像预览" className="h-full w-full object-cover" />
          ) : null}
        </div>

        <div className="flex-1 min-w-[220px]">
          <input
            id={inputId}
            type="file"
            accept="image/*"
            aria-describedby={hintId}
            className="input-field file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file || busy) return;
              void uploadAvatar(file).catch(() => {});
              e.target.value = '';
            }}
            disabled={busy}
          />
          <div id={hintId} className="mt-1 text-xs text-gray-500">
            建议方形图片；浏览器会裁剪并压缩。{avatarSize ? `当前约：${avatarSize}` : ''}
          </div>
        </div>

        <Button
          size="sm"
          onClick={() => void clearAvatar().catch(() => {})}
          disabled={!avatarDataUrl || busy}
        >
          清除头像
        </Button>
      </div>
    </div>
  );
}
