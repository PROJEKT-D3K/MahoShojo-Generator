import { describe, expect, it } from 'vitest';
import { DesktopOpenCloudAccountPageRequestSchema } from '../src/desktop-ipc';

describe('cloud account browser request', () => {
  it.each(['account-security', 'password-recovery'])('accepts only the fixed %s page', (page) => {
    expect(DesktopOpenCloudAccountPageRequestSchema.parse({ page })).toEqual({ page });
  });
  it.each([null, ['account-security'], ['password-recovery'], {}, { page: 'login' }, { page: '/password-recovery' }, { page: 1 }, { page: { url: 'https://example.test' } }, { page: { 'account-security': null } }, { page: { 'password-recovery': null } }])('rejects an unknown page or malformed request %j', (request) => {
    expect(DesktopOpenCloudAccountPageRequestSchema.safeParse(request).success).toBe(false);
  });
  it.each(['url', 'query', 'token', 'userId', 'email', 'returnTo', 'origin'])('rejects injected %s', (key) => {
    expect(DesktopOpenCloudAccountPageRequestSchema.safeParse({ page: 'password-recovery', [key]: 'untrusted' }).success).toBe(false);
  });
});
