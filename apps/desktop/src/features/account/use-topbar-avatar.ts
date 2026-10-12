// 顶栏与两处资料面共用一份按 userId 隔离的非秘密缓存。
// 身份 epoch、GET 世代、同字段写意图分别排序，异字段确认不会互相作废。
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { DesktopCloudAccountSummary, DesktopCloudMeProfile } from '@mahoshojo/contracts/desktop-cloud';
import { DesktopCloudError, readMyProfile, type InvokeFn } from '../../platform/cloud-bridge';

const profiles = new Map<number, DesktopCloudMeProfile>();
const profileErrors = new Map<number, string>();
// checked 只表示完整 GET 已成功；单字段确认不能伪造另一个未知字段。
const checked = new Set<number>();
const generations = new Map<number, number>();
const identityEpochs = new Map<number, number>();
type ProfileField = 'signature' | 'avatar';
const intents = new Map<number, Record<ProfileField, number>>();
const inflight = new Map<number, {
  generation: number; callbacks: Set<() => void>;
}>();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());
export const subscribeTopbarAvatar = (listener: () => void): (() => void) => {
  listeners.add(listener); return () => listeners.delete(listener);
};
export const getCachedMyProfile = (userId: number | null): DesktopCloudMeProfile | null =>
  userId === null ? null : profiles.get(userId) ?? null;
export const getTopbarAvatar = (userId: number | null): string | null =>
  getCachedMyProfile(userId)?.avatarDataUrl ?? null;
export const getMyProfileGeneration = (userId: number): number => generations.get(userId) ?? 0;

/** 会话边界使读、写与订阅回调全部过期。 */
export const invalidateTopbarAvatar = (userId: number): void => {
  identityEpochs.set(userId, (identityEpochs.get(userId) ?? 0) + 1);
  generations.set(userId, getMyProfileGeneration(userId) + 1);
  profiles.delete(userId);
  profileErrors.delete(userId);
  checked.delete(userId);
  // 读取世代也被存活顶栏订阅，即使槽原本为空仍须通知。
  notify();
};

/** 同世代 single-flight；每个宿主可独立附加/撤销身份拒绝回调。 */
export const ensureTopbarAvatar = (
  userId: number, invoke: InvokeFn = tauriInvoke, onSessionRejected?: () => void,
): (() => void) => {
  if (checked.has(userId)) return () => {};
  const generation = getMyProfileGeneration(userId);
  const current = inflight.get(userId);
  if (current?.generation === generation) {
    if (onSessionRejected) current.callbacks.add(onSessionRejected);
    return () => { if (onSessionRejected) current.callbacks.delete(onSessionRejected); };
  }
  const flight = { generation, callbacks: new Set<() => void>() };
  if (onSessionRejected) flight.callbacks.add(onSessionRejected);
  inflight.set(userId, flight);
  void readMyProfile(invoke).then((profile) => {
    if (profile.userId !== userId || getMyProfileGeneration(userId) !== generation) return;
    checked.add(userId);
    // 完整 GET 的缺省签名是已知空值；头像单字段确认不会走这里。
    profiles.set(userId, { ...profile, signature: profile.signature ?? '' });
    profileErrors.delete(userId);
  }).catch((cause: unknown) => {
    if (getMyProfileGeneration(userId) !== generation) return;
    const rejected = cause instanceof DesktopCloudError && cause.code === 'not-authenticated';
    profileErrors.set(userId, rejected ? '账号验证已失效，请重新验证后载入资料。' : '资料未能载入，请重试。');
    if (rejected) {
      // 一次请求只触发一次收束；每个回调自身仍核对当前 owner。
      for (const callback of flight.callbacks) callback();
    }
  }).finally(() => {
    if (inflight.get(userId) === flight) inflight.delete(userId);
    flight.callbacks.clear();
    notify();
  });
  return () => { if (onSessionRejected) flight.callbacks.delete(onSessionRejected); };
};

export type ProfileMutationFence = Readonly<{
  userId: number; identityEpoch: number; field: ProfileField; intent: number;
}>;
export const beginMyProfileMutation = (userId: number, field: ProfileField): ProfileMutationFence => {
  const next = { ...(intents.get(userId) ?? { signature: 0, avatar: 0 }) };
  next[field] += 1; intents.set(userId, next);
  return { userId, identityEpoch: identityEpochs.get(userId) ?? 0, field, intent: next[field] };
};
const accepts = (userId: number, field: ProfileField, fence: ProfileMutationFence): boolean =>
  fence.userId === userId && fence.field === field
  && fence.identityEpoch === (identityEpochs.get(userId) ?? 0)
  && fence.intent === intents.get(userId)?.[field];
const publishConfirmedField = (userId: number, patch: Partial<DesktopCloudMeProfile>): void => {
  generations.set(userId, getMyProfileGeneration(userId) + 1);
  profiles.set(userId, { ...profiles.get(userId), userId, ...patch });
  profileErrors.delete(userId);
  notify();
};
export const acceptSavedProfileSignature = (userId: number, signature: string, fence: ProfileMutationFence): boolean => {
  if (!accepts(userId, 'signature', fence)) return false;
  publishConfirmedField(userId, { signature }); return true;
};
export const acceptSavedProfileAvatar = (userId: number, avatarDataUrl: string | null, fence: ProfileMutationFence): boolean => {
  if (!accepts(userId, 'avatar', fence)) return false;
  publishConfirmedField(userId, { avatarDataUrl: avatarDataUrl ?? undefined }); return true;
};

/** 显式读回只失效读取，不作废尚在途的异字段写入，也不重放写入。 */
export const refreshMyProfile = (userId: number, invoke: InvokeFn = tauriInvoke, onSessionRejected?: () => void): void => {
  if (inflight.get(userId)?.generation === getMyProfileGeneration(userId)) return;
  generations.set(userId, getMyProfileGeneration(userId) + 1);
  checked.delete(userId); profileErrors.delete(userId);
  ensureTopbarAvatar(userId, invoke, onSessionRejected);
  notify();
};

export const resetTopbarAvatarForTests = (): void => {
  profiles.clear(); profileErrors.clear(); checked.clear(); inflight.clear();
  generations.clear(); identityEpochs.clear(); intents.clear();
};

/** 同账号重登也以 credential epoch 隔离，卸载后撤销该宿主回调。 */
const useProfileOwner = (userId: number | null, epoch: number) => {
  const owner = useRef({ userId, epoch });
  useEffect(() => () => { owner.current = { ...owner.current }; }, []);
  if (owner.current.userId !== userId || owner.current.epoch !== epoch) owner.current = { userId, epoch };
  return owner;
};
export const useTopbarAvatar = (
  account: DesktopCloudAccountSummary | null,
  options?: { readonly onSessionRejected?: () => void; readonly credentialEpoch?: number },
): string | null => {
  const userId = account?.userId ?? null;
  const epoch = options?.credentialEpoch ?? 0;
  const owner = useProfileOwner(userId, epoch);
  const onSessionRejected = options?.onSessionRejected;
  const avatar = useSyncExternalStore(subscribeTopbarAvatar, () => getTopbarAvatar(userId));
  // 资料面确认/显式读回开启新 GET 时，存活顶栏须转订新 flight。
  const generation = useSyncExternalStore(subscribeTopbarAvatar, () => userId === null ? 0 : getMyProfileGeneration(userId));
  useEffect(() => {
    const startedOwner = owner.current;
    if (userId !== null) return ensureTopbarAvatar(userId, tauriInvoke, () => {
      if (owner.current === startedOwner) onSessionRejected?.();
    });
  }, [userId, epoch, generation, owner, onSessionRejected]);
  return avatar;
};
export const useMyProfile = (account: DesktopCloudAccountSummary | null, epoch = 0, onSessionRejected?: () => void) => {
  const userId = account?.userId ?? null;
  const owner = useProfileOwner(userId, epoch);
  const profile = useSyncExternalStore(subscribeTopbarAvatar, () => getCachedMyProfile(userId));
  const error = useSyncExternalStore(subscribeTopbarAvatar, () => userId === null ? null : profileErrors.get(userId) ?? null);
  useEffect(() => {
    const startedOwner = owner.current;
    if (userId !== null) return ensureTopbarAvatar(userId, tauriInvoke, () => {
      if (owner.current === startedOwner) onSessionRejected?.();
    });
    // 单字段确认改变 profile；完整资料仍未知时，补一次真实 GET。
  }, [userId, epoch, profile, owner, onSessionRejected]);
  return { profile, error, retry: () => {
    const startedOwner = owner.current;
    if (userId !== null) refreshMyProfile(userId, tauriInvoke, () => {
      if (owner.current === startedOwner) onSessionRejected?.();
    });
  } };
};
