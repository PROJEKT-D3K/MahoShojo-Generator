import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { openCloudAccountPage, OPEN_CLOUD_ACCOUNT_PAGE_COMMAND } from '../src/platform/external-links-bridge';

describe('cloud account browser bridge', () => {
  it.each(['account-security', 'password-recovery'] as const)('invokes %s without any URL or account fields', async (page) => {
    const invoke = vi.fn(async () => undefined);
    await openCloudAccountPage(invoke, { page });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(OPEN_CLOUD_ACCOUNT_PAGE_COMMAND, { request: { page } });
  });
  it('rejects unexpected authority before IPC', async () => {
    const invoke = vi.fn();
    for (const request of [
      ['account-security'], ['password-recovery'], {}, { page: 'login' }, { page: { 'account-security': null } }, { page: { 'password-recovery': null } },
      ...['url', 'query', 'token', 'userId', 'email', 'returnTo', 'origin'].map((key) => ({ page: 'password-recovery', [key]: 'untrusted' })),
    ]) {
      await expect(openCloudAccountPage(invoke, request as Parameters<typeof openCloudAccountPage>[1])).rejects.toMatchObject({ code: 'bridge-invalid' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    [{ code: 'invalid-url', message: '目标无效' }, 'invalid-url', '目标无效'],
    [{ code: 'open-failed', message: '没有默认浏览器' }, 'open-failed', '没有默认浏览器'],
    [new Error('native unavailable'), 'open-failed', 'native unavailable'],
    [null, 'open-failed', '系统浏览器打开失败'],
  ])('normalizes failure without retrying', async (cause, code, message) => {
    const invoke = vi.fn(async () => { throw cause; });
    await expect(openCloudAccountPage(invoke, { page: 'password-recovery' })).rejects.toMatchObject({ command: OPEN_CLOUD_ACCOUNT_PAGE_COMMAND, code, message });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('cloud account browser command boundary', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  it('registers the fixed command only for the main UI', () => {
    const lib = read('../src-tauri/src/lib.rs');
    expect(read('../src-tauri/build.rs')).toContain('"open_cloud_account_page"');
    expect(lib.slice(lib.indexOf('tauri::generate_handler!['))).toContain('open_cloud_account_page,');
    const acl = JSON.parse(read('../src-tauri/capabilities/main-ui.json')) as { webviews: string[]; windows?: string[]; permissions: string[] };
    expect(acl.webviews).toEqual(['main-ui']);
    expect(acl.windows).toBeUndefined();
    expect(acl.permissions.filter((permission) => permission.includes('cloud-account-page'))).toEqual(['allow-open-cloud-account-page']);
    for (const name of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))) {
      if (name !== 'main-ui.json' && name.endsWith('.json')) expect(read(`../src-tauri/capabilities/${name}`)).not.toContain('cloud-account-page');
    }
    const command = lib.slice(lib.indexOf('fn open_cloud_account_page('), lib.indexOf('/// 公告快照：'));
    expect(command).toContain('cloud.origin(), request.page');
    expect(command).toContain('external_link::open_validated_url(&url)');
    expect(command).not.toMatch(/SecretStore|secrets|\.send\(|\.lock\(|login/);
  });
});
