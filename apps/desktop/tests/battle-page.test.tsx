// @vitest-environment jsdom
/** Real Desktop route/shared views/session/B1 adapter; simulated IPC and loopback fixture, not OS/Tauri acceptance. */
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import { DesktopArenaHostedRecoveryPointerSchema } from '@mahoshojo/contracts/desktop-arena-hosted';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { builtinWebPackageSource, BUILTIN_WEB_PACKAGE_PRESETS, packWebPackageZip, unpackWebPackageZip } from '@mahoshojo/web-package';
import type { LocalWebPackageRecordV1 } from '@mahoshojo/local-library/web-package-record';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';
import { ADVANCED_ARENA_DRAFT_KEY, ARENA_DRAFT_KEY, createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { arenaWebPackageFixture, wrappedArenaWebPackageFile } from './fixtures/arena-web-package';
import { createDesktopRouter } from '../src/app/router';
import { deferred, installStoryCrypto, StoryFixturePort, storyFixtureInvoke } from './helpers/story-fixture';
import { HostedStoryFixture } from './helpers/hosted-story-fixture';
import { STORY_PENDING_IPC } from '../src/platform/arena-story-pending-native';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../src/features/arena/hosted-recovery';
import { getDesktopCloudSessionStore, resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
installStoryCrypto();
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), download: vi.fn(), downloadBinary: vi.fn(), profile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true, Channel: class { onmessage?: (value: unknown) => void; } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.listen }) }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download, downloadBinaryFile: mocks.downloadBinary }));
vi.mock('../src/platform/provider-profile-bridge', () => ({ listProviderProfileIds: async () => ['loopback'], getProviderProfile: mocks.profile }));
let root: Root, container: HTMLDivElement, server: Server, endpoint: string;
let activeCloseHandles = 0;
let storyPort: StoryFixturePort, storyIpc: ReturnType<typeof storyFixtureInvoke>;
let hostedStory: HostedStoryFixture, hostedCapabilityAvailable: boolean;
let cloudAccount: { userId: number; username: string } | null;
const pendingCommands = new Set<string>(Object.values(STORY_PENDING_IPC));
let markdownSuffix = '';
let webTextOverride: string | null = null;
let packageDocs: Map<string, LocalWebPackageRecordV1>, packageBytes: Map<string, Uint8Array>;
let docs: Map<string, LocalCardRecordV1>, received: AiExecutionRequest[], hold: boolean, release: (() => void) | undefined, failSave: boolean, eof: boolean;
const nativeFetch = globalThis.fetch;
const text = '甲与乙共同守护车站。';
const webHtml = '<!doctype html><html><head><title>本地网页</title></head><body><script>globalThis.webShouldNotRun=true</script><img src="https://untrusted.invalid/tracker.png"/>甲乙的网页故事</body></html>';
const webTrailer = '<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"网页重逢","winner":"甲"},"impacts":[{"characterName":"甲","impact":"建立信任"}]} -->';
const rendered = (stream: boolean) => stream ? `# 车站重逢\n\n${text}${markdownSuffix}\n<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"车站重逢","winner":"甲"},"impacts":[{"characterName":"甲","impact":"学会信任","currentStateSummary":"安心"}]} -->`
  : JSON.stringify({ headline: '车站重逢', article: { body: text + markdownSuffix, analysis: '彼此扶持' }, officialReport: { winner: '甲', conclusion: '合作' }, impacts: [{ characterName: '甲', impact: '学会信任', currentStateSummary: '安心' }] });
beforeAll(async () => {
  server = createServer((req, res) => { let body = ''; req.on('data', (part) => { body += part; }); req.on('end', () => {
    const request = JSON.parse(body) as AiExecutionRequest; received.push(request);
    const stream = request.messages.length === 1;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: JSON.parse(request.arenaInputJson!).reportFormat === 'web' ? webTextOverride ?? `${webHtml}\n${webTrailer}` : rendered(stream), reasoning: '独立的推理' }));
  }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)!;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); }); };
const click = async (text: string, scope?: ParentNode) => { expect(button(text, scope), text).toBeTruthy(); await act(async () => button(text, scope).click()); await settle(); };
const openGenerationOptions = async () => {
  const section = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((item) => item.textContent?.includes('⚡ 生成方式'));
  if (section?.getAttribute('aria-expanded') === 'false') { await act(async () => section.click()); await settle(); }
};
const change = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; expect(input, selector).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const mount = async () => { const router = createDesktopRouter(); await router.load(); await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await vi.waitFor(() => expect(container.textContent).toContain('生成战报')); await settle(); return router; };
const uploadWebZip = async (file: File) => {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"][accept*="zip"]')!; expect(picker).toBeTruthy(); Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true }))); await settle();
};
const draft = (mode: ArenaDraft['battleMode'], output: ArenaDraft['generationMode']): ArenaDraft => ({ ...createInitialArenaDraft(), battleMode: mode, generationMode: output,
  combatants: ['甲', '乙'].map((name) => ({ type: 'general-character', data: { templateId: '通用角色', name, content: '完整设定', signature: 'old-source-signature' }, isValid: false, isPreset: false, filename: name })),
  scenario: { content: mode === 'scenario' ? { templateId: '通用情景', title: '车站', content: '雨中重逢' } : null, fileName: null },
  settings: { ...createInitialArenaDraft().settings, writeNarrativeHistory: true },
});
const saveDraft = (value: ArenaDraft) => window.localStorage.setItem(ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: value }));
const calls = () => mocks.invoke.mock.calls.filter(([cmd]) => ['stream_direct_ai', 'stream_target_ai', 'hosted_ai_request', 'stream_hosted_ai'].includes(cmd));
const scopeClose = () => { const args = mocks.listen.mock.calls.at(-1)!; const event = { preventDefault: vi.fn() }; args[0](event); return event; };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); storyPort = new StoryFixturePort(); storyIpc = storyFixtureInvoke(storyPort); received = []; docs = new Map(); hold = false; failSave = false; eof = false; release = undefined; activeCloseHandles = 0; markdownSuffix = ''; webTextOverride = null; packageDocs = new Map(); packageBytes = new Map();
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'loopback' }, hiddenPresetIds: [] }));
  resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests();
  hostedStory = new HostedStoryFixture(); hostedCapabilityAvailable = true; cloudAccount = null;
  mocks.profile.mockResolvedValue({ id: 'loopback', name: 'Loopback', adapter: 'openai-compatible', baseUrl: endpoint.replace('/chat/completions', ''), modelId: 'fixture-model' });
  mocks.listen.mockImplementation(async () => { activeCloseHandles += 1; return vi.fn(() => { activeCloseHandles -= 1; }); }); mocks.download.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string, raw?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => {
    // Pending discovery is separate; the Direct record fixture must not swallow it.
    if (pendingCommands.has(command)) return hostedStory.invoke(command, raw, options);
    if (command.includes('_arena_story_')) return storyIpc.invoke(command, raw, options);
    if (command === 'cloud_cached_account') return cloudAccount ? { account: cloudAccount } : null;
    if (command === 'cloud_auth_status') return cloudAccount ? { state: 'active', account: cloudAccount } : { state: 'signed-out' };
    if (['arena_hosted_stream', 'arena_hosted_control', 'arena_hosted_detach'].includes(command)) {
      if (!hostedCapabilityAvailable && command === 'arena_hosted_stream' && (raw as { request?: { operation: string } })?.request?.operation === 'create-story-stream')
        throw { code: 'capability-unavailable', message: 'synthetic capability unavailable', dispatchState: 'not-dispatched', intentOwnership: 'current-owned' };
      return hostedStory.invoke(command, raw, options);
    }
    const args = raw as Record<string, unknown> | undefined;
    if (command === 'list_local_cards') { const request = args!.request as { cardTypes: string[] }; return { documents: [...docs.values()].filter((card) => !request.cardTypes.length || request.cardTypes.includes(card.cardType)).map((card) => JSON.stringify(card)) }; }
    if (command === 'get_local_card') return docs.has(args!.id as string) ? JSON.stringify(docs.get(args!.id as string)) : null;
    if (command === 'save_local_card') { if (failSave) throw new Error('disk-failed'); const request = args!.request as { document: string; writeMode: string }; expect(request.writeMode).toBe('insert-if-absent'); const card = JSON.parse(request.document) as LocalCardRecordV1; const alreadyPresent = docs.has(card.id); if (!alreadyPresent) docs.set(card.id, card); return { id: card.id, alreadyPresent }; }
    if (command === 'list_web_packages') return { documents: [...packageDocs.values()].filter((record) => !record.deletedAt).map((record) => JSON.stringify(record)) };
    if (command === 'get_web_package') return packageDocs.has(args!.id as string) ? JSON.stringify(packageDocs.get(args!.id as string)) : null;
    if (command === 'read_web_package_archive') { const bytes = packageBytes.get(args!.contentDigest as string); if (!bytes) throw { code: 'blob-not-found', message: 'missing' }; return bytes.slice().buffer; }
    if (command === 'save_web_package') {
      if (failSave) throw new Error('disk-failed');
      const request = args!.request as { document: string; archive: { b64: string; len: number } };
      const record = JSON.parse(request.document) as LocalWebPackageRecordV1;
      const bytes = Uint8Array.from(atob(request.archive.b64), (char) => char.charCodeAt(0)); expect(bytes.byteLength).toBe(request.archive.len);
      packageDocs.set(record.id, record); packageBytes.set(record.ref.digest, bytes); return { id: record.id, blobOutcome: 'stored', alreadyPresent: false };
    }
    if (command === 'delete_web_package' || command === 'restore_web_package') { const request = args!.request as { document: string }; const record = JSON.parse(request.document) as LocalWebPackageRecordV1; packageDocs.set(record.id, record); return; }
    if (command === 'stream_target_ai' || command === 'stream_direct_ai') {
      const request = args!.request as AiExecutionRequest; const channel = args!.onEvent as { onmessage(event: AiStreamEvent): void };
      const response = await nativeFetch(endpoint, { method: 'POST', body: JSON.stringify(request) }); const output = await response.json() as { text: string; reasoning: string };
      const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
      channel.onmessage({ ...identity, sequence: 0, type: 'started' }); channel.onmessage({ ...identity, sequence: 1, type: 'reasoning-delta', delta: output.reasoning }); channel.onmessage({ ...identity, sequence: 2, type: 'text-delta', delta: output.text });
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      if (!eof) channel.onmessage({ ...identity, sequence: 3, type: 'result', result: { ...identity, status: 'completed', output, finishReason: 'stop' } }); return;
    }
    if (command === 'public_read_cache_query') return { status: 'ready', total: 1, bodyCount: 1, entries: [{ card: { id: 'cached-1', name: '缓存角色', type: 'character', description: '完整公开副本', is_public: 1, updated_at: '2026-10-01T00:00:00Z' }, hasBody: true, lastSuccessAt: '2026-10-01T00:00:00Z', summaryUpdatedAt: '2026-10-01T00:00:00Z', bodyUpdatedAt: '2026-10-01T00:00:00Z' }] };
    if (command === 'public_read_cache_card') return { status: 'ready', availability: 'full', entry: { card: { id: 'cached-1', name: '缓存角色', type: 'character', is_public: 1, data: JSON.stringify({ templateId: '通用角色', name: '缓存角色', content: '缓存完整原文', signature: 'unverified-source' }) }, bodyUpdatedAt: '2026-10-01T00:00:00Z', lastSuccessAt: '2026-10-01T00:00:00Z' } };
    if (command === 'has_provider_secret') return true;
    if (command === 'cloud_card_library_request') return { status: 200, body: { success: true, cards: [], tags: [], total: 0 } };
    return undefined;
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
    if (url === '/languages.json') return new Response(JSON.stringify([{ code: 'zh-CN', name: '简体中文' }]));
    if (url.startsWith('/presets/') || url.startsWith('/scenario-presets/') || url.startsWith('/questionnaires/')) return new Response(readFileSync(resolve(process.cwd(), '../../content', url.slice(1)), 'utf8'));
    throw new Error('unexpected network');
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'confirm').mockReturnValue(false);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.location.hash = '#/battle'; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); release?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Desktop /battle journey against loopback fixture', () => {
  it.each(['classic', 'kizuna', 'daily', 'scenario'] as const)('%s × structured/Markdown route → execution → result → save → local-library reopen', async (mode) => {
    for (const output of ['non-stream', 'stream'] as const) {
      saveDraft(draft(mode, output)); const router = await mount(); await click('恢复草稿');
      await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
      expect(received.at(-1)!.requestKind).toBe('arena'); expect(JSON.parse(received.at(-1)!.arenaInputJson!).mode).toBe(mode);
      expect(docs.size).toBe(0); expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(text);
      await click('另存战后角色副本'); await click('保存叙事历史到本地库'); expect(docs.size).toBe(3);
      await click('完整导出 JSON'); expect(JSON.parse(mocks.download.mock.calls.at(-1)![1]).result.rawText).toContain('车站重逢');
      await act(async () => router.navigate({ to: '/local-library' })); await settle(); expect(window.location.hash).toContain('/local-library');
      await act(async () => router.navigate({ to: '/battle' })); await settle(); await click('恢复草稿'); await click('引用本地叙事历史');
      await vi.waitFor(() => expect(document.body.textContent).toContain('车站重逢')); expect(calls()).toHaveLength(output === 'stream' ? 2 : 1);
      await act(async () => root.unmount()); root = createRoot(container); docs.clear();
    }
  });
  it.each(['non-stream', 'stream'] as const)('%s result links use the existing confirmation boundary, never native href fallback', async (output) => {
    markdownSuffix = '\n\n[外部说明](https://example.test/report)\n\n[邮件目标](mailto:test@example.test)';
    saveDraft(draft('daily', output)); await mount(); await click('恢复草稿'); await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    const link = [...document.querySelectorAll('a')].find((item) => item.textContent === '外部说明')!; expect(link).toBeTruthy(); expect(link.hasAttribute('href')).toBe(false);
    await act(async () => link.click()); await settle(); expect(document.body.textContent).toContain('打开外部链接？');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'open_external_url')).toBe(false);
    await click('在系统浏览器打开'); expect(mocks.invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.test/report' });
    const mail = [...document.querySelectorAll('a')].find((item) => item.textContent === '邮件目标')!; expect(mail.hasAttribute('href')).toBe(false);
    await act(async () => mail.click()); await settle(); await click('在系统浏览器打开');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'open_external_url')).toHaveLength(1); expect(document.body.textContent).toContain('该链接不是合法的网页地址');
  });
  it('preset target uses the explicit target channel with no Hosted or profile fallback', async () => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 5, selection: { executionPreference: 'client', clientTarget: { kind: 'preset', providerId: 'deepseek' }, serverTarget: { kind: 'system' } }, hiddenPresetIds: [], presetsByProviderId: { deepseek: { selectedModelId: 'deepseek-chat', generationOverrides: {} } } }));
    saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿'); await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    expect(calls()).toHaveLength(1); expect(calls()[0]![0]).toBe('stream_target_ai'); expect(calls()[0]![1]).toMatchObject({ target: { kind: 'preset', providerId: 'deepseek' } });
  });
  it('loads bundled character/scenario presets and uploads materials through the shared controls', async () => {
    await mount(); const firstPreset = document.querySelector<HTMLButtonElement>('[aria-label="选择预设角色：翠雀"]')!;
    expect(firstPreset).toBeTruthy(); await act(async () => firstPreset.click()); await settle();
    expect(localStorage.getItem(ARENA_DRAFT_KEY), container.textContent ?? '').not.toBeNull(); let stored = JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!); expect(stored.draft.combatants[0].filename).toBe('M01_centaurea.json');
    const scenarioMode = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '📜情景模式')!;
    expect(scenarioMode).toBeTruthy(); await act(async () => scenarioMode.click()); await settle();
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.startsWith('推荐预设情景'))!.click()); await settle();
    const scenarioPreset = document.querySelector<HTMLButtonElement>('[aria-label*="谨遵女王之意"]')!;
    expect(scenarioPreset).toBeTruthy(); await act(async () => scenarioPreset.click()); await settle();
    stored = JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!); expect(stored.draft.scenario.content.title).toContain('女王');
    const file = new File(['{"name":"背景","content":"完整素材"}'], 'material.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => '{"name":"背景","content":"完整素材"}' });
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('📎 素材注入'))!.click()); await settle();
    const input = document.querySelector<HTMLInputElement>('#arena-material-upload')!; Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await settle();
    stored = JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!); expect(stored.draft.materials[0].content).toEqual({ name: '背景', content: '完整素材' });
    expect(calls()).toHaveLength(0);
  });
  it('selects real local and offline public-cache bodies without claiming online authority', async () => {
    const source: LocalCardRecordV1 = { id: 'lc_0123456789abcdef0123456789abcdef', schemaVersion: 1, storageLocation: 'local', cardType: 'character', title: '本地角色', data: { templateId: '通用角色', name: '本地角色', content: '原卡原文', signature: 'source-only' }, contentDigest: `sha256:${'a'.repeat(64)}`, provenance: { kind: 'unsigned', execution: 'imported' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }; docs.set(source.id, source);
    await mount(); const section = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('📚 角色库'))!; await act(async () => section.click()); await settle();
    await click('选择本地 / 公开角色'); await vi.waitFor(() => expect(document.body.textContent).toContain('本地角色')); await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="选择本地角色"]')!.click());
    await settle(); expect(JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!).draft.combatants[0].data.content).toBe('原卡原文'); expect(docs.get(source.id)).toEqual(source);
    await click('选择本地 / 公开角色'); const publicTab = [...document.querySelectorAll('button')].find((item) => item.textContent?.startsWith('公开'))!;
    expect(publicTab).toBeTruthy(); await act(async () => publicTab.click()); await settle(); await click('已缓存'); await vi.waitFor(() => expect(document.body.textContent).toContain('缓存角色')); await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="选择缓存角色"]')!.click()); await settle();
    const stored = JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!); expect(stored.draft.combatants).toHaveLength(2); expect(stored.draft.combatants[1]).toMatchObject({ isValid: false, isPreset: false, data: { name: '缓存角色', content: '缓存完整原文' } });
    expect(stored.draft.combatants[1]).not.toHaveProperty('sourceDataCardId'); expect(calls()).toHaveLength(0); expect(docs.size).toBe(1);
  });
  it('fails closed if the native close guard cannot register', async () => {
    mocks.listen.mockRejectedValue(new Error('native unavailable')); saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿');
    expect(container.textContent).toContain('窗口关闭保护初始化失败'); expect(button('生成战报').disabled).toBe(true); expect(calls()).toHaveLength(0);
    const provider = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    expect(provider.matches(':disabled')).toBe(true); await act(async () => provider.click());
    expect([...document.querySelectorAll('button')].some((item) => item.textContent?.includes('新建自定义连接'))).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => ['save_provider_profile', 'set_provider_secret'].includes(command))).toBe(false);
  });
  it('server non-stream is selectable without dispatching or falling back to Direct', async () => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'server', clientConnectionId: 'loopback' }, hiddenPresetIds: [] }));
    saveDraft(draft('daily', 'non-stream')); await mount(); await click('恢复草稿');
    expect(container.textContent).toContain('官方服务器生成'); expect(button('生成战报').disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>('#arena-story-guidance')?.disabled).toBe(false); expect(calls()).toHaveLength(0);
  });
  it('missing configuration leaves shared inputs editable and connection edits join the single close guard', async () => {
    mocks.profile.mockResolvedValue(null); await mount();
    expect(button('生成战报').disabled).toBe(true); expect(document.querySelector<HTMLInputElement>('#arena-story-guidance')?.disabled).toBe(false);
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!; expect(trigger).toBeTruthy();
    await act(async () => trigger.click()); await settle();
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('新建自定义连接'))!.click()); await settle();
    const editor = [...document.querySelectorAll('h3')].find((item) => item.textContent === '新建连接')!.closest('div')!;
    const input = editor.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存连接'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    vi.mocked(window.confirm).mockReturnValue(true); await click('取消', editor);
    await act(async () => { expect(scopeClose().preventDefault).not.toHaveBeenCalled(); }); expect(calls()).toHaveLength(0);
  });
  it('real shared paste/roster/team fields work; uncommitted paste joins the single close guard', async () => {
    await mount(); await click('展开角色粘贴区域（手机端推荐）');
    const area = document.querySelector<HTMLTextAreaElement>('textarea'); expect(area).toBeTruthy(); await change('textarea', JSON.stringify({ templateId: '通用角色', name: '粘贴角色', content: '新角色' }));
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    const importButton = [...document.querySelectorAll('button')].find((item) => /从文本添加角色/.test(item.textContent ?? ''));
    expect(importButton).toBeTruthy(); await act(async () => importButton!.click()); await settle(); expect(container.textContent).toContain('粘贴角色');
    expect(JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!).draft.combatants).toHaveLength(1);
    await change('textarea', JSON.stringify({ templateId: '通用角色', name: '另一角色', content: '另一设定' }));
    await act(async () => [...document.querySelectorAll('button')].find((item) => /从文本添加角色/.test(item.textContent ?? ''))!.click()); await settle();
    await click('+ 新建分队'); await change('[aria-label="分队名称"]', '先遣队');
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="分队名称"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => { expect(scopeClose().preventDefault).not.toHaveBeenCalled(); });
    for (const value of ['0', '1']) { const select = document.querySelector<HTMLSelectElement>('select[title="把角色加入/转移到该分队"]')!;
      await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下移 先遣队内 粘贴角色"]')!.click()); await settle();
    await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    const request = JSON.parse(received.at(-1)!.arenaInputJson!); expect(request.teams).toEqual({ 1: ['另一角色', '粘贴角色'] }); expect(request.teamNames).toEqual({ 1: '先遣队' });
    expect(request.combatants.map((item: { data: { name: string }; teamId: number }) => [item.data.name, item.teamId])).toEqual([['另一角色', 1], ['粘贴角色', 1]]);

  });
  it('reports shared compatibility warnings only after a current-scope import succeeds', async () => {
    await mount(); await click('展开角色粘贴区域（手机端推荐）'); await change('textarea', JSON.stringify({ name: '兼容旧卡' }));
    await act(async () => [...document.querySelectorAll('button')].find((item) => /从文本添加角色/.test(item.textContent ?? ''))!.click()); await settle();
    expect(container.textContent).toContain('格式不完全规范'); expect(JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!).draft.combatants[0].isValid).toBe(false);
    await act(async () => getDesktopAiConfigStore().selectExecutionLocation('server')); await settle(); expect(container.textContent).not.toContain('格式不完全规范');
  });
  it('dirty shared AI connection fields join the same single close guard and clear on discard', async () => {
    await mount(); const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    await act(async () => trigger.click()); await settle();
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('新建自定义连接'))!.click()); await settle();
    const editor = [...document.querySelectorAll('h3')].find((item) => item.textContent === '新建连接')!.closest('div')!;
    const field = editor.querySelector<HTMLInputElement>('input.input-field')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '未提交'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(activeCloseHandles).toBe(1); await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); });
    await click('取消', editor); expect(document.body.textContent).toContain('新建连接');
    vi.mocked(window.confirm).mockReturnValue(true); await click('取消', editor); await act(async () => { expect(scopeClose().preventDefault).not.toHaveBeenCalled(); });
  });
  it('repeat click dispatches once; native-close cancel refusal and late packet leave zero writes', async () => {
    hold = true; saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿');
    await act(async () => { button('生成战报').click(); button('生成战报').click(); });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); expect(calls()).toHaveLength(1); expect(scopeClose().preventDefault).toHaveBeenCalledOnce();
    await click('取消生成'); release!(); await settle(); await vi.waitFor(() => expect(container.textContent).toContain('生成已取消'));
    expect(docs.size).toBe(0); expect(button('另存战后角色副本')).toBeUndefined(); expect(container.textContent).toContain(text);
  });
  it('EOF/failure and disk failure retain full export; retry stores once without replay', async () => {
    saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿'); eof = true; await click('生成战报');
    await vi.waitFor(() => expect(container.textContent).toContain('生成连接或流协议失败')); expect(docs.size).toBe(0); await click('完整导出 JSON');
    expect(JSON.parse(mocks.download.mock.calls.at(-1)![1]).result.rawText).toContain(text);
    eof = false; vi.mocked(window.confirm).mockReturnValue(true); await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    failSave = true; await click('保存叙事历史到本地库'); expect(container.textContent).toContain('完整原文仍在内存');
    failSave = false; await click('保存叙事历史到本地库'); await click('保存叙事历史到本地库'); expect(docs.size).toBe(1); expect(calls()).toHaveLength(2);
  });
  it('locks target edits during a pending response, then switching never replays cancelled generation', async () => {
    hold = true; saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿'); await click('生成战报'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // Settings UI itself locks edits during generation; test the external store replacement boundary.
    expect(() => getDesktopAiConfigStore().selectExecutionLocation('server')).toThrow('生成期间');
    await click('取消生成'); release!(); await settle();
    await act(async () => { getDesktopAiConfigStore().selectExecutionLocation('server'); }); await settle(); expect(button('另存战后角色副本')).toBeUndefined(); expect(docs.size).toBe(0);
  });
  it.each(['classic', 'kizuna', 'daily', 'scenario'] as const)('advanced /arena %s completes both outputs with an independent draft', async (mode) => {
    const battleOriginal = JSON.stringify({ version: 1, draft: { ...draft('daily', 'stream'), customStoryLength: '独立简洁稿' } }); localStorage.setItem(ARENA_DRAFT_KEY, battleOriginal);
    for (const output of ['non-stream', 'stream'] as const) {
      localStorage.setItem(ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: { ...draft(mode, output), selectedQuestionnaires: [{ source: 'upload', selectionId: 'lore', questionnaire: { id: 'lore', title: '岛屿设定', kind: 'magical-girl', questions: [], loreMarkdown: '星海岛屿' } }] } }));
      window.location.hash = '#/arena'; const router = await mount(); await click('恢复草稿'); expect(container.textContent).toContain('桌面高级单次');
      await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
      expect(JSON.parse(received.at(-1)!.arenaInputJson!)).toMatchObject({ mode, questionnaires: [{ loreMarkdown: '星海岛屿' }] });
      await click('保存叙事历史到本地库'); expect([...docs.values()].some((item) => item.cardType === 'history')).toBe(true);
      await act(async () => router.navigate({ to: '/local-library' })); await settle(); expect(window.location.hash).toContain('/local-library'); expect(localStorage.getItem(ARENA_DRAFT_KEY)).toBe(battleOriginal);
      await act(async () => root.unmount()); root = createRoot(container); docs.clear();
    }
  });
  it('advanced real Lore/auxiliary/history controls freeze an edited source-aware request', async () => {
    window.location.hash = '#/arena'; localStorage.setItem(ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: draft('scenario', 'stream') }));
    await mount(); await click('恢复草稿'); await click('粘贴 JSON'); await change('textarea[placeholder*="问卷 JSON"]', JSON.stringify({ id: 'lore', title: '岛屿', kind: 'magical-girl', questions: [], loreMarkdown: '星海岛屿', adjudicationEvents: [{ type: 'binary', description: 'Lore不得执行', probability: 100 }] })); await click('导入');
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('辅助情景（可选）'))!.click()); await settle();
    await click('展开辅助情景粘贴区域'); await change('textarea[placeholder*="辅助情景"]', JSON.stringify({ templateId: '通用情景', title: '暗潮', content: '潮水上涨', adjudicationEvents: [{ id: 'aux-event', type: 'binary', description: '辅助判定', probability: 100 }] }));
    await act(async () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('日常模式'))!.click()); await settle();
    expect(JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft.battleMode).toBe('scenario'); expect(document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="辅助情景"]')?.value).toContain('潮水上涨');
    await click('从文本添加辅助情景');
    expect(JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft.adjudicationEvents).toMatchObject([{ description: '辅助判定' }]);
    await click('查看 / 编辑活动叙事历史'); await click('新建条目'); await change('[aria-label="历史标题"]', '前情'); await change('[aria-label="历史正文"]', '未提交历史');
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    await act(async () => getDesktopAiConfigStore().selectExecutionLocation('server')); await settle(); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="历史正文"]')?.value).toBe('未提交历史');
    await act(async () => getDesktopAiConfigStore().selectExecutionLocation('client')); await settle();
    await click('创建条目'); await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭叙事历史"]')!.click()); await settle();
    await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    const request = JSON.parse(received.at(-1)!.arenaInputJson!); expect(request.auxScenarios[0].title).toBe('暗潮'); expect(request.questionnaires[0].loreMarkdown).toBe('星海岛屿');
    expect(request.adjudicationEvents).toHaveLength(1); expect(request.adjudicationResults).toHaveLength(1); expect(request.adjudicationResults[0].description).toBe('辅助判定');
    expect(JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft.narrativeHistoryEntries).toHaveLength(2);
  });

  it('advanced repeated text keeps original roles but replaces source events and reports skipped names', async () => {
    window.location.hash = '#/arena'; await mount(); await click('展开角色粘贴区域（手机端推荐）');
    const add = async (content: string, events: unknown[]) => {
      await change('textarea', JSON.stringify({ templateId: '通用角色', name: '重导角色', content, adjudicationEvents: events }));
      await act(async () => [...document.querySelectorAll('button')].find((item) => /从文本添加角色/.test(item.textContent ?? ''))!.click()); await settle();
    };
    await add('原正文', [{ type: 'binary', description: '原事件', probability: 100 }]);
    await add('不可覆盖正文', [{ type: 'binary', description: '替换事件', probability: 100 }]);
    const saved = () => JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft;
    expect(saved().combatants).toHaveLength(1); expect(saved().combatants[0].data.content).toBe('原正文');
    expect(saved().adjudicationEvents).toMatchObject([{ description: '替换事件' }]); expect(container.textContent).toContain('已跳过 1 位重复文件名角色');
    await add('空事件副本', []); expect(saved().adjudicationEvents).toMatchObject([{ description: '替换事件' }]);
  });
  it('advanced raw history import, display sort, explicit order, save failure and full export stay separate', async () => {
    window.location.hash = '#/arena'; await mount(); await click('查看 / 编辑活动叙事历史'); await click('粘贴导入');
    const raw = '  [{"entries":[{"id":"a","title":"先","content":"原文一","unknown":true,"updatedAt":"2020-01-01"}]},{"entries":[{"id":"b","title":"后","content":"原文二","updatedAt":"2025-01-01"}]}]  ';
    await change('textarea[placeholder*="粘贴叙事历史 JSON"]', raw); await click('确认追加导入');
    const saved = () => JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft;
    expect(saved().historyOriginals[0].text).toBe(raw); expect(saved().narrativeHistoryEntries.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
    const sort = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
    await act(async () => { sort.value = 'created_desc'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(saved().narrativeHistoryEntries.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
    await click('编辑 AI 顺序'); await click('下移'); await click('完成排序');
    expect(saved().narrativeHistoryEntries.map((entry: { id: string }) => entry.id)).toEqual(['b', 'a']);
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="button"]')!.click()); await settle();
    const originalId = saved().narrativeHistoryEntries.find((entry: { title: string }) => entry.title === document.querySelector<HTMLInputElement>('[aria-label="历史标题"]')!.value).id;
    await change('[aria-label="历史正文"]', '用户修订正文'); await click('保存修改'); expect(saved().narrativeHistoryEntries.find((entry: { id: string }) => entry.id === originalId).content).toBe('用户修订正文');
    await click('删除'); expect(saved().narrativeHistoryEntries).toHaveLength(2); await click('← 返回列表');
    await click('粘贴导入'); await change('textarea[placeholder*="粘贴叙事历史 JSON"]', '{"entries":[{"id":"replace","content":"替代"}]}');
    const mode = [...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')].find((item) => item.querySelector('option[value="replace"]'))!;
    await act(async () => { mode.value = 'replace'; mode.dispatchEvent(new Event('change', { bubbles: true })); }); await click('确认覆盖导入');
    expect(saved().narrativeHistoryEntries).toHaveLength(2); expect(saved().historyOriginals).toHaveLength(1);
    vi.mocked(window.confirm).mockReturnValue(true); await click('取消', document.querySelector('[role="dialog"]')!); vi.mocked(window.confirm).mockReturnValue(false);
    failSave = true; await click('另存完整历史到本地库'); expect(document.body.textContent).toContain('完整原文仍在内存');
    failSave = false; await click('另存完整历史到本地库'); await click('另存完整历史到本地库'); expect(docs.size).toBe(1);
    const record = [...docs.values()][0]!; expect(record.provenance).toEqual({ kind: 'unsigned' });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭叙事历史"]')!.click()); await settle();
    await click('导出当前会话'); const exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]); expect(exported.draft.historyOriginals[0].text).toBe(raw);
    expect(calls()).toHaveLength(0);
  });
  it('advanced late history upload after target change preserves unsubmitted paste and writes nothing', async () => {
    window.location.hash = '#/arena'; await mount(); await click('查看 / 编辑活动叙事历史'); await click('粘贴导入');
    const raw = '{"entries":[{"id":"paste","content":"未提交粘贴原件"}]}'; await change('textarea[placeholder*="粘贴叙事历史 JSON"]', raw);
    let finish!: (text: string) => void; const pending = new Promise<string>((resolve) => { finish = resolve; });
    const file = new File(['fixture'], 'pending-history.json'); Object.defineProperty(file, 'text', { value: () => pending });
    vi.mocked(window.confirm).mockReturnValue(true); const fileInput = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] }); await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true }))); await settle();
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    await act(async () => getDesktopAiConfigStore().selectExecutionLocation('server')); await settle();
    await act(async () => finish('{"entries":[{"id":"late","content":"迟到"}]}')); await settle();
    expect(document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="粘贴叙事历史 JSON"]')?.value).toBe(raw);
    expect(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)).toBeNull(); expect(docs.size).toBe(0); expect(calls()).toHaveLength(0);
    vi.mocked(window.confirm).mockReturnValue(false); await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); });
    await click('确认追加导入'); expect(JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft.narrativeHistoryEntries[0].id).toBe('paste');
  });

  it('advanced shared Lore local/preset controls and manual events freeze only enabled sources', async () => {
    const local: LocalCardRecordV1 = { id: 'lc_abcdef0123456789abcdef0123456789', schemaVersion: 1, storageLocation: 'local', cardType: 'questionnaire', title: '本地设定', data: { id: 'local-lore', title: '本地设定', kind: 'magical-girl', questions: [], loreMarkdown: '本地岛屿', nativeAllowed: true }, contentDigest: `sha256:${'c'.repeat(64)}`, provenance: { kind: 'unsigned', execution: 'imported' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }; docs.set(local.id, local);
    window.location.hash = '#/arena'; localStorage.setItem(ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: draft('daily', 'stream') }));
    await mount(); await click('恢复草稿'); await click('选择本地 / 公开设定'); await vi.waitFor(() => expect(document.querySelector('[aria-label="选择本地设定"]')).toBeTruthy());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="选择本地设定"]')!.click()); await settle();
    const select = [...document.querySelectorAll('select')].find((item) => item.querySelector('option[value="girl-band-taiban-war-1.1"]'))!;
    await act(async () => { select.value = 'girl-band-taiban-war-1.1'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
    const saved = () => JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft;
    expect(saved().selectedQuestionnaires).toHaveLength(2); expect(saved().selectedQuestionnaires[0]).toMatchObject({ source: 'upload', questionnaire: { nativeAllowed: false } });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下移 本地设定"]')!.click());
    const localRow = document.querySelector('[aria-label="上移 本地设定"]')!.closest('li')!; await act(async () => localRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(saved().selectedQuestionnaires[1].useLore).toBe(false); await click('+ 添加根判定事件'); await change('textarea[placeholder*="输入事件描述"]', '手动天空判定');
    await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    const request = JSON.parse(received.at(-1)!.arenaInputJson!); expect(request.questionnaires).toHaveLength(2); expect(request.questionnaires[0].id).toBe('girl-band-taiban-war-1.1'); expect(request.questionnaires[1].useLore).toBe(false);
    expect(received.at(-1)!.messages.map((message) => message.content).join('')).not.toContain('本地岛屿');
    expect(request.adjudicationResults).toMatchObject([{ description: '手动天空判定' }]); expect(docs.get(local.id)).toEqual(local);
  });

});


describe('Desktop Web source journey with execution closed', () => {
  it.each((['battle', 'arena'] as const).flatMap((product) => (['classic', 'kizuna', 'daily', 'scenario'] as const).map((mode) => ({ product, mode }))))('$product $mode × both delivery modes generates/saves/reopens without mounting content', async ({ product, mode }) => {
    for (const output of ['stream', 'non-stream'] as const) {
      const key = product === 'arena' ? ADVANCED_ARENA_DRAFT_KEY : ARENA_DRAFT_KEY;
      localStorage.setItem(key, JSON.stringify({ version: 1, draft: { ...draft(mode, output), reportFormat: 'web' } }));
      window.location.hash = `#/${product}`;
      const router = await mount(); await click('恢复草稿'); await settle(); await click('生成战报');
      await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
      expect(container.querySelector('[aria-label="Web 战报源码（安全文本）"]')?.textContent).toContain('webShouldNotRun');
      expect(container.querySelector('iframe, script, img[src*="untrusted.invalid"]')).toBeNull();
      expect((globalThis as { webShouldNotRun?: boolean }).webShouldNotRun).toBeUndefined();
      expect(button('运行 Web 战报').disabled).toBe(true);
      expect(mocks.invoke.mock.calls.some(([command]) => /^(begin_web_package_instance|append_web_package_resource|open_web_package_instance)$/.test(command))).toBe(false);
      expect(JSON.parse(received.at(-1)!.arenaInputJson!).reportFormat).toBe('web');
      await click('完整导出 JSON'); const exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]);
      expect(exported.result.renderSnapshot.reportFormat).toBe('web'); expect(exported.result.rawText).toContain('MAHOSHOJO_ARENA_META'); expect(exported.result.markdown).not.toContain('MAHOSHOJO_ARENA_META');
      await click('保存叙事历史到本地库'); expect([...docs.values()].some((record) => record.cardType === 'history')).toBe(true);
      await act(async () => router.navigate({ to: '/local-library' })); await settle();
      await act(async () => router.navigate({ to: `/${product}` })); await settle(); await click('恢复草稿');
      expect(container.querySelector('[aria-label="Web 战报源码（安全文本）"]')?.textContent).toContain('webShouldNotRun'); expect(button('运行 Web 战报').disabled).toBe(true);
      await act(async () => root.unmount()); root = createRoot(container); docs.clear();
    }
  });
  it.each((['battle', 'arena'] as const).flatMap((product) => (['classic', 'kizuna', 'daily', 'scenario'] as const).map((mode) => ({ product, mode }))))('$product $mode package target × both delivery modes uses the real preset and frozen artifact', async ({ product, mode }) => {
    for (const output of ['stream', 'non-stream'] as const) {
      const key = product === 'arena' ? ADVANCED_ARENA_DRAFT_KEY : ARENA_DRAFT_KEY;
      localStorage.setItem(key, JSON.stringify({ version: 1, draft: { ...draft(mode, output), reportFormat: 'web' } })); window.location.hash = `#/${product}`;
      await mount(); await click('恢复草稿'); await settle(); await openGenerationOptions(); await click('选择 Web 包');
      const preset = document.querySelector<HTMLButtonElement>('[aria-label="选择 Web 包：竞技场新闻"]');
      expect(preset, document.body.textContent ?? '').toBeTruthy(); await act(async () => preset!.click()); await settle();
      await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
      expect(JSON.parse(received.at(-1)!.arenaInputJson!).webPackageRef).toEqual(BUILTIN_WEB_PACKAGE_PRESETS[0]!.packageRef);
      await click('完整导出 JSON'); const exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]);
      expect(exported.result.renderSnapshot.webPackage.targetPath).toBe('index.html'); expect(exported.result.markdown).toBe(webHtml + '\n');
      expect(button('运行 Web 战报').disabled).toBe(true); expect(activeCloseHandles).toBe(1);
      expect(mocks.invoke.mock.calls.some(([command]) => /^(begin_web_package_instance|append_web_package_resource|open_web_package_instance)$/.test(command))).toBe(false);
      await act(async () => root.unmount()); root = createRoot(container);
    }
  });
  it('imports ZIP with explicit local saving, reopens its exact record, and downloads original bytes', async () => {
    const base = await builtinWebPackageSource.resolve(BUILTIN_WEB_PACKAGE_PRESETS[0]!.packageRef), archive = await packWebPackageZip(base);
    saveDraft({ ...draft('daily', 'stream'), reportFormat: 'web' }); await mount(); await click('恢复草稿'); await settle(); await openGenerationOptions(); await click('选择 Web 包');
    const localTab = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => localTab.click()); await settle();
    const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((entry) => entry.closest('label')?.textContent?.includes('导入时保存到本地库'))!;
    expect(checkbox).toBeTruthy(); expect(checkbox.checked).toBe(false); await act(async () => checkbox.click());
    const file = new File([archive.slice().buffer], 'original.zip', { type: 'application/zip' }); Object.defineProperty(file, 'arrayBuffer', { value: async () => archive.slice().buffer });
    const picker = document.querySelector<HTMLInputElement>('input[type="file"][accept*="zip"]')!; expect(picker).toBeTruthy(); Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true }))); await vi.waitFor(() => expect(packageDocs.size).toBe(1)); await settle();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'save_web_package')).toHaveLength(1);
    expect(localStorage.getItem(ARENA_DRAFT_KEY)).toContain(base.ref.digest);
    await act(async () => root.unmount()); root = createRoot(container); await mount(); await click('恢复草稿'); await settle(); await openGenerationOptions(); await click('更换 Web 包');
    const tab = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => tab.click()); await settle();
    const download = document.querySelector<HTMLButtonElement>('[aria-label="下载 Web 包 ZIP：竞技场新闻"]'); expect(download, document.body.textContent ?? '').toBeTruthy(); await act(async () => download!.click());
    await vi.waitFor(() => expect(mocks.downloadBinary).toHaveBeenCalled()); expect(mocks.downloadBinary.mock.calls.at(-1)![1]).toEqual(archive);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'open_web_package_instance')).toBe(false);
  });
  it.each([
    { mediaType: 'application/json', generated: '```json\n{"value":7}\n```', normalized: '{"value":7}' },
    { mediaType: 'text/javascript', generated: 'globalThis.generatedMustNotRun = true;', normalized: 'globalThis.generatedMustNotRun = true;\n' },
    { mediaType: 'text/css', generated: 'body { background: url(https://untrusted.invalid/background); }', normalized: 'body { background: url(https://untrusted.invalid/background); }\n' },
  ])('imports and validates $mediaType without evaluating or dropping opaque base resources', async ({ mediaType, generated, normalized }) => {
    const { file, base } = await arenaWebPackageFixture({ mediaType }); webTextOverride = generated + '\n' + webTrailer;
    saveDraft({ ...draft('daily', 'stream'), reportFormat: 'web' }); await mount(); await click('恢复草稿'); await openGenerationOptions(); await click('选择 Web 包');
    const tab = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => tab.click()); await settle();
    const picker = document.querySelector<HTMLInputElement>('input[type="file"][accept*="zip"]')!; Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true }))); await vi.waitFor(() => expect(localStorage.getItem(ARENA_DRAFT_KEY)).toContain(base.ref.digest)); await settle();
    expect(packageDocs.size).toBe(0); await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    await click('完整导出 JSON'); const exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]);
    expect(exported.result.markdown).toBe(normalized); expect(exported.result.rawText).toBe(webTextOverride);
    expect(exported.result.renderSnapshot.webPackage).toMatchObject({ packageRef: base.ref, targetPath: base.manifest.generation.target, targetMediaType: mediaType });
    expect(container.querySelector('iframe,script,style')).toBeNull(); expect((globalThis as { generatedMustNotRun?: boolean }).generatedMustNotRun).toBeUndefined();
    expect(button('运行 Web 战报').disabled).toBe(true); expect(activeCloseHandles).toBe(1);
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(window.confirm).toHaveBeenCalled();
    await click('下载生成目标');
    if (mediaType !== 'application/json') { expect(mocks.download.mock.calls.at(-1)![0]).toBe('arena-complete.json'); vi.mocked(window.confirm).mockReturnValue(true); await click('下载生成目标'); }
    expect(mocks.download.mock.calls.at(-1)![1]).toBe(normalized);
    await vi.waitFor(() => expect(button('下载精确 Base ZIP（不含生成目标）').disabled).toBe(false)); await click('下载精确 Base ZIP（不含生成目标）');
    const exportedBase = await unpackWebPackageZip(mocks.downloadBinary.mock.calls.at(-1)![1]); expect(exportedBase.ref).toEqual(base.ref);
    expect(exportedBase.readFile('unknown.bin')).toEqual(new Uint8Array([0, 255, 11, 42])); expect(exportedBase.readFile(base.manifest.generation.target)).toBeUndefined();
  });

  it('keeps a failed package save exportable and fences a late file read after target change', async () => {
    const { file, archive, base } = await arenaWebPackageFixture();
    saveDraft({ ...draft('daily', 'stream'), reportFormat: 'web' }); await mount(); await click('恢复草稿'); await openGenerationOptions(); await click('选择 Web 包');
    const tab = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => tab.click()); await settle();
    const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((entry) => entry.closest('label')?.textContent?.includes('导入时保存到本地库'))!; await act(async () => checkbox.click()); failSave = true;
    await uploadWebZip(file); await vi.waitFor(() => expect(document.body.textContent).toContain('保存失败')); expect(packageDocs.size).toBe(0);
    const download = document.querySelector<HTMLButtonElement>('[aria-label="下载 Web 包 ZIP：本地 json 包"]')!; expect(download).toBeTruthy(); await act(async () => download.click());
    await vi.waitFor(() => expect(mocks.downloadBinary).toHaveBeenCalled()); expect(mocks.downloadBinary.mock.calls.at(-1)![1]).toEqual(archive);
    let finish!: (buffer: ArrayBuffer) => void; const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const late = new File(['pending'], 'late.zip'); Object.defineProperty(late, 'arrayBuffer', { value: () => pending });
    await uploadWebZip(late); const writes = mocks.invoke.mock.calls.filter(([command]) => command === 'save_web_package').length;
    await act(async () => { expect(scopeClose().preventDefault).toHaveBeenCalledOnce(); }); expect(activeCloseHandles).toBe(1);
    await act(async () => getDesktopAiConfigStore().selectExecutionLocation('server')); await settle(); finish(archive.slice().buffer); await settle();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'save_web_package')).toHaveLength(writes); expect(packageDocs.size).toBe(0);
    expect(JSON.parse(localStorage.getItem(ARENA_DRAFT_KEY)!).draft.webPackageRef).toEqual(base.ref);
    expect(document.body.textContent).toContain('官方服务器生成'); expect(mocks.invoke.mock.calls.some(([command]) => command === 'open_web_package_instance')).toBe(false);
  });

  it.each(['cancel', 'EOF', 'target'] as const)('Web package %s retains partial source with no success artifact, history or duplicate execution', async (ending) => {
    hold = ending !== 'EOF'; eof = ending === 'EOF';
    saveDraft({ ...draft('daily', 'stream'), reportFormat: 'web', webPackageRef: BUILTIN_WEB_PACKAGE_PRESETS[0]!.packageRef });
    await mount(); await click('恢复草稿'); await act(async () => { button('生成战报').click(); button('生成战报').click(); });
    await vi.waitFor(() => expect(calls()).toHaveLength(1)); await settle();
    if (ending === 'cancel') { await click('取消生成'); release?.(); }
    if (ending === 'target') { expect(() => getDesktopAiConfigStore().selectExecutionLocation('server')).toThrow('生成期间'); await click('取消生成'); release?.(); await vi.waitFor(() => expect(getDesktopAiConfigStore().getSnapshot().generationActive).toBe(false)); await act(async () => getDesktopAiConfigStore().selectExecutionLocation('server')); await settle(); }
    await vi.waitFor(() => expect(button('取消生成')).toBeUndefined());
    await click('完整导出 JSON'); const exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]);
    expect(exported.result.rawText).toContain('webShouldNotRun'); expect(exported.result.phase).not.toBe('completed'); expect(exported.result.renderSnapshot).toBeNull(); expect(exported.candidates).toBeNull();
    expect(exported.draft.narrativeHistoryEntries).toEqual([]); expect(docs.size).toBe(0); expect(calls()).toHaveLength(1);
    expect(container.querySelector('iframe,script,img[src*="untrusted.invalid"]')).toBeNull(); expect(button('运行 Web 战报').disabled).toBe(true);
  });

  it('restores missing exact packages, requires explicit candidate selection, and preserves historical provenance through compatibility', async () => {
    const original = await arenaWebPackageFixture({ version: '1.0.0' }), second = await arenaWebPackageFixture({ version: '2.0.0' }), third = await arenaWebPackageFixture({ version: '3.0.0' });
    webTextOverride = '{"value":3}\n' + webTrailer;
    saveDraft({ ...draft('daily', 'stream'), reportFormat: 'web' }); await mount(); await click('恢复草稿'); await openGenerationOptions(); await click('选择 Web 包');
    const tab = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => tab.click()); await settle();
    await uploadWebZip(original.file); await click('生成战报'); await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    await act(async () => root.unmount()); root = createRoot(container); await mount(); await click('恢复草稿');
    await vi.waitFor(() => expect(document.body.textContent).toContain('revision 不可用'));
    const replayImport = async (file: File) => { const picker = document.querySelector<HTMLInputElement>('[data-testid="arena-web-replay-controls"] input[type="file"]')!; expect(picker).toBeTruthy(); Object.defineProperty(picker, 'files', { configurable: true, value: [file] }); await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true }))); await settle(); };
    await replayImport(wrappedArenaWebPackageFile()); await vi.waitFor(() => expect(document.body.textContent).toContain('可用候选 2.0.0'));
    expect(document.querySelector('[data-testid="arena-web-replay-controls"]')?.textContent).toContain('synthetic-wrapper/');
    expect(document.querySelector('[data-testid="arena-web-replay-controls"]')?.textContent).toContain(second.base.ref.digest);
    expect(document.body.textContent).not.toContain('当前使用的是不同版本');
    await replayImport(third.file); await vi.waitFor(() => expect(document.querySelector('[data-testid="arena-web-replay-controls"] select')) .toBeTruthy());
    expect(button('确认兼容校验此版本').disabled).toBe(true);
    const select = document.querySelector<HTMLSelectElement>('[data-testid="arena-web-replay-controls"] select')!;
    await act(async () => { select.value = third.base.ref.digest; select.dispatchEvent(new Event('change', { bubbles: true })); }); await click('确认兼容校验此版本');
    await vi.waitFor(() => expect(document.body.textContent).toContain('当前使用的是不同版本'));
    await click('完整导出 JSON'); let exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]); expect(exported.result.renderSnapshot.webPackage.packageRef).toEqual(original.base.ref);
    expect(button('运行 Web 战报').disabled).toBe(true); expect(button('下载精确 Base ZIP（不含生成目标）').disabled).toBe(true);
    await openGenerationOptions(); await click('更换 Web 包'); const local = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim().startsWith('本地库'))!; await act(async () => local.click()); await settle(); await uploadWebZip(original.file);
    await vi.waitFor(() => expect(document.body.textContent).toContain('已验证精确包与生成目标'));
    await click('完整导出 JSON'); exported = JSON.parse(mocks.download.mock.calls.at(-1)![1]); expect(exported.result.renderSnapshot.webPackage.packageRef).toEqual(original.base.ref);
    expect(packageDocs.size).toBe(0); expect(mocks.invoke.mock.calls.some(([command]) => command === 'open_web_package_instance')).toBe(false);
  });

});


describe('Desktop two-route continuous story through actual default binder', () => {
  it.each(['battle', 'arena'] as const)('%s starts, explicitly continues, reopens the same device story and exports the complete chain', async (product) => {
    const value = draft('daily', 'non-stream');
    window.localStorage.setItem(product === 'arena' ? ADVANCED_ARENA_DRAFT_KEY : ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: value }));
    window.location.hash = `#/${product}`; const router = await mount(); await click('恢复草稿');
    await click('新建连续战报'); await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount).toBe(1)); await settle();
    expect(container.querySelector('[aria-label="连续战报会话"]')?.textContent).toContain('共 1 章');
    expect(JSON.parse(received[0]!.arenaInputJson!).internalGuidance).toContain('首章');
    expect(JSON.parse(localStorage.getItem(product === 'arena' ? ADVANCED_ARENA_DRAFT_KEY : ARENA_DRAFT_KEY)!).draft.combatants).toEqual(value.combatants);
    await change('textarea[aria-label="下一章故事引导"]', '沿本故事继续');
    await click('继续续写'); await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount).toBe(2)); await settle();
    expect(received).toHaveLength(2); expect(JSON.parse(received[1]!.arenaInputJson!).userGuidance).toBe('沿本故事继续');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'append_arena_story_part').every(([,body]) => body instanceof Uint8Array)).toBe(true);
    await click('导出完整 Markdown'); await vi.waitFor(() => expect(container.textContent).toContain('完整故事已导出'));
    expect(storyIpc.exported).toContain('章节数：2 章'); expect(storyIpc.exported.match(/^# 车站重逢$/gm)).toHaveLength(3);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => router.navigate({ to: product === 'battle' ? '/arena' : '/battle' })); await settle();
    await vi.waitFor(() => expect(container.querySelector('[data-story-read-status="loaded"]')).not.toBeNull());
    expect(container.querySelector('[aria-label="连续战报会话"]')?.textContent).toContain('共 2 章'); expect(received).toHaveLength(2);
    expect(activeCloseHandles).toBe(1);
  });
  it('shows query-only unknown saving in the actual route and never starts another model', async () => {
    storyPort.loseEndReply = true; storyPort.hideReceipts = true;
    saveDraft(draft('daily','stream')); await mount(); await click('恢复草稿'); await click('新建连续战报');
    await vi.waitFor(() => expect(container.textContent).toContain('保存状态待确认')); await settle();
    await click('查询原保存结果'); expect(received).toHaveLength(1); expect(storyPort.begin).toHaveBeenCalledTimes(1);
    await click('导出未保存章节'); expect(mocks.download.mock.calls.at(-1)![1]).toContain(text);
    storyPort.hideReceipts = false; await click('查询原保存结果'); await vi.waitFor(() => expect(container.textContent).toContain('完整章节已保存到本机故事'));
    expect(received).toHaveLength(1); expect(storyPort.begin).toHaveBeenCalledTimes(1);
  });
  it.each(['single', 'story'] as const)('delayed anonymous bootstrap preserves in-flight Direct %s credential preparation', async flow => {
    localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 5,
      selection: { executionPreference: 'client', clientTarget: { kind: 'preset', providerId: 'deepseek' }, serverTarget: { kind: 'system' } },
      hiddenPresetIds: [], presetsByProviderId: { deepseek: { selectedModelId: 'deepseek-chat', generationOverrides: {} } } }));
    const bootstrap = deferred<null>(), credential = deferred<boolean>(), originalInvoke = mocks.invoke.getMockImplementation()!;
    let holdCredential = false;
    mocks.invoke.mockImplementation((command, args, options) => command === 'cloud_cached_account' ? bootstrap.promise
      : command === 'has_provider_secret' && holdCredential ? credential.promise : originalInvoke(command, args, options));
    release = () => { bootstrap.resolve(null); credential.resolve(true); };
    saveDraft(draft('daily', 'stream')); await mount(); await click('恢复草稿');
    expect(getDesktopCloudSessionStore().getSnapshot().bootstrapped).toBe(false);
    holdCredential = true;
    await click(flow === 'single' ? '生成战报' : '新建连续战报');
    expect(getDesktopAiConfigStore().isPreparingGeneration()).toBe(true); expect(calls()).toHaveLength(0);
    const cancelPreparing = vi.spyOn(getDesktopAiConfigStore(), 'cancelPreparingGeneration');
    await act(async () => bootstrap.resolve(null)); await settle();
    expect(getDesktopCloudSessionStore().getSnapshot()).toMatchObject({ bootstrapped: true, account: null });
    expect(cancelPreparing).not.toHaveBeenCalled(); expect(getDesktopAiConfigStore().isPreparingGeneration()).toBe(true);
    await act(async () => credential.resolve(true)); await settle();
    if (flow === 'story') await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount).toBe(1));
    else await vi.waitFor(() => expect(container.textContent).toContain('生成完成。'));
    expect(calls()).toHaveLength(1); expect(calls()[0]).toMatchObject(['stream_target_ai', { target: { kind: 'preset', providerId: 'deepseek' } }]);
    expect(received).toHaveLength(1); expect(hostedStory.streams).toHaveLength(0); expect(hostedStory.slots.size).toBe(0);
    expect(getDesktopAiConfigStore().isPreparingGeneration()).toBe(false);
  });

  it('stops a real in-flight Direct chapter, preserves received prose and leaves the stored chain intact', async () => {
    saveDraft(draft('daily','stream')); await mount(); await click('恢复草稿'); await click('新建连续战报');
    await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount).toBe(1)); await settle();hold = true;
    await click('继续续写'); await vi.waitFor(() => expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain(text));
    await click('停止章节生成'); release?.(); await settle();
    expect(storyPort.heads()[0]?.chapterCount).toBe(1); expect(storyPort.begin).toHaveBeenCalledTimes(1); expect(received).toHaveLength(2);
    await click('导出完整原始输出'); expect(JSON.parse(mocks.download.mock.calls.at(-1)![1]).rawText).toContain(text);
    expect(scopeClose().preventDefault).toHaveBeenCalled();
  });
});


// Actual RouterProvider → DesktopBattleForm → owner → default IPC binders.
// Native IPC and saved-credential presence are synthetic, never real keys/accounts.
describe('Desktop Hosted story routes through prepared targets and default binders', () => {
  const enableHosted = () => {
    // Match browser TextEncoder byte realm; Node's encoder otherwise fails IPC instanceof guards in jsdom.
    vi.stubGlobal('TextEncoder', class extends NodeTextEncoder { encode(input?: string) { return Uint8Array.from(super.encode(input)); } });
    storyPort = hostedStory.records; storyIpc = hostedStory.recordInvoke;
    // Native independently checks the public prewrite in the real page's localStorage.
    vi.spyOn(hostedStory.pointers, 'get').mockImplementation(key => localStorage.getItem(key) ?? undefined);
  };
  const mountProduct = async (product: 'battle' | 'arena') => {
    localStorage.setItem(product === 'battle' ? ARENA_DRAFT_KEY : ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: draft('daily', 'non-stream') }));
    window.location.hash = `#/${product}`;
    const router = await mount(); await click('恢复草稿'); return router;
  };
  const chooseHosted = async (funding: 'system' | 'preset') => {
    await click('服务器');
    if (funding === 'preset') {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
      await act(async () => trigger.click()); await settle();
      const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.querySelector('span')?.textContent?.trim() === 'DeepSeek')!;
      expect(option).toBeTruthy(); await act(async () => option.click()); await settle();
      const modelTrigger = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')[1]!;
      await act(async () => modelTrigger.click()); await settle();
      const model = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.querySelector('span')?.textContent?.trim() === 'DeepSeek-V3.2')!;
      expect(model).toBeTruthy(); await act(async () => model.click()); await settle();
    }
    expect(getDesktopAiConfigStore().getSnapshot().selection).toMatchObject({ executionPreference: 'server', serverTarget: funding === 'system' ? { kind: 'system' } : { kind: 'preset', providerId: 'deepseek' } });
  };
  const requests = (operation: string) => hostedStory.streams.filter(request => request.operation === operation);
  const streamCommands = (operation: string) => mocks.invoke.mock.calls.filter(([command, args]) => command === 'arena_hosted_stream' && args.request.operation === operation);
  const settledChapter = async (count: number) => {
    await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount, container.textContent ?? '').toBe(count)); await settle();
    expect(container.querySelector('[aria-label="连续战报会话"]')?.textContent).toContain(`共 ${count} 章`);
  };
  for (const product of ['battle', 'arena'] as const) it.each(['system', 'preset'] as const)(`${product}/%s selects the real prepared Hosted target, saves one start and continuation, then reads the directory`, async funding => {
    enableHosted(); const router = await mountProduct(product); await chooseHosted(funding);
    const prepared = vi.spyOn(getDesktopAiConfigStore(), 'withPreparedGeneration');
    expect(button('生成战报').disabled).toBe(false); expect(button('新建连续战报').disabled).toBe(false);
    await click('新建连续战报'); await settledChapter(1);
    expect(prepared).toHaveBeenCalledTimes(1); expect(requests('create-story-stream')).toHaveLength(1); expect(requests('reconcile-story')).toHaveLength(1);
    expect(hostedStory.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(1); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(1);
    const sessionId = storyPort.heads()[0]!.id;
    await change('textarea[aria-label="下一章故事引导"]', '沿原 Hosted 故事续写'); await click('继续续写'); await settledChapter(2);
    expect(prepared).toHaveBeenCalledTimes(2); expect(requests('create-story-stream')).toHaveLength(2); expect(requests('reconcile-story')).toHaveLength(2);
    expect(hostedStory.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(2); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(2);
    expect(hostedStory.attempts.size).toBe(0); expect(storyPort.heads()).toHaveLength(1); expect(storyPort.heads()[0]!.id).toBe(sessionId);
    for (const request of requests('create-story-stream')) {
      expect(request).toMatchObject({ product, actor: { kind: 'anonymous' }, ...(funding === 'system' ? { systemConfig: {} } : { presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } }) });
      expect(request).not.toHaveProperty(funding === 'system' ? 'presetConfig' : 'systemConfig'); expect(request).not.toHaveProperty('body');
      expect(request).not.toHaveProperty('apiKey'); expect(request).not.toHaveProperty('combatants');
    }
    const second = hostedStory.sealed.find(item => item.snapshot.manifest.expectedRevision === 1)!;
    const input = JSON.parse(new TextDecoder().decode(second.bytes.get('input')));
    expect(input).toMatchObject({ action: 'continue', userGuidance: '沿原 Hosted 故事续写', chapterIndex: 2 });
    expect(input.chapterContext.workingCombatants[0]).toMatchObject({ data: { name: '甲', signature: 'server-signed-fixture' }, isNative: true });
    expect(JSON.parse(localStorage.getItem(product === 'battle' ? ARENA_DRAFT_KEY : ADVANCED_ARENA_DRAFT_KEY)!).draft.combatants).toEqual(draft('daily', 'non-stream').combatants);
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS[product])).toBeNull(); expect(hostedStory.slots.size).toBe(0);
    expect(received).toHaveLength(0); expect(calls()).toHaveLength(0);
    await click('导出完整 Markdown'); await vi.waitFor(() => expect(container.textContent).toContain('完整故事已导出'));
    expect(storyIpc.exported).toContain('章节数：2 章'); expect(storyIpc.exported).toContain(hostedStory.markdown.trim());
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => router.navigate({ to: product === 'battle' ? '/arena' : '/battle' })); await settle();
    await vi.waitFor(() => expect(container.querySelector('[data-story-read-status="loaded"]')).not.toBeNull());
    expect(container.querySelector('[data-story-read-status="loaded"]')?.textContent).toContain('合成故事');
    expect(container.querySelector('[aria-label="连续战报会话"]')?.textContent).toContain('共 2 章');
    expect(requests('create-story-stream')).toHaveLength(2); expect(activeCloseHandles).toBe(1);
  });
  it.each(['battle', 'arena'] as const)('%s Native-only candidate opens its original product from the other route and restores without a fresh create', async product => {
    enableHosted(); hostedStory.roleMode = 'network'; const router = await mountProduct(product); await chooseHosted('system');
    await click('新建连续战报'); await vi.waitFor(() => expect(container.textContent).toContain('Hosted 正文已封存，尚未保存到故事')); await settle();
    const original = structuredClone(hostedStory.slots.get(product)!.snapshot);
    expect(requests('create-story-stream')).toHaveLength(1); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    localStorage.removeItem(ARENA_HOSTED_RECOVERY_KEYS[product]);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => router.navigate({ to: product === 'battle' ? '/arena' : '/battle' })); await settle();
    const foreign = document.querySelector(`[aria-label="${product === 'battle' ? '简洁版 /battle' : '高级版 /arena'}原候选"]`)!;
    expect(foreign.textContent).toContain(original.manifest.requestId); expect(button('读取原件（本地）', foreign)).toBeUndefined();
    await click(`前往${product === 'battle' ? '简洁版 /battle' : '高级版 /arena'}处理原候选`, foreign);
    expect(window.location.hash).toBe(`#/${product}`); await click('读取原件（本地）'); await settle();
    expect(hostedStory.slots.get(product)!.snapshot.manifest).toEqual(original.manifest);
    expect(button('恢复原请求').disabled).toBe(false); expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS[product])).toBeNull();
    hostedCapabilityAvailable = false;
    await click('恢复原请求'); await vi.waitFor(() => expect(requests('resume')).toHaveLength(1)); await settle();
    expect(hostedStory.controls.at(-1)).toEqual({ operation: 'lookup-request', product, requestId: original.manifest.requestId, actor: original.manifest.actor, restoreSession: true });
    expect(requests('resume')[0]).not.toHaveProperty('after'); expect(streamCommands('create-story-stream')).toHaveLength(1);
    expect(requests('reconcile-story')).toHaveLength(1); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS[product])!)).toMatchObject({ version: 4, purpose: 'story', product, requestId: original.manifest.requestId });
    expect(received).toHaveLength(0);
  });
  it('a proven capability rejection gates create only, keeps the no-claim original readable, and never falls back', async () => {
    enableHosted(); hostedCapabilityAvailable = false; await mountProduct('battle'); await chooseHosted('system'); await click('新建连续战报');
    await vi.waitFor(() => expect(container.textContent).toContain('服务器尚未声明所选生成方式及身份保护所需协议'));
    expect(streamCommands('create-story-stream')).toHaveLength(1); expect(hostedStory.streams).toHaveLength(0); expect(hostedStory.controls).toHaveLength(0);
    expect(hostedStory.slots.get('battle')!.snapshot.createClaim).toBeNull(); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(button('新建连续战报').disabled).toBe(true); expect(button('恢复原请求').disabled).toBe(true);
    await click('导出全部已封存原件'); expect(hostedStory.exports.length).toBeGreaterThan(0);
    expect(calls()).toHaveLength(0); expect(received).toHaveLength(0);
  });
  it('account scope changes during real preset preparation prevent any candidate or create', async () => {
    enableHosted(); cloudAccount = { userId: 7, username: 'fixture-user-seven' };
    await mountProduct('battle'); await chooseHosted('preset');
    const gate = deferred<boolean>(), originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args, options) => command === 'has_provider_secret' ? gate.promise : originalInvoke(command, args, options));
    release = () => gate.resolve(true);
    await click('新建连续战报'); expect(getDesktopAiConfigStore().isPreparingGeneration()).toBe(true);
    cloudAccount = { userId: 8, username: 'fixture-user-eight' };
    await act(async () => getDesktopCloudSessionStore().refresh()); await settle();
    await act(async () => gate.resolve(true)); await settle();
    expect(getDesktopAiConfigStore().isPreparingGeneration()).toBe(false);
    expect(hostedStory.slots.size).toBe(0); expect(hostedStory.streams).toHaveLength(0);
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'set_provider_secret')).toBe(false);
    expect(calls()).toHaveLength(0);
  });

  it('a delayed anonymous bootstrap activates the Hosted actor after the AI target is already ready', async () => {
    enableHosted(); const gate = deferred<null>(), originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args, options) => command === 'cloud_cached_account' ? gate.promise : originalInvoke(command, args, options));
    release = () => gate.resolve(null);
    await mountProduct('battle'); await chooseHosted('system');
    expect(button('新建连续战报').disabled).toBe(true); expect(container.textContent).toContain('正在确认本机账号身份');
    await act(async () => gate.resolve(null)); await settle();
    expect(button('新建连续战报').disabled).toBe(false);
    await click('新建连续战报'); await settledChapter(1);
    expect(requests('create-story-stream')[0]).toMatchObject({ actor: { kind: 'anonymous' } });
  });

  it.each([{ ending: 'leave', phase: 'model' }, { ending: 'account', phase: 'model' }, { ending: 'account', phase: 'role' }] as const)('$ending fences late $phase settlement before accepting roles or saving', async ({ ending, phase }) => {
    enableHosted(); cloudAccount = { userId: 7, username: 'fixture-user-seven' }; const gate = deferred<void>();
    if (phase === 'model') hostedStory.beforeModelSettles = () => gate.promise; else hostedStory.beforeRoleSettles = () => gate.promise;
    release = () => gate.resolve();
    const router = await mountProduct('battle'); await chooseHosted('system'); await click('新建连续战报');
    await vi.waitFor(() => expect(phase === 'model' ? hostedStory.trace.includes('model:c0-completed') : requests('reconcile-story').length === 1).toBe(true));
    expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain('合成故事');
    expect(requests('create-story-stream')[0]).toMatchObject({ actor: { kind: 'account', expectedUserId: 7 } });
    if (ending === 'leave') {
      vi.mocked(window.confirm).mockReturnValue(true);
      await act(async () => router.navigate({ to: '/arena' })); await settle(); expect(window.location.hash).toBe('#/arena');
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('只停止本机订阅'));
    } else {
      cloudAccount = { userId: 8, username: 'fixture-user-eight' };
      await act(async () => getDesktopCloudSessionStore().refresh()); await settle();
      expect(container.textContent).toContain('当前账号与原请求不一致');
    }
    gate.resolve(); await settle(); await vi.waitFor(() => expect(hostedStory.trace).toContain(`${phase}:invoke-settled`)); await settle();
    expect(requests('create-story-stream')).toHaveLength(1); expect(requests('reconcile-story')).toHaveLength(phase === 'model' ? 0 : 1);
    expect(hostedStory.sealed.some(item => item.snapshot.manifest.roleState === 'accepted')).toBe(false);
    expect(hostedStory.commands(STORY_PENDING_IPC.prepareSave)).toHaveLength(0); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(hostedStory.slots.get('battle')!.snapshot.manifest).toMatchObject({ actor: { kind: 'account', expectedUserId: 7 }, modelCompleted: phase === 'role' });
    expect(storyPort.heads()).toHaveLength(0); expect(calls()).toHaveLength(0);
    if (ending === 'leave') expect(container.querySelector('[aria-label="本次章节结果"]')).toBeNull();
  });

  const coldPendingStory = async (product: 'battle' | 'arena' = 'battle') => {
    enableHosted(); hostedStory.roleMode = 'network';
    const router = await mountProduct(product); await chooseHosted('system'); await click('新建连续战报');
    await vi.waitFor(() => expect(container.textContent).toContain('Hosted 正文已封存，尚未保存到故事')); await settle();
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => router.navigate({ to: product === 'battle' ? '/arena' : '/battle' })); await settle();
    await act(async () => router.navigate({ to: `/${product}` })); await settle();
    if (button('恢复草稿')) await click('恢复草稿');
    expect(container.textContent).toContain('此恢复记录属于连续故事');
    await click('读取原件（本地）'); await settle();
  };
  const finishColdPending = async (outcome: 'save' | 'abandon') => {
    if (outcome === 'save') {
      hostedStory.roleMode = 'accepted'; await click('重试角色同步');
      await vi.waitFor(() => expect(storyPort.heads()[0]?.chapterCount).toBe(1));
    } else {
      await click('放弃本机候选…'); await click('确认不导出并放弃本机候选');
    }
    await vi.waitFor(() => expect(hostedStory.slots.size).toBe(0)); await settle();
  };
  const rejectFreshOrdinaryCreate = () => {
    const originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args, options) => {
      if (command === 'arena_hosted_stream' && ['create-json', 'create-stream'].includes(args.request.operation))
        throw { code: 'capability-unavailable', message: 'synthetic ordinary create boundary', dispatchState: 'not-dispatched', intentOwnership: 'current-owned' };
      return originalInvoke(command, args, options);
    });
  };
  for (const product of ['battle', 'arena'] as const) it.each(['save', 'abandon'] as const)(`${product} cold story %s releases the same-page ordinary Hosted preparation and Native dispatch`, async outcome => {
    await coldPendingStory(product); await finishColdPending(outcome);
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS[product])).toBeNull();
    expect(container.textContent).not.toContain('此恢复记录属于连续故事');
    expect(button('生成战报').disabled).toBe(false); rejectFreshOrdinaryCreate();
    await click('生成战报'); await vi.waitFor(() => expect(streamCommands('create-json')).toHaveLength(1)); await settle();
    const next = JSON.parse(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS[product])!);
    expect(next).toMatchObject({ version: 3, product, actor: { kind: 'anonymous' } });
    expect(next).not.toHaveProperty('purpose');
    expect(streamCommands('create-json')[0]![1].request).toMatchObject({ product, requestId: next.requestId });
    expect(requests('create-story-stream')).toHaveLength(1); expect(calls()).toHaveLength(0);
  });

  it.each(['save', 'abandon'] as const)('cold story %s preserves a concurrently replaced public pointer and exposes its original ordinary restore', async outcome => {
    await coldPendingStory();
    const original = DesktopArenaHostedRecoveryPointerSchema.parse({ version: 1, protocolVersion: 'arena-hosted-sse-v1', product: 'battle',
      requestId: 'concurrent-ordinary-request', actor: { kind: 'anonymous' }, bodyHash: 'c'.repeat(64), format: 'markdown', battleMode: 'daily',
      state: 'unknown', updatedAt: '2026-10-10T05:00:00.000Z' });
    const raw = JSON.stringify(original, null, 2), originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args, options) => {
      const result = await originalInvoke(command, args, options);
      if (command === (outcome === 'save' ? STORY_PENDING_IPC.save : STORY_PENDING_IPC.abandon)) localStorage.setItem(ARENA_HOSTED_RECOVERY_KEYS.battle, raw);
      if (command === 'arena_hosted_control' && args.request.requestId === original.requestId)
        return { status: 404, body: { code: 'NOT_FOUND' }, recoveryCredentialState: 'stored' };
      return result;
    });
    await finishColdPending(outcome);
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw);
    expect(container.querySelector('[aria-label="服务器恢复记录"]')?.textContent).toContain(original.requestId);
    expect(button('恢复原服务器战报').disabled).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(false); await click('生成战报');
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('已有服务器恢复记录'));
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(raw); expect(streamCommands('create-json')).toHaveLength(0);
    vi.mocked(window.confirm).mockReturnValue(true); await click('恢复原服务器战报');
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === 'arena_hosted_control' && args.request.operation === 'lookup-request')).toEqual([
      ['arena_hosted_control', { request: { operation: 'lookup-request', product: 'battle', requestId: original.requestId, actor: original.actor, restoreSession: true } }],
    ]);
    expect(streamCommands('create-json')).toHaveLength(0); expect(requests('create-story-stream')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)!)).toMatchObject({ requestId: original.requestId, actor: original.actor });
  });

  it('foreign-retained abandonment keeps the original diagnosis route without silently authorizing replacement', async () => {
    await coldPendingStory(); const originalInvoke = mocks.invoke.getMockImplementation()!;
    const originalRequestId = 'native-retained-ordinary-request';
    mocks.invoke.mockImplementation(async (command, args, options) => {
      if (command === 'arena_hosted_recovery_hint') return { product: 'battle', state: 'available', requestId: originalRequestId, actorKind: 'anonymous' };
      const result = await originalInvoke(command, args, options);
      return command === STORY_PENDING_IPC.abandon ? { ...result, flight: 'foreign-retained', secret: 'foreign-retained' } : result;
    });
    await finishColdPending('abandon');
    expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBeNull();
    expect(container.textContent).toContain('原生槽仍保留另一恢复身份'); expect(container.textContent).toContain('不能保证本产品已可新建');
    expect(streamCommands('create-json')).toHaveLength(0); expect(requests('create-story-stream')).toHaveLength(1);
    expect(button('检查本机恢复身份').disabled).toBe(false); await click('检查本机恢复身份');
    expect(container.querySelector('[aria-label="本机恢复身份诊断"]')?.textContent).toContain(originalRequestId);
    vi.mocked(window.confirm).mockReturnValue(false); await click('生成战报');
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(originalRequestId));
    expect(streamCommands('create-json')).toHaveLength(0); expect(localStorage.getItem(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBeNull();
  });

  it.each(['hosted', 'direct'] as const)('the top-page stop control cancels the actual %s story owner before any role or save', async location => {
    enableHosted(); const gate = deferred<void>();
    if (location === 'hosted') hostedStory.beforeModelSettles = () => gate.promise; else hold = true;
    const releaseDirect = () => release?.();
    await mountProduct('battle'); if (location === 'hosted') await chooseHosted('system');
    await click('新建连续战报');
    if (location === 'hosted') { release = () => gate.resolve(); await vi.waitFor(() => expect(hostedStory.trace).toContain('model:c0-completed')); }
    else await vi.waitFor(() => expect(received).toHaveLength(1));
    const stop = button('生成战报').nextElementSibling as HTMLButtonElement;
    expect(stop.tagName).toBe('BUTTON'); expect(stop.disabled).toBe(false);
    expect(stop.textContent).toBe(location === 'hosted' ? '请求服务器停止' : '取消生成');
    await act(async () => stop.click()); await settle();
    if (location === 'hosted') gate.resolve(); else releaseDirect();
    await settle();
    expect(storyPort.heads()).toHaveLength(0); expect(hostedStory.commands(STORY_PENDING_IPC.save)).toHaveLength(0);
    expect(requests('reconcile-story')).toHaveLength(0); expect(storyPort.begin).not.toHaveBeenCalled();
    expect(hostedStory.controls.filter(request => request.operation === 'stop')).toHaveLength(location === 'hosted' ? 1 : 0);
    expect(location === 'hosted' ? requests('create-story-stream') : received).toHaveLength(1);
  });

});

it.each(['battle', 'arena'] as const)('keeps %s branch entry closed in the actual routed story surface', async product => {
  localStorage.setItem(product === 'battle' ? ARENA_DRAFT_KEY : ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: draft('daily', 'stream') }));
  window.location.hash = `#/${product}`;
  await mount();
  await click('恢复草稿'); await click('新建连续战报');
  await vi.waitFor(() => expect(container.querySelector('[data-story-read-status="loaded"]')).toBeTruthy());
  expect([...container.querySelectorAll('button')].filter(node => /分支|branch/iu.test(node.textContent ?? ''))).toHaveLength(0);
  expect(mocks.invoke.mock.calls.filter(([command]) => /branch/iu.test(command))).toHaveLength(0);
});
