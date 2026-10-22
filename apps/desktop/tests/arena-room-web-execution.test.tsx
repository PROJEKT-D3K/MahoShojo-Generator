// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopRoomGenerationResult, type DesktopRoomGenerationResultProps } from '../src/features/arena/room-generation-result';
import { ExternalLinksProvider } from '../src/features/external-links/external-links-provider';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<object>(), invoke: mocks.invoke }));
// Inject only the owner port: the room adapter and all qualification/bridge logic remain real.
vi.mock('../src/features/arena/web-execution', async original => {
  const module = await original<typeof import('../src/features/arena/web-execution')>();
  return { ...module, DesktopWebReportExecution: class extends module.DesktopWebReportExecution {
    constructor(dependencies: ConstructorParameters<typeof module.DesktopWebReportExecution>[0]) {
      super({ ...dependencies, available: true });
    }
  } };
});

const html = '<!doctype html><html><body><script>window.mustStayIsolated = true</script>房间作品</body></html>';
const generation: DesktopRoomGenerationResultProps['generation'] = {
  phase: 'completed', markdown: html, gap: null, finalAuthoritative: true, generationRecordId: 'record-1',
  errorCode: null, recoveryCode: null, result: { version: 1, format: 'stream-web', mode: 'daily' },
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: unknown, options?: { headers: Record<string, string> }) => {
    if (command === 'begin_web_package_instance') return { instanceId: 'wpk-1' };
    if (command === 'append_web_package_resource') return { receivedByteLength: Number(options?.headers['x-webpkg-offset']) + (args as Uint8Array).byteLength };
    if (command === 'open_web_package_instance') return { label: 'webpkg-wpk-1' };
    const request = (args as { request: { action: string } }).request;
    return request.action === 'close' ? { instanceId: 'wpk-1', status: 'closed' } : { instanceId: 'wpk-1', status: 'open', fullscreen: false };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (value: DesktopRoomGenerationResultProps['generation']) => act(async () => root.render(
  <ExternalLinksProvider invoke={mocks.invoke}><DesktopRoomGenerationResult generation={value} generationKey="room:epoch:generation-1" onRetry={vi.fn()} /></ExternalLinksProvider>,
));
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
const click = async (label: string) => act(async () => button(label).click());

describe('room Web execution qualification with an available test owner', () => {
  it.each([
    { name: 'partial output', value: { ...generation, phase: 'running' as const, finalAuthoritative: false } },
    { name: 'non-authoritative completion', value: { ...generation, finalAuthoritative: false } },
    { name: 'completion without record identity', value: { ...generation, generationRecordId: null } },
    { name: 'package without an exact replay owner', value: { ...generation, result: { ...generation.result!, webPackage: {
      packageRef: { id: 'test.package', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
      targetPath: 'index.html', targetMediaType: 'text/html', generatedDigest: `sha256:${'b'.repeat(64)}`,
    } } } },
  ])('does not begin $name', async ({ value }) => {
    await render(value);
    expect(button('Web 显示').disabled).toBe(true); expect(button('运行 Web 战报').disabled).toBe(true);
    await click('Web 显示'); await click('运行 Web 战报');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('requires consent and uses the free-html bridge for an authoritative identified final', async () => {
    await render(generation);
    expect(button('Web 显示').disabled).toBe(false);
    await click('Web 显示'); expect(mocks.invoke).not.toHaveBeenCalled();
    await click('继续使用 Web');
    const begin = mocks.invoke.mock.calls.find(([command]) => command === 'begin_web_package_instance');
    expect(begin?.[1].request.contentKind).toBe('free-html');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_web_package_instance')).toHaveLength(1);
    expect(container.querySelector('iframe,script,webview')).toBeNull();
    await click('普通显示');
    expect(mocks.invoke.mock.calls.at(-1)?.[1]).toEqual({ request: { instanceId: 'wpk-1', action: 'close' } });
  });
});
