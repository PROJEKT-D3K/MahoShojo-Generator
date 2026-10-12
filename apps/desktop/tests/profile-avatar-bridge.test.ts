import { describe, expect, it, vi } from 'vitest';
import { clearMyProfileAvatar, saveMyProfileAvatar, CLOUD_CLEAR_ME_PROFILE_AVATAR_COMMAND, CLOUD_SAVE_ME_PROFILE_AVATAR_COMMAND } from '../src/platform/cloud-bridge';
const avatar = 'data:image/webp;base64,QUJD';
describe('avatar narrow bridge', () => {
  it('one invoke per upload/clear with exact owned DTO; upload returns the confirmed value', async () => {
    const upload = vi.fn(async () => ({ userId: 7, avatarDataUrl: avatar }));
    await expect(saveMyProfileAvatar(upload, { expectedUserId: 7, avatarWebpBase64: 'bmV3' })).resolves.toEqual({ userId: 7, avatarDataUrl: avatar });
    expect(upload).toHaveBeenCalledExactlyOnceWith(CLOUD_SAVE_ME_PROFILE_AVATAR_COMMAND, { request: { expectedUserId: 7, avatarWebpBase64: 'bmV3' } });
    const clear = vi.fn(async () => ({ userId: 7, avatarDataUrl: null }));
    await expect(clearMyProfileAvatar(clear, { expectedUserId: 7 })).resolves.toEqual({ userId: 7, avatarDataUrl: null });
    expect(clear).toHaveBeenCalledExactlyOnceWith(CLOUD_CLEAR_ME_PROFILE_AVATAR_COMMAND, { request: { expectedUserId: 7 } });
  });
  it('rejects invalid input and injected authority before invoking anything', async () => {
    const invoke = vi.fn();
    for (const avatarWebpBase64 of ['', 'AB==', 'AAA', 'QU JD', avatar, 'https://example.test', 'A'.repeat(350004)]) await expect(saveMyProfileAvatar(invoke, { expectedUserId: 7, avatarWebpBase64 })).rejects.toThrow();
    for (const expectedUserId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(saveMyProfileAvatar(invoke, { expectedUserId, avatarWebpBase64: 'QUJD' })).rejects.toThrow();
      await expect(clearMyProfileAvatar(invoke, { expectedUserId })).rejects.toThrow();
    }
    for (const extra of [{ url: 'https://example.test' }, { method: 'POST' }, { Cookie: 'secret' }, { token: 'secret' }, { path: '/other' }, { signature: 'other' }, { profile: {} }]) {
      await expect(saveMyProfileAvatar(invoke, { expectedUserId: 7, avatarWebpBase64: 'QUJD', ...extra })).rejects.toThrow();
      await expect(clearMyProfileAvatar(invoke, { expectedUserId: 7, ...extra })).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it('accepts the exact payload boundary without expanding the request', async () => {
    const invoke = vi.fn(async () => ({ userId: Number.MAX_SAFE_INTEGER, avatarDataUrl: avatar }));
    const request = { expectedUserId: Number.MAX_SAFE_INTEGER, avatarWebpBase64: 'A'.repeat(350000) };
    await saveMyProfileAvatar(invoke, request); expect(invoke).toHaveBeenCalledExactlyOnceWith(CLOUD_SAVE_ME_PROFILE_AVATAR_COMMAND, { request });
  });
  it('rejects missing, switched-owner, leaky, oversized or wrong-kind confirmations after one invocation', async () => {
    for (const result of [{ userId: 7 }, { userId: 7, avatarDataUrl: null }, { userId: 8, avatarDataUrl: avatar }, { userId: 7, avatarDataUrl: avatar, cookie: 'secret' }, { userId: 7, avatarDataUrl: 'data:image/png;base64,QUJD' }, { userId: 7, avatarDataUrl: `data:image/webp;base64,${'A'.repeat(350004)}` }]) {
      const invoke = vi.fn(async () => result); await expect(saveMyProfileAvatar(invoke, { expectedUserId: 7, avatarWebpBase64: 'QUJD' })).rejects.toMatchObject({ code: 'bridge-invalid' }); expect(invoke).toHaveBeenCalledOnce();
    }
    for (const result of [{ userId: 7 }, { userId: 7, avatarDataUrl: avatar }, { userId: 8, avatarDataUrl: null }, { userId: 7, avatarDataUrl: null, token: 'secret' }]) {
      const invoke = vi.fn(async () => result); await expect(clearMyProfileAvatar(invoke, { expectedUserId: 7 })).rejects.toMatchObject({ code: 'bridge-invalid' }); expect(invoke).toHaveBeenCalledOnce();
    }
  });
  it.each(['not-authenticated', 'network-error', 'server-unavailable', 'invalid-response'])('propagates %s without any upload or clear replay', async (code) => {
    const upload = vi.fn(async () => { throw { code, message: '未获确认' }; });
    await expect(saveMyProfileAvatar(upload, { expectedUserId: 7, avatarWebpBase64: 'QUJD' })).rejects.toMatchObject({ code, command: CLOUD_SAVE_ME_PROFILE_AVATAR_COMMAND }); expect(upload).toHaveBeenCalledOnce();
    const clear = vi.fn(async () => { throw { code, message: '未获确认' }; });
    await expect(clearMyProfileAvatar(clear, { expectedUserId: 7 })).rejects.toMatchObject({ code, command: CLOUD_CLEAR_ME_PROFILE_AVATAR_COMMAND }); expect(clear).toHaveBeenCalledOnce();
  });
});
