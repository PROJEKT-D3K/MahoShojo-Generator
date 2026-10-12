import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ProfileAvatarField, ProfileSignatureField, compressAvatarToWebpBase64InBrowser, useProfileSignatureEditor } from '@mahoshojo/ui-web/settings';
import { useLeaveGuard } from '../../app/useLeaveGuard';
import { clearMyProfileAvatar, saveMyProfileAvatar, saveMyProfileSignature } from '../../platform/cloud-bridge';
import { useDesktopCloudSession } from './use-desktop-cloud-session';
import { acceptSavedProfileAvatar, acceptSavedProfileSignature, beginMyProfileMutation, useMyProfile } from './use-topbar-avatar';

type AvatarState = { scope: string | null; action: 'upload' | 'clear' | null; error: string | null; uncertain: boolean; message: string | null };
const initialAvatarState = (scope: string | null): AvatarState => ({ scope, action: null, error: null, uncertain: false, message: null });

/** 两处资料面共用宿主；成功依服务端确认，无后台队列、持久草稿或自动重试。 */
export function ProfileSignaturePanel() {
  const { state, store } = useDesktopCloudSession();
  const userId = state.account?.userId ?? null;
  const epoch = store.getCredentialEpoch();
  const scope = userId === null ? null : `desktop:${userId}:${epoch}`;
  const identity = useRef({ scope });
  const active = useRef(true);
  const pendingAvatar = useRef<object | null>(null);
  const guardReady = useRef(false);
  const [avatar, setAvatar] = useState(() => initialAvatarState(scope));
  if (identity.current.scope !== scope) {
    identity.current = { scope }; pendingAvatar.current = null;
  }
  if (avatar.scope !== scope) setAvatar(initialAvatarState(scope));
  const currentAvatar = avatar.scope === scope ? avatar : initialAvatarState(scope);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; pendingAvatar.current = null; };
  }, []);
  const onSessionRejected = useCallback(() => {
    if (store.getSnapshot().account?.userId === userId && store.getCredentialEpoch() === epoch) void store.refresh();
  }, [store, userId, epoch]);
  const { profile, error, retry } = useMyProfile(state.account, epoch, onSessionRejected);
  const isCurrentAccount = () => store.getSnapshot().account?.userId === userId && store.getCredentialEpoch() === epoch;
  const canWrite = state.verification === 'verified' && state.authFlow.kind === 'idle';
  const mayDispatch = () => userId !== null && isCurrentAccount() && guardReady.current
    && store.getSnapshot().verification === 'verified' && store.getSnapshot().authFlow.kind === 'idle';
  const editor = useProfileSignatureEditor({
    scope,
    // undefined 是尚未载入，不能让头像单字段回执把它伪装为空签名。
    signature: profile?.signature,
    canSave: canWrite,
    save: async (signature) => {
      if (userId === null || !mayDispatch()) throw new Error('请先验证当前账号后再保存');
      const fence = beginMyProfileMutation(userId, 'signature');
      const confirmed = await saveMyProfileSignature(invoke, { expectedUserId: userId, signature });
      if (!isCurrentAccount() || confirmed.userId !== userId) throw new Error('账号已变化，旧请求结果已忽略');
      if (!acceptSavedProfileSignature(userId, confirmed.signature, fence)) {
        throw new Error('资料状态已变化，请重新载入后确认；本次请求不会自动重发');
      }
      return confirmed.signature;
    },
  });
  const guard = useLeaveGuard(
    () => editor.dirty || editor.saving || pendingAvatar.current !== null,
    '资料操作尚未完成，请确认后再离开。',
    '资料离开保护初始化失败，请重新打开页面后重试。',
    () => !editor.saving && pendingAvatar.current === null && window.confirm('个性签名尚未保存。确认放弃当前草稿并离开？'),
  );
  guardReady.current = guard.ready;
  const mutateAvatar = async (file: File | null) => {
    if (userId === null || !mayDispatch() || pendingAvatar.current !== null) return;
    const owner = identity.current;
    const token = {}; pendingAvatar.current = token;
    const fence = beginMyProfileMutation(userId, 'avatar');
    const isCurrent = () => active.current && identity.current === owner && pendingAvatar.current === token && isCurrentAccount();
    const action = file ? 'upload' : 'clear';
    setAvatar({ scope, action, error: null, uncertain: false, message: null });
    let dispatched = false;
    try {
      const payload = file ? await compressAvatarToWebpBase64InBrowser(file) : null;
      // 压缩可能跨过退出、重登或离线；IPC 前再次核验而非自动排队上传。
      if (!isCurrent()) return;
      if (!mayDispatch()) throw new Error('当前账号尚未验证，请验证后重新选择图片或清除头像');
      dispatched = true;
      const result = payload === null
        ? await clearMyProfileAvatar(invoke, { expectedUserId: userId })
        : await saveMyProfileAvatar(invoke, { expectedUserId: userId, avatarWebpBase64: payload });
      if (!isCurrent()) return;
      if (!acceptSavedProfileAvatar(userId, result.avatarDataUrl, fence)) {
        throw new Error('头像状态已变化，请读取线上资料核对；本次请求不会自动重发');
      }
      setAvatar({ scope, action: null, error: null, uncertain: false, message: file ? '头像已更新' : '头像已清除' });
    } catch (cause) {
      if (!isCurrent()) return;
      setAvatar({ scope, action: null, error: cause instanceof Error ? cause.message : '头像保存未获确认', uncertain: dispatched, message: null });
    } finally {
      if (pendingAvatar.current === token) pendingAvatar.current = null;
    }
  };
  if (userId === null) return null;
  return <section className="rounded-2xl border bg-white p-4" aria-label="个人资料">
    <h3 className="mb-3 font-semibold text-gray-900">个人资料</h3>
    {!canWrite && <p className="mb-3 text-xs text-gray-500">当前账号尚未验证；签名草稿可保留，验证成功后由你点击保存。</p>}
    <fieldset className="mb-5" disabled={!canWrite || !guard.ready}>
      <ProfileAvatarField avatarDataUrl={profile?.avatarDataUrl ?? null}
        uploadAvatar={(file) => mutateAvatar(file)} clearAvatar={() => mutateAvatar(null)}
        isUploadingAvatar={currentAvatar.action === 'upload'} isClearingAvatar={currentAvatar.action === 'clear'} />
    </fieldset>
    {currentAvatar.message && <p role="status" className="mb-3 text-xs text-gray-500">{currentAvatar.message}</p>}
    {currentAvatar.error && <div role="alert" className="mb-3 text-xs text-red-800">{currentAvatar.error}
      {currentAvatar.uncertain && <div>请求中断时服务端仍可能已保存；可先读取线上头像核对，再决定是否重试。
        <button type="button" className="ml-2 underline" disabled={currentAvatar.action !== null} onClick={retry}>读取线上头像</button>
      </div>}
    </div>}
    <ProfileSignatureField editor={{ ...editor, canSave: editor.canSave && guard.ready }} />
    {editor.error && <div className="mt-2 text-xs text-gray-500">
      请求中断时服务端仍可能已保存；可先读取线上签名核对，再决定是否重试。
      <button type="button" className="ml-2 underline" disabled={editor.saving} onClick={retry}>读取线上签名</button>
    </div>}
    {error && <div className="mt-2 text-xs text-red-800">{error} <button type="button" className="underline" onClick={retry}>重试载入</button></div>}
    {guard.message && <p role="alert" className="mt-2 text-xs text-red-800">{guard.message}</p>}
  </section>;
}
