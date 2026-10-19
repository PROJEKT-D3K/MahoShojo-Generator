// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { MAX_DATA_CARD_BYTES } from '@mahoshojo/domain/data-card-size';
import { buildTavernCloudSavePayload, convertTavernToGeneralCard, readTavernLocalDocument } from '@mahoshojo/domain/tavern-card';
import { DesktopTavern } from '../src/app/tavern-page';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import type { TavernAiTemplate, TavernGenerationInput } from '../src/features/tavern/generation';
import { tavernModelResult } from './tavern-character-fixtures';
import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), execute: vi.fn(), export: vi.fn(), save: vi.fn(),
  account: { userId: 7, username: 'cloud-owner' }, epoch: 0,
  shouldBlock: (() => false) as () => boolean,
  nativeClose: null as ((event: { preventDefault: () => void }) => void) | null,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (callback: typeof mocks.nativeClose) => {
    mocks.nativeClose = callback;
    return () => { if (mocks.nativeClose === callback) mocks.nativeClose = null; };
  },
}) }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({}),
  useBlocker: ({ shouldBlockFn }: { shouldBlockFn: () => boolean }) => { mocks.shouldBlock = shouldBlockFn; },
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../src/features/account/use-desktop-cloud-session', () => {
  const authFlow = { kind: 'idle' };
  const getSnapshot = () => ({ bootstrapped: true, account: mocks.account, verification: 'verified', authFlow });
  return { useDesktopCloudSession: () => ({ state: getSnapshot(), store: { getSnapshot, getCredentialEpoch: () => mocks.epoch } }) };
});
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openFixed: vi.fn() }) }));
vi.mock('../src/features/tavern/generation', async original => ({ ...await original<object>(), executeTavernGeneration: mocks.execute }));
vi.mock('../src/platform/provider-profile-bridge', () => ({
  listProviderProfileIds: async () => ['local'],
  getProviderProfile: async () => ({ id: 'local', name: '本地模型', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model' }),
}));
vi.mock('../src/platform/local-card-bridge', () => ({ IpcLocalCardRepository: class {} }));
vi.mock('../src/features/tavern/host', () => ({ saveDesktopTavernCard: mocks.save, exportTavernFile: mocks.export, getDesktopTavernBase: vi.fn() }));
vi.mock('../src/features/cloud-save/owned-cards-modal', () => ({
  DesktopOwnedCardsModal: ({ isOpen, onClose, selectedType, onReplaceCard }: {
    isOpen: boolean; onClose: () => void; selectedType: string;
    onReplaceCard?: (card: { id: string; type: string; name: string }) => Promise<void>;
  }) => isOpen ? <div data-testid="own-cloud-library" data-type={selectedType}>
    <button onClick={onClose}>关闭卡库</button>
    {onReplaceCard && <button onClick={() => void onReplaceCard({ id: 'target', type: selectedType, name: '列表中的旧名称' }).catch(() => {})}>选择目标</button>}
  </div> : null,
}));
vi.mock('@mahoshojo/ui-web/shell', () => ({ ProductFooter: () => null }));
vi.mock('@mahoshojo/ui-web/character-card', () => ({
  resolveMagicalGirlGradient: () => 'pink',
  MagicalGirlCard: () => <div data-result="magical-girl" />,
  CanshouCard: () => <div data-result="canshou" />,
  GeneralCharacterCard: () => <div data-result="general" />,
}));
vi.mock('@mahoshojo/ui-web/scenario', () => ({ GeneralScenarioCard: () => <div data-result="scenario" /> }));

let root: Root;
let host: HTMLDivElement;
const raw = { name: 'Alice', description: '{{user}} 对 {{char}} 说话', unknown: { keep: true } };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = () => act(async () => { await flush(); });
const findButton = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const button = (label: string) => {
  const found = findButton(label);
  expect(found, `button: ${label}`).toBeDefined();
  return found!;
};
const click = (label: string) => act(async () => { button(label).click(); await flush(); });
const mount = async () => { await act(async () => root.render(<StrictMode><DesktopTavern /></StrictMode>)); await settle(); };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const calls = (route: string) => mocks.invoke.mock.calls.filter(([command, args]) => command === 'cloud_card_library_request' && args.request.routeId === route);
const creates = () => calls('data-cards.create');
const replaces = () => calls('data-cards.replace');
const cloudCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_card_library_request');
const createdAck = () => ({ status: 201, body: { success: true, id: 'copy', ownerUserId: 7, accountFenceVersion: 1 } });
const cloudResponse = (_command: string, args?: { request?: { routeId: string } }) => {
  if (args?.request?.routeId === 'user-capacity.query') return { status: 200, body: { success: true, capacity: 10, usedSlots: 0 } };
  if (args?.request?.routeId === 'data-cards.create') return createdAck();
  throw new Error(`Unexpected Native request: ${_command}/${args?.request?.routeId}`);
};
const exported = (index: number) => JSON.parse(new TextDecoder().decode(mocks.export.mock.calls[index]![0].bytes));
async function upload(value: unknown = raw) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'card.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await flush(); });
}
async function template(value: TavernAiTemplate) {
  const select = host.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await flush(); });
}
async function chooseAi() {
  const modes = host.querySelectorAll<HTMLInputElement>('input[name="tavern-convert-mode"]');
  if (!modes[1]!.checked) await act(async () => { modes[1]!.click(); await flush(); });
}
function expectSourceLocked(locked: boolean) {
  expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(locked);
  expect(host.querySelector<HTMLSelectElement>('select')!.disabled).toBe(locked);
  expect(host.querySelector<HTMLInputElement>('[aria-label="替换占位符"]')!.disabled).toBe(locked);
  for (const label of ['标准', '轻量', '极简']) expect(button(label).disabled).toBe(locked);
  for (const input of host.querySelectorAll<HTMLInputElement>('input[name="tavern-convert-mode"]')) expect(input.disabled).toBe(locked);
}
async function expectHardLeaveBlock() {
  vi.mocked(window.confirm).mockClear().mockReturnValue(true);
  const preventDefault = vi.fn();
  await act(async () => { expect(mocks.shouldBlock()).toBe(true); mocks.nativeClose!({ preventDefault }); });
  expect(preventDefault).toHaveBeenCalledOnce();
  const beforeUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);
  expect(window.confirm).not.toHaveBeenCalled();
}
const complete = (input: TavernGenerationInput) => ({
  status: 'completed', mode: 'direct-local', cardKind: input.template, rawText: '模型输出',
  card: { ...tavernModelResult(input.template),
    ...(input.template === 'general' ? { templateId: '通用角色' } : input.template === 'general-scenario' ? { templateId: '通用情景' } : {}),
    _tavern: { raw: input.raw },
  },
});

async function nativeStream() {
  const actual = await vi.importActual<typeof import('../src/features/tavern/generation')>('../src/features/tavern/generation');
  mocks.execute.mockImplementation((options, input, intent, signal, onPartialText) => actual.executeTavernGeneration({ ...options, createChannel: () => ({}) }, input, intent, signal, onPartialText));
  let request!: AiExecutionRequest;
  let channel!: { onmessage: (event: AiStreamEvent) => void };
  let finish!: () => void;
  let sequence = 0;
  const text = '# 星光\n名字：星光\n\n流式情景正文';
  mocks.invoke.mockImplementation(withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
    if (command !== 'stream_target_ai') return cloudResponse(command, args);
    request = args!.request as AiExecutionRequest;
    channel = args!.onEvent as typeof channel;
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    channel.onmessage({ ...identity, type: 'started', sequence: sequence++ });
    channel.onmessage({ ...identity, type: 'text-delta', sequence: sequence++, delta: text });
    await new Promise<void>(resolve => { finish = resolve; });
  }));
  return { text, finish: async (finishReason: 'stop' | 'length') => {
    await act(async () => {
      const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
      channel.onmessage({ ...identity, type: 'result', sequence: sequence++, result: { ...identity, status: 'completed', finishReason, output: { text } } });
      finish(); await flush();
    });
  } };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.account = { userId: 7, username: 'cloud-owner' }; mocks.epoch = 0; mocks.nativeClose = null;
  mocks.invoke.mockReset().mockImplementation(async (command, args) => cloudResponse(command, args));
  mocks.execute.mockReset().mockImplementation(async (_options, input) => complete(input));
  mocks.export.mockReset().mockResolvedValue(undefined); mocks.save.mockReset().mockResolvedValue('saved');
  localStorage.clear();
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] }));
  resetDesktopAiConfigStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ code: 'zh-CN', name: '简体中文' }] })));
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Desktop Tavern actual cloud-copy journey', () => {
  it.each(['标准', '轻量', '极简'])('sends the explicit %s rule copy privately, preserving the local projection and original', async preset => {
    const source = { ...raw, description: '规则正文'.repeat(6_000), mes_example: '对话样例'.repeat(4_000) };
    await mount(); await upload(source); await click(preset);
    expect(host.textContent).toContain('预估写入大小');
    await click('下载通用卡 JSON'); const local = exported(0);
    expect(local._tavern.raw).toEqual(source);
    expect(cloudCalls()).toHaveLength(0);
    await click('保存到云端');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.checked).toBe(false);
    expect(creates()).toHaveLength(0); expectSourceLocked(true);
    await click('保存');
    expect(creates()).toHaveLength(1);
    const request = creates()[0]![1].request;
    expect(request).toMatchObject({ routeId: 'data-cards.create', expectedUserId: 7, body: { type: 'character', name: 'Alice', isPublic: 0 } });
    expect(request.body.data._tavern).not.toHaveProperty('raw');
    if (preset === '标准') expect(request.body.data.content).toBe(local.content);
    else {
      const limit = preset === '轻量' ? 20_000 : 12_000;
      expect(request.body.data.content).toBe(`${local.content.trim().slice(0, limit)}\n...[已截断]`);
    }
    expect(host.textContent).toContain('私有云端副本已保存'); expectSourceLocked(false);
    await click('下载通用卡 JSON'); expect(exported(1)).toEqual(local);
    await click('导出原件 JSON'); expect(exported(2)).toEqual(source);
  });

  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('saves the completed %s actual projection with its actual cloud type', async kind => {
    const streamed = kind === 'general-scenario' ? await nativeStream() : null;
    await mount(); await upload();
    await template(streamed ? 'scenario' : kind); await chooseAi();
    if (streamed) await click('流式');
    expect(findButton('保存到云端')).toBeUndefined(); expect(cloudCalls()).toHaveLength(0);
    await click('开始转换');
    if (streamed) {
      expect(findButton('保存到云端')).toBeUndefined();
      expect(host.querySelector('[aria-label="流式正文预览"]')!.textContent).toContain('流式情景正文');
      await streamed.finish('stop');
      expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('scenario');
    }
    await click('保存到云端'); expect(creates()).toHaveLength(0); await click('保存');
    expect(creates()).toHaveLength(1);
    const body = creates()[0]![1].request.body;
    expect(body.type).toBe(kind === 'scenario' || kind === 'general-scenario' ? 'scenario' : 'character');
    expect(body.data._tavern).not.toHaveProperty('raw');
    const download = kind === 'scenario' ? '下载情景卡 JSON' : kind === 'magical-girl' ? '下载魔法少女卡 JSON' : kind === 'canshou' ? '下载残兽卡 JSON' : '下载通用卡 JSON';
    await click(download);
    const local = exported(0);
    const { raw: retainedRaw, ...metadata } = local._tavern;
    expect(retainedRaw).toEqual(raw);
    expect(body.data).toEqual({ ...local, _tavern: metadata });
    if (streamed) {
      expect(body.data).toMatchObject({ templateId: '通用情景', content: streamed.text });
      expect(body.data).not.toHaveProperty('elements');
    }
    await click('导出原件 JSON'); expect(exported(1)).toEqual(raw);
  });

  it('never offers cloud actions for pending or truncated stream text, while retaining exportable output', async () => {
    const streamed = await nativeStream();
    await mount(); await upload(); await chooseAi(); await click('流式'); await click('开始转换');
    expect(findButton('保存到云端')).toBeUndefined(); expect(findButton('替换已有')).toBeUndefined();
    await streamed.finish('length');
    expect(host.textContent).toContain('不是完成卡');
    expect(findButton('保存到云端')).toBeUndefined(); expect(findButton('替换已有')).toBeUndefined();
    expect(cloudCalls()).toHaveLength(0);
    await click('导出未完成正文（文本）');
    expect(new TextDecoder().decode(mocks.export.mock.calls[0]![0].bytes)).toBe(streamed.text);
    await click('导出原件 JSON'); expect(exported(1)).toEqual(raw);
  });

  it('shows an over-1-MiB estimate without dispatching or silently choosing a lossy preset', async () => {
    const source = { ...raw, description: 'x'.repeat(1_100_000) };
    await mount(); await upload(source);
    expect(host.textContent).toContain('预估写入大小'); expect(host.textContent).toContain('超限');
    expect(button('标准').getAttribute('aria-pressed')).toBe('true');
    expect(findButton('保存到云端')).toBeUndefined(); expect(findButton('替换已有')).toBeUndefined();
    expect(cloudCalls()).toHaveLength(0);
    await click('导出原件 JSON'); expect(exported(0)).toEqual(source);
    await click('轻量');
    expect(button('轻量').getAttribute('aria-pressed')).toBe('true');
    expect(button('保存到云端').disabled).toBe(false); expect(cloudCalls()).toHaveLength(0);
    await click('下载通用卡 JSON'); expect(exported(1).content).toContain(source.description);
  });

  it('replaces only the freshly read exact target/type/version after explicit confirmation', async () => {
    await mount(); await upload(); await template('general-scenario');
    await click('下载通用卡 JSON');
    await click('替换已有');
    expect(document.querySelector('[data-testid="own-cloud-library"]')!.getAttribute('data-type')).toBe('scenario');
    const target = { id: 'target', type: 'scenario', name: '服务器当前目标', description: '保留描述', isPublic: 1, reviewStatus: 'approved', hasPendingUpdate: true, version: 'b'.repeat(64) };
    mocks.invoke.mockResolvedValueOnce({ status: 200, body: { success: true, ownerUserId: 7, accountFenceVersion: 1, target } });
    await click('选择目标');
    expect(calls('data-cards.replace-target.query')[0]![1].request).toEqual({ routeId: 'data-cards.replace-target.query', expectedUserId: 7, query: { id: 'target' } });
    expect(document.body.textContent).toContain('服务器当前目标'); expect(document.body.textContent).toContain('已有待审核版本');
    expect(replaces()).toHaveLength(0); expectSourceLocked(true);
    mocks.invoke.mockResolvedValueOnce({ status: 200, body: { success: true, id: 'target', ownerUserId: 7, accountFenceVersion: 1, replacementVersion: 1, pendingReview: true } });
    await act(async () => { button('确认替换').click(); button('确认替换').click(); await flush(); });
    const local = exported(0); const { raw: retainedRaw, ...metadata } = local._tavern;
    expect(retainedRaw).toEqual(raw); expect(replaces()).toHaveLength(1);
    expect(replaces()[0]![1].request).toEqual({ routeId: 'data-cards.replace', expectedUserId: 7, body: { id: 'target', type: 'scenario', expectedVersion: target.version, data: { ...local, _tavern: metadata } } });
    expect(host.textContent).toContain('更新已提交审核'); expectSourceLocked(false);
  });

  it('retains the source after closing an unknown create, then releases it only after check, risk acknowledgement and form cancellation', async () => {
    await mount(); await upload(); await click('保存到云端');
    mocks.invoke.mockResolvedValueOnce({ status: 500, body: { error: 'response lost after insert' } }); await click('保存');
    expect(document.body.textContent).toContain('服务器可能已创建');
    expect(button('我已检查，仍要再次新建（可能重复）').disabled).toBe(true);
    await click('取消'); expectSourceLocked(true);
    await click('极简'); expect(button('标准').getAttribute('aria-pressed')).toBe('true');
    await upload({ ...raw, name: 'replacement source' });
    await click('导出原件 JSON'); expect(exported(0)).toEqual(raw);
    expect(mocks.shouldBlock()).toBe(false);
    await click('保存到云端'); expect(button('保存').disabled).toBe(true);
    await click('检查“我的云端卡”');
    expect(document.querySelector('[data-testid="own-cloud-library"]')!.getAttribute('data-type')).toBe('character');
    expect(findButton('选择目标')).toBeUndefined();
    await click('关闭卡库'); vi.mocked(window.confirm).mockReturnValue(true);
    await click('我已检查，仍要再次新建（可能重复）');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('重复副本'));
    expect(creates()).toHaveLength(1); expectSourceLocked(true); expect(button('保存').disabled).toBe(false);
    await click('取消'); expectSourceLocked(false); expect(creates()).toHaveLength(1);
    await click('极简'); expect(button('极简').getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves unknown ownership across a same-account username refresh crossing the author-size limit', async () => {
    const project = (source: unknown) => convertTavernToGeneralCard(readTavernLocalDocument(new TextEncoder().encode(JSON.stringify(source)), 'json').candidates[0]!);
    const author = { id: mocks.account.userId, username: mocks.account.username };
    const baseline = buildTavernCloudSavePayload(project({ ...raw, description: 'x' }), author, 'standard');
    if ('error' in baseline) throw new Error(baseline.error);
    const source = { ...raw, description: 'x'.repeat(MAX_DATA_CARD_BYTES - baseline.estimatedBytes + 1) };
    const projection = project(source);
    expect(buildTavernCloudSavePayload(projection, author, 'standard')).toMatchObject({ estimatedBytes: MAX_DATA_CARD_BYTES, overLimit: false });
    const refreshedUsername = `${author.username}-refreshed`;
    expect(buildTavernCloudSavePayload(projection, { ...author, username: refreshedUsername }, 'standard')).toMatchObject({ overLimit: true });

    await mount(); await upload(source); await click('保存到云端');
    mocks.invoke.mockResolvedValueOnce({ status: 500, body: { error: 'response lost after insert' } });
    await click('保存'); expect(document.body.textContent).toContain('服务器可能已创建'); expectSourceLocked(true);
    mocks.account = { ...mocks.account, username: refreshedUsername };
    await mount();
    expect(document.body.textContent).toContain('服务器可能已创建');
    expectSourceLocked(true); expect(button('标准').getAttribute('aria-pressed')).toBe('true');
    expect(button('保存').disabled).toBe(true); expect(creates()).toHaveLength(1);
    await click('检查“我的云端卡”'); expect(findButton('选择目标')).toBeUndefined();
    await click('关闭卡库'); vi.mocked(window.confirm).mockReturnValue(true);
    await click('我已检查，仍要再次新建（可能重复）');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('重复副本'));
    expectSourceLocked(true); expect(creates()).toHaveLength(1);
    await click('取消');
    expectSourceLocked(false); expect(document.body.textContent).not.toContain('服务器可能已创建');
    expect(host.textContent).toContain('超限'); expect(button('标准').getAttribute('aria-pressed')).toBe('true');
    expect(findButton('保存到云端')).toBeUndefined(); expect(findButton('替换已有')).toBeUndefined();
    expect(creates()).toHaveLength(1);
    await click('导出原件 JSON'); expect(exported(0)).toEqual(source);
  });

  it.each(['account', 'epoch'] as const)('keeps real Native debt hard-blocking source, route, refresh and close across %s retirement, and ignores its late ACK', async change => {
    await mount(); await upload(); await click('保存到云端');
    const pending = deferred(); mocks.invoke.mockReturnValueOnce(pending.promise);
    await act(async () => { button('保存').click(); button('保存').click(); await flush(); });
    expect(creates()).toHaveLength(1); expectSourceLocked(true); await expectHardLeaveBlock();
    if (change === 'account') mocks.account = { userId: 8, username: 'next-owner' }; else mocks.epoch++;
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectSourceLocked(true); await expectHardLeaveBlock();
    await upload({ ...raw, name: 'blocked replacement' });
    expect(button('保存到云端').disabled).toBe(true);
    await act(async () => { pending.resolve(createdAck()); await flush(); });
    expectSourceLocked(false); expect(mocks.shouldBlock()).toBe(false);
    expect(host.textContent).not.toContain('私有云端副本已保存'); expect(creates()).toHaveLength(1);
    await click('导出原件 JSON'); expect(exported(0)).toEqual(raw);
    expect(button('保存到云端').disabled).toBe(false);
  });
});
