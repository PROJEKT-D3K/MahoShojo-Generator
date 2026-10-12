import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_PROFILE_AVATAR_MAX_BASE64_LENGTH, DesktopCloudSaveAvatarRequestSchema, DesktopCloudClearAvatarRequestSchema, DesktopCloudSaveAvatarResultSchema, DesktopCloudClearAvatarResultSchema } from '../src/desktop-cloud';
const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../fixtures/desktop-profile-avatar.json'), 'utf8')) as {
  maxBase64Length: number; validPayloads: string[]; invalidPayloads: string[];
  validSaveRequests: unknown[]; validClearRequests: unknown[]; invalidOwners: unknown[];
  forbiddenFields: Record<string, unknown>; validSaveResult: unknown; validClearResult: unknown;
};

describe('头像窄写入 TS/Rust 共用 fixture', () => {
  it('只接受有界完整纯 base64 和安全整数账号，包括有效边界', () => {
    expect(DESKTOP_PROFILE_AVATAR_MAX_BASE64_LENGTH).toBe(fixture.maxBase64Length);
    for (const request of fixture.validSaveRequests) expect(DesktopCloudSaveAvatarRequestSchema.parse(request)).toEqual(request);
    for (const request of fixture.validClearRequests) expect(DesktopCloudClearAvatarRequestSchema.parse(request)).toEqual(request);
    for (const payload of fixture.validPayloads) expect(DesktopCloudSaveAvatarRequestSchema.parse({ expectedUserId: 7, avatarWebpBase64: payload }).avatarWebpBase64).toBe(payload);
    expect(DesktopCloudSaveAvatarRequestSchema.safeParse({ expectedUserId: 7, avatarWebpBase64: 'A'.repeat(fixture.maxBase64Length) }).success).toBe(true);
    expect(DesktopCloudSaveAvatarRequestSchema.safeParse({ expectedUserId: 7, avatarWebpBase64: 'A'.repeat(fixture.maxBase64Length + 4) }).success).toBe(false);
  });
  it('拒绝坏padding、URL、空白、未知权限字段及错误账号', () => {
    for (const payload of fixture.invalidPayloads) expect(DesktopCloudSaveAvatarRequestSchema.safeParse({ expectedUserId: 7, avatarWebpBase64: payload }).success, payload).toBe(false);
    for (const expectedUserId of fixture.invalidOwners) {
      expect(DesktopCloudSaveAvatarRequestSchema.safeParse({ expectedUserId, avatarWebpBase64: 'QUJD' }).success).toBe(false);
      expect(DesktopCloudClearAvatarRequestSchema.safeParse({ expectedUserId }).success).toBe(false);
    }
    for (const [key, value] of Object.entries(fixture.forbiddenFields)) {
      expect(DesktopCloudSaveAvatarRequestSchema.safeParse({ expectedUserId: 7, avatarWebpBase64: 'QUJD', [key]: value }).success, key).toBe(false);
      expect(DesktopCloudClearAvatarRequestSchema.safeParse({ expectedUserId: 7, [key]: value }).success, key).toBe(false);
    }
    expect(DesktopCloudClearAvatarRequestSchema.safeParse({ expectedUserId: 7, avatarWebpBase64: 'QUJD' }).success).toBe(false);
  });
  it('上传和清除确认不能互换、缺失或携带凭据', () => {
    expect(DesktopCloudSaveAvatarResultSchema.parse(fixture.validSaveResult)).toEqual(fixture.validSaveResult);
    expect(DesktopCloudClearAvatarResultSchema.parse(fixture.validClearResult)).toEqual(fixture.validClearResult);
    for (const result of [{ userId: 7 }, { userId: 7, avatarDataUrl: null }, { userId: 7, avatarDataUrl: 'https://example.test/a.webp' }, { userId: 7, avatarDataUrl: 'data:image/webp;base64,AB==' }]) expect(DesktopCloudSaveAvatarResultSchema.safeParse(result).success).toBe(false);
    expect(DesktopCloudClearAvatarResultSchema.safeParse(fixture.validSaveResult).success).toBe(false);
    expect(DesktopCloudSaveAvatarResultSchema.safeParse({ ...fixture.validSaveResult as object, cookie: 'secret' }).success).toBe(false);
    expect(DesktopCloudClearAvatarResultSchema.safeParse({ ...fixture.validClearResult as object, token: 'secret' }).success).toBe(false);
  });
});
