/**
 * `openExternalUrl` 的 renderer 预检与错误透传（D5.1-P1，DESK-PARITY-003）。
 *
 * renderer 的预检只决定「值不值得发 IPC」——native 校验才是边界。这里钉住的是：
 * 明显非法的输入（非 http/https、带凭据、超长）根本不产生 invoke；合法输入把
 * native 的结构化错误原样翻译成 `DesktopExternalLinkError`。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DesktopExternalLinkError,
  MAX_DESKTOP_EXTERNAL_URL_LENGTH,
  openExternalUrl,
} from '../src/platform/external-links-bridge';
import type { InvokeFn } from '../src/platform/external-links-bridge';

describe('openExternalUrl bridge', () => {
  it('forwards a valid https URL to the native command', async () => {
    const invoke: InvokeFn = vi.fn(async () => undefined);

    await openExternalUrl(invoke, 'https://example.com/path?q=1');

    expect(invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://example.com/path?q=1',
    });
  });

  it('rejects non-web schemes without touching IPC', async () => {
    const invoke: InvokeFn = vi.fn(async () => undefined);

    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'tauri://internal',
      'ftp://example.com',
    ]) {
      await expect(openExternalUrl(invoke, url)).rejects.toMatchObject({
        code: 'invalid-url',
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects URLs carrying credentials and oversized URLs without IPC', async () => {
    const invoke: InvokeFn = vi.fn(async () => undefined);

    await expect(openExternalUrl(invoke, 'https://user:pass@example.com')).rejects.toMatchObject({
      code: 'invalid-url',
    });
    await expect(
      openExternalUrl(invoke, `https://example.com/${'a'.repeat(MAX_DESKTOP_EXTERNAL_URL_LENGTH)}`),
    ).rejects.toMatchObject({ code: 'invalid-url' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('translates structured native errors preserving the code', async () => {
    const invoke: InvokeFn = vi.fn(async () => {
      throw { code: 'open-failed', message: '系统没有可处理 URL 的程序' };
    });

    await expect(openExternalUrl(invoke, 'https://example.com')).rejects.toMatchObject({
      name: 'DesktopExternalLinkError',
      code: 'open-failed',
      message: '系统没有可处理 URL 的程序',
    });
  });

  it('falls back to open-failed for unstructured native rejections', async () => {
    const invoke: InvokeFn = vi.fn(async () => {
      throw new Error('panic in native');
    });

    const error = await openExternalUrl(invoke, 'https://example.com').catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(DesktopExternalLinkError);
    expect((error as DesktopExternalLinkError).code).toBe('open-failed');
  });
});

describe('openCloudMessagePage bridge', () => {
  it('only forwards a closed fixed request and preserves native failures', async () => {
    const { openCloudMessagePage } = await import('../src/platform/external-links-bridge');
    const invoke: InvokeFn = vi.fn(async () => undefined);
    await openCloudMessagePage(invoke, { page: 'report-appeals', appealId: 'legacy id&/?' });
    expect(invoke).toHaveBeenCalledWith('open_cloud_message_page', { request: { page: 'report-appeals', appealId: 'legacy id&/?' } });
    await expect(openCloudMessagePage(invoke, { page: 'investigation', url: 'https://evil.test' } as never)).rejects.toMatchObject({ code: 'bridge-invalid' });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(openCloudMessagePage(async () => { throw { code: 'open-failed', message: 'mock failure' }; }, { page: 'investigation' })).rejects.toMatchObject({ code: 'open-failed', message: 'mock failure' });
  });
});
