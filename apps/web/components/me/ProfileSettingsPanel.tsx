'use client';

import { ProfileAvatarField, ProfileSignatureField, useProfileSignatureEditor } from '@mahoshojo/ui-web/settings';

import { useUnsavedPageGuard } from '@mahoshojo/ui-web/client';

import { useMeProfile } from '@/components/me/useMeProfile';

export function ProfileSettingsPanel({ userId }: { userId: number | null }) {
  const {
    profile,
    error,
    saveSignature,
    loaded,
    signatureScope,
    refetch,
    uploadAvatar,
    isUploadingAvatar,
    clearAvatar,
    isClearingAvatar,
  } = useMeProfile(userId);

  const editor = useProfileSignatureEditor({
    scope: signatureScope ?? (userId === null ? null : `web:${userId}`),
    signature: loaded ? profile.signature : undefined,
    canSave: userId !== null,
    save: async (signature) => (await saveSignature(signature)).profile.signature,
  });

  useUnsavedPageGuard(() => editor.dirty || editor.saving, editor.saving
    ? '签名保存请求仍在进行，离开不会撤销请求，服务端仍可能保存。确认离开？'
    : '个性签名尚未保存。确认放弃当前草稿并离开？', () => !editor.saving);

  if (!userId) {
    return (
      <div className="rounded-2xl border bg-white p-4 text-sm text-gray-700">
        你尚未登录，无法保存个人资料。
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-gray-900">个人资料</div>
          <div className="mt-1 text-xs text-gray-500">
            头像与签名保存到数据库；上传头像会在浏览器裁剪并压缩为 128×128 WebP（质量 82%）再保存。
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <ProfileAvatarField
          avatarDataUrl={profile.avatarDataUrl}
          uploadAvatar={uploadAvatar}
          clearAvatar={clearAvatar}
          isUploadingAvatar={isUploadingAvatar}
          isClearingAvatar={isClearingAvatar}
        />

        <ProfileSignatureField editor={editor} />
        {(editor.error || (!loaded && error)) && <div className="text-xs text-gray-500">
          请求中断时服务端仍可能已保存；可先读取线上签名核对，再决定是否重试。
          <button type="button" className="ml-2 underline" disabled={editor.saving} onClick={() => void refetch()}>读取线上签名</button>
        </div>}
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
      ) : null}
    </div>
  );
}
