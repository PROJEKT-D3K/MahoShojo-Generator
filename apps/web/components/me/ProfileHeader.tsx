'use client';

import { useRef } from 'react';
import { MeProfileHeaderView } from '@mahoshojo/ui-web/me';

import { UserWithTitle } from '@/components/UserTitle';
import type { User } from '@/lib/useAuth';
import type { UserBadge } from '@/types/badge';
import { useMeProfile } from '@/components/me/useMeProfile';

export function ProfileHeader({
  user,
  badges,
  onOpenSettings,
  onOpenProfileCard,
}: {
  user: User;
  badges: UserBadge[];
  onOpenSettings: () => void;
  onOpenProfileCard: () => void;
}) {
  const { profile, loaded, error, refetch, uploadAvatar, isUploadingAvatar } = useMeProfile(user.id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <MeProfileHeaderView
        userId={user.id}
        displayName={user.username}
        avatarDataUrl={profile.avatarDataUrl}
        avatarAction={{ onClick: () => fileInputRef.current?.click(), disabled: isUploadingAvatar, title: '点击上传头像（将压缩后存入数据库）' }}
        signature={loaded ? profile.signature : undefined}
        identityAdornment={<UserWithTitle username={user.username} prefix={user.prefix} badges={badges} showBadges={true} usernameClassName="font-semibold text-gray-900" titleClassName="text-xs" />}
        actions={<>
          <button type="button" className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800" onClick={onOpenProfileCard}>生成资料卡</button>
          <button type="button" className="rounded-lg border bg-white px-3 py-1.5 text-xs hover:bg-gray-50" onClick={onOpenSettings}>编辑资料</button>
        </>}
        feedback={error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
          {!loaded ? <button type="button" className="ml-2 underline" onClick={() => void refetch()}>重新载入资料</button> : null}
        </div> : !loaded ? <p className="text-xs text-gray-600">正在载入资料…</p> : null}
      />
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        uploadAvatar(file).catch(() => {});
        e.target.value = '';
      }} />
    </>
  );
}
