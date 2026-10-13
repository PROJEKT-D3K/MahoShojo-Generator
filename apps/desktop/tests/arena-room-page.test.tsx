// @vitest-environment jsdom
/** Real Desktop routes, shared views, Room owner and bridge; only Native/browser ports are fixtures. */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ipcFixture from '@mahoshojo/contracts/fixtures/desktop-room-ipc.json';
import serviceFixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import {
  DESKTOP_ROOM_IPC_COMMANDS, DesktopRoomAttachRequestSchema, DesktopRoomBatchSchema,
  DesktopRoomRequestSchema, DesktopRoomSubscribeRequestSchema,
  type DesktopRoomAttachResponse, type DesktopRoomBatch, type DesktopRoomHttpAction,
  type DesktopRoomSubscribeRequest,
} from '@mahoshojo/contracts/desktop-room-ipc';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { createDesktopRouter } from '../src/app/router';
import { ADVANCED_ARENA_DRAFT_KEY, ARENA_DRAFT_KEY, createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { getDesktopAiConfigStore, resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { getDesktopCloudSessionStore, resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true, Channel: class { onmessage?: (value: unknown) => void; } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.listen }) }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
type Signal<T> = ReturnType<typeof deferred<T>>;
type NativeChannel = { onmessage?: (value: unknown) => void };
type Operation = { action: DesktopRoomHttpAction; requestId: string; handle: string; subscriptionId: string };
type Delivery = {
  batch: DesktopRoomBatch; channel: NativeChannel; pullStarted: Signal<void>; ackStarted: Signal<void>;
  pullGate: Signal<void>; ackGate: Signal<void>; pullReturned: Signal<void>;
};

/** A queued Native endpoint: notifications never contain bodies, and ACK gates real subscription dispatch. */
class RoomNativeFixture {
  readonly actions: Operation[] = [];
  readonly subscriptions: DesktopRoomSubscribeRequest[] = [];
  readonly acknowledgements: { subscriptionId: string; batchId: string; sequence: number }[] = [];
  readonly order: string[] = [];
  pendingIntent: DesktopRoomAttachResponse['pendingIntent'] = null;
  channel: NativeChannel = {};
  handle = ipcFixture.attach.handle;
  subscriptionId = ipcFixture.attach.subscriptionId;
  private attachCount = 0;
  private sequence = 0;
  private deliveries = new Map<string, Delivery>();
  private expectedAction: { kind: DesktopRoomHttpAction['kind']; signal: Signal<Operation> } | null = null;
  private expectedSubscription: Signal<DesktopRoomSubscribeRequest> | null = null;

  nextAction(kind: DesktopRoomHttpAction['kind']) {
    expect(this.expectedAction).toBeNull();
    const signal = deferred<Operation>(); this.expectedAction = { kind, signal }; return signal.promise;
  }
  nextSubscription() {
    expect(this.expectedSubscription).toBeNull();
    const signal = deferred<DesktopRoomSubscribeRequest>(); this.expectedSubscription = signal; return signal.promise;
  }
  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (command === DESKTOP_ROOM_IPC_COMMANDS.attach) {
      const request = DesktopRoomAttachRequestSchema.parse(args.request);
      expect(request.expectedUserId).toBe(serviceFixture.expectedUserId);
      this.channel = args.onEvent as NativeChannel;
      this.attachCount += 1; this.handle = `page-handle-${this.attachCount}`;
      this.subscriptionId = `page-lobby-${this.attachCount}`; this.sequence = 0;
      this.order.push('attach');
      return { handle: this.handle, subscriptionId: this.subscriptionId, pendingIntent: this.pendingIntent };
    }
    if (command === DESKTOP_ROOM_IPC_COMMANDS.detach) { this.order.push('detach'); return { detached: true }; }
    if (command === DESKTOP_ROOM_IPC_COMMANDS.subscribe) {
      const request = DesktopRoomSubscribeRequestSchema.parse(args.request);
      this.subscriptions.push(request); this.order.push('subscribe');
      this.subscriptionId = `page-socket-${this.attachCount}-${this.subscriptions.length}`; this.sequence = 0;
      this.expectedSubscription?.resolve(request); this.expectedSubscription = null;
      return { handle: this.handle, subscriptionId: this.subscriptionId };
    }
    if (command !== DESKTOP_ROOM_IPC_COMMANDS.request) throw new Error(`Unexpected Room command: ${command}`);
    const envelope = DesktopRoomRequestSchema.parse(args.request), action = envelope.request;
    if (action.kind === 'pull') {
      const delivery = this.deliveries.get(action.subscriptionId);
      expect(delivery, 'only notified bounded batches can be pulled').toBeDefined();
      if (!delivery) throw new Error('Missing queued batch');
      this.order.push(`pull:${delivery.batch.batchId}`); delivery.pullStarted.resolve();
      await delivery.pullGate.promise; delivery.pullReturned.resolve();
      return { kind: 'batch', batch: delivery.batch };
    }
    if (action.kind === 'ack') {
      const delivery = this.deliveries.get(action.subscriptionId);
      expect(delivery?.batch).toMatchObject({ handle: envelope.handle, subscriptionId: action.subscriptionId, batchId: action.batchId, sequence: action.sequence });
      if (!delivery) throw new Error('ACK without a queued batch');
      this.acknowledgements.push(action); this.order.push(`ack:${action.batchId}`); delivery.ackStarted.resolve();
      await delivery.ackGate.promise; this.deliveries.delete(action.subscriptionId);
      this.order.push(`acknowledged:${action.batchId}`);
      return { kind: 'acknowledged', handle: envelope.handle, subscriptionId: action.subscriptionId, batchId: action.batchId, sequence: action.sequence, accepted: true };
    }
    const operation = { action, handle: this.handle, subscriptionId: this.subscriptionId, requestId: `page-request-${this.actions.length}` };
    this.actions.push(operation); this.order.push(`request:${action.kind}`);
    if (this.expectedAction) {
      expect(action.kind).toBe(this.expectedAction.kind);
      this.expectedAction.signal.resolve(operation); this.expectedAction = null;
    }
    return { kind: 'accepted', handle: operation.handle, subscriptionId: operation.subscriptionId, requestId: operation.requestId };
  }
  queue(event: unknown, options: { holdPull?: boolean; holdAck?: boolean } = {}): Delivery {
    expect(this.deliveries.has(this.subscriptionId), 'one bounded batch at a time').toBe(false);
    const sequence = this.sequence++;
    const batch = DesktopRoomBatchSchema.parse({ handle: this.handle, subscriptionId: this.subscriptionId, batchId: `page-batch-${this.attachCount}-${this.subscriptions.length}-${sequence}`, sequence, event });
    const delivery = { batch, channel: this.channel, pullStarted: deferred<void>(), ackStarted: deferred<void>(), pullGate: deferred<void>(), ackGate: deferred<void>(), pullReturned: deferred<void>() };
    if (!options.holdPull) delivery.pullGate.resolve();
    if (!options.holdAck) delivery.ackGate.resolve();
    this.deliveries.set(this.subscriptionId, delivery); return delivery;
  }
  notify(delivery: Delivery) {
    const { handle, subscriptionId, sequence } = delivery.batch;
    delivery.channel.onmessage?.({ type: 'available', handle, subscriptionId, sequence });
  }
  async deliver(event: unknown, options: { holdAck?: boolean } = {}) {
    const delivery = this.queue(event, options);
    await act(async () => { this.notify(delivery); await delivery.ackStarted.promise; });
    return delivery;
  }
}

let root: Root, container: HTMLDivElement, port: RoomNativeFixture;
let account: { userId: number; username: string } | null;
const reportText = '普通单次结果：甲与乙共同守护车站。';
const profile = { version: 1, id: 'room-page-direct', name: '房间测试普通连接', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:18080/v1', modelId: 'fixture-default-model', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const publicCard = { id: 'missing-version-card', name: '缺版本在线角色', type: 'character', is_public: 1, description: '缺少实际观察版本的公开卡', data: JSON.stringify({ templateId: '通用角色', name: '缺版本在线角色', content: '不得随房间创建上传的私有正文', _updatedAt: 'body-metadata-is-not-a-version' }) };
const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string, scope: ParentNode = document) => buttons(scope).find(item => item.textContent?.trim() === text);
const requiredButton = (text: string, scope?: ParentNode) => { const found = button(text, scope); expect(found, text).toBeTruthy(); return found!; };
const click = async (text: string, scope?: ParentNode) => { await act(async () => requiredButton(text, scope).click()); };
const room = () => { const node = container.querySelector<HTMLElement>('[aria-label="桌面多人房间"]'); expect(node).not.toBeNull(); return node!; };
const change = async (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector); expect(input, selector).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const ordinarySnapshot = () => ({
  ai: localStorage.getItem(DESKTOP_AI_CONFIG_STORAGE_KEY),
  advanced: localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY), battle: localStorage.getItem(ARENA_DRAFT_KEY),
  selection: structuredClone(getDesktopAiConfigStore().getSnapshot().selection),
  models: structuredClone(getDesktopAiConfigStore().getSnapshot().modelsByProfileId),
});
const assertNoExecution = () => {
  expect(mocks.invoke.mock.calls.filter(([command]) => ['stream_direct_ai', 'stream_target_ai', 'stream_hosted_ai', 'hosted_ai_request', 'arena_hosted_stream'].includes(command))).toEqual([]);
};
const assertConstrained = () => {
  expect(room().textContent).toContain('有效执行位置：服务器');
  // Ordinary controls stay mounted so unsaved local editor state survives Room mode.
  const generate = requiredButton('生成战报');
  expect(generate.closest('[hidden]')).not.toBeNull();
  expect(generate.matches(':disabled')).toBe(true);
  const result = container.querySelector('[aria-label="战报结果"]');
  if (result) expect(result.closest('[hidden]')).not.toBeNull();
  const diagnostics = container.querySelector('[aria-label="严格排位配置检查"]');
  expect(diagnostics).not.toBeNull();
  expect(diagnostics!.closest('[hidden]')).not.toBeNull();
  for (const control of container.querySelectorAll('textarea, [aria-label="API Key"], [role="combobox"]')) {
    expect(control.closest('[hidden]')).not.toBeNull();
    expect(control.matches(':disabled')).toBe(true);
  }
  for (const label of ['生成战报', '发布配置', '提交提案', '开始协作生成', '发起生成', '启用严格排位']) expect(button(label, room())).toBeUndefined();
  assertNoExecution();
};
const assertNoOnline = () => {
  expect(room().querySelector('[data-member-presence="online"]')).toBeNull();
  expect([...room().querySelectorAll('[role="status"]')].some(node => node.textContent === '已在线')).toBe(false);
};
const savedDraft = (patch: Partial<ArenaDraft> = {}): ArenaDraft => ({
  ...createInitialArenaDraft(), battleMode: 'daily', generationMode: 'stream',
  combatants: ['甲', '乙'].map(name => ({ type: 'general-character', data: { templateId: '通用角色', name, content: `${name}完整本机设定` }, filename: `${name}.json`, isPreset: false, isValid: false })),
  ...patch,
});
const seedOrdinary = (draft = savedDraft()) => {
  localStorage.setItem(ADVANCED_ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft, output: { phase: 'completed', rawText: reportText, markdown: reportText, reasoning: '保留普通推理', reportFormat: 'markdown', generationMode: 'stream', executionMode: 'direct-local' } }));
  localStorage.setItem(ARENA_DRAFT_KEY, JSON.stringify({ version: 1, draft: savedDraft({ settings: { ...createInitialArenaDraft().settings, userGuidance: '简洁版独立草稿' } }) }));
};
const mount = async (path: '/arena' | '/battle' = '/arena') => {
  window.location.hash = `#${path}`;
  const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  await act(async () => {
    await getDesktopCloudSessionStore().bootstrap();
    await getDesktopAiConfigStore().refreshProfiles();
  });
  expect(container.textContent).toContain('生成战报');
  return router;
};
const open = async () => {
  await click('打开多人大厅');
  expect(room().textContent).toContain('大厅已就绪');
  expect(port.order.filter(item => item === 'attach')).toHaveLength(1);
};
const startAction = async (label: string, kind: DesktopRoomHttpAction['kind']) => {
  const next = port.nextAction(kind); let operation!: Operation;
  await act(async () => { requiredButton(label, room()).click(); operation = await next; });
  return operation;
};
const responseEvent = (operation: Operation, result: unknown) => ({
  kind: 'http-result', requestId: operation.requestId,
  operation: operation.action.kind === 'resume-create' ? 'create' : operation.action.kind,
  response: { desktopRoom: serviceFixture.operations.create.success.desktopRoom, result },
});
const sessionFor = (role: 'host' | 'member'): ArenaRoomSessionResponse => {
  const session = structuredClone(serviceFixture.operations.create.success.result) as ArenaRoomSessionResponse;
  session.self = session.snapshot.members.find(member => member.role === role)!;
  expect(session.snapshot.members.find(member => member.userId === session.self.userId)).toEqual(session.self);
  return session;
};
const confirmMembership = async (operation: Operation, role: 'host' | 'member') => {
  const session = sessionFor(role), subscribed = port.nextSubscription();
  await port.deliver(responseEvent(operation, session));
  await act(async () => { expect(await subscribed).toMatchObject({ roomId: session.roomId, expectedRoomEpoch: session.roomEpoch }); });
  return session;
};
const publishOnline = async (session: ArenaRoomSessionResponse) => {
  await port.deliver({ kind: 'status', state: 'online' }); assertNoOnline();
  const snapshot = structuredClone(ipcFixture.pulls[12]!.batch.event);
  await port.deliver(snapshot); assertNoOnline();
  const presence = structuredClone(ipcFixture.pulls[13]!.batch.event) as { kind: 'socket'; message: { onlineUserIds: string[] } };
  presence.message.onlineUserIds = [session.self.userId];
  await port.deliver(presence);
  expect(room().querySelectorAll('[data-member-presence="online"]')).toHaveLength(1);
  expect(room().querySelectorAll('[data-member-presence="offline"]')).toHaveLength(1);
  expect(room().textContent).toContain('当前 2 位成员，1 人在线，1 人离线。');
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(window, '__MAHOSHOJO_ROOM_DOCUMENT_V1__', { configurable: true, writable: true, value: ipcFixture.attachRequest.documentNonce });
  port = new RoomNativeFixture(); account = { userId: serviceFixture.expectedUserId, username: '普通账号' };
  localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 5, selection: { executionPreference: 'client', clientTarget: { kind: 'custom', profileId: profile.id }, serverTarget: { kind: 'system' }, systemModelId: 'default' }, hiddenPresetIds: [], modelsByProfileId: { [profile.id]: { selectedModelId: 'ordinary-selected-model', customModelIds: ['ordinary-selected-model'] } }, presetsByProviderId: {} }));
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (Object.values(DESKTOP_ROOM_IPC_COMMANDS).includes(command as never)) return port.invoke(command, args);
    if (command === 'cloud_cached_account') return account ? { account } : null;
    if (command === 'cloud_auth_status') return account ? { state: 'active', account } : { state: 'signed-out' };
    if (command === 'cloud_sign_out') { account = null; return { revoked: true }; }
    if (command === 'list_provider_profile_ids') return [profile.id];
    if (command === 'get_provider_profile') return JSON.stringify(profile);
    if (command === 'has_provider_secret') return true;
    if (command === 'list_local_cards' || command === 'list_web_packages') return { documents: [] };
    if (command === 'list_arena_story_sessions') return { rows: [], nextCursor: null };
    if (command === 'describe_arena_story_pending') return null;
    if (command === 'cloud_card_library_request') {
      const request = args.request as { routeId: string; query?: Record<string, string> };
      if (request.routeId === 'public-data-cards.query') return { status: 200, body: request.query?.id ? { success: true, card: publicCard } : { success: true, cards: [publicCard], total: 1 } };
      return { status: 200, body: { success: true, cards: [], tags: [], total: 0 } };
    }
    // Optional top-bar profile/message reads are outside this route slice.
    throw new Error(`Unconfigured Native command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/languages.json') return new Response(JSON.stringify([{ code: 'zh-CN', name: '简体中文' }]));
    if (url.startsWith('/presets/') || url.startsWith('/scenario-presets/') || url.startsWith('/questionnaires/')) return new Response(readFileSync(resolve(process.cwd(), '../../content', url.slice(1)), 'utf8'));
    throw new Error(`Unexpected browser request: ${url}`);
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  Reflect.deleteProperty(window, '__MAHOSHOJO_ROOM_DOCUMENT_V1__');
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('Desktop /arena Room journey through the real route and Native bridge', () => {
  it.each(['/arena', '/battle'] as const)('%s exposes only its intended Room entry and never attaches on mount', async path => {
    await mount(path);
    expect(Boolean(button('打开多人大厅'))).toBe(path === '/arena');
    expect(port.order).toEqual([]); assertNoExecution();
  });

  it('keeps the ordinary preference, model, independent drafts and result through lobby cancellation', async () => {
    seedOrdinary(); await mount(); await click('恢复草稿');
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText);
    const before = ordinarySnapshot(); await open();
    expect(button('生成战报')).toBeTruthy(); expect(ordinarySnapshot()).toEqual(before);
    await click('断开本机房间连接', room());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(port.order).toEqual(['attach', 'detach']);
    expect(port.actions).toEqual([]); expect(ordinarySnapshot()).toEqual(before);
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText);
    expect(getDesktopAiConfigStore().getSnapshot().modelsByProfileId[profile.id]?.selectedModelId).toBe('ordinary-selected-model');
    assertNoExecution();
  });

  it('creates as host, waits for HTTP ACK before subscribe and for snapshot plus presence before online, then closes explicitly', async () => {
    seedOrdinary(); await mount(); await click('恢复草稿'); const before = ordinarySnapshot(); await open();
    const operation = await startAction('创建多人房间', 'create'); assertConstrained(); assertNoOnline();
    expect(operation.action).toMatchObject({ kind: 'create', request: { displayName: '普通账号', sharedConfig: { combatants: [{ source: 'host-local' }, { source: 'host-local' }] } } });
    expect(JSON.stringify(operation.action)).not.toContain('完整本机设定');
    const session = sessionFor('host');
    const delivered = await port.deliver(responseEvent(operation, session), { holdAck: true });
    expect(room().textContent).toContain('你是房主'); assertNoOnline();
    expect(port.subscriptions).toEqual([]); expect(ordinarySnapshot()).toEqual(before);
    const subscribed = port.nextSubscription();
    await act(async () => { delivered.ackGate.resolve(); await subscribed; });
    expect(port.order.indexOf(`acknowledged:${delivered.batch.batchId}`)).toBeLessThan(port.order.indexOf('subscribe'));
    expect(room().querySelectorAll('[data-member-presence="unknown"]')).toHaveLength(2);
    await publishOnline(session); assertConstrained();
    await click('关闭房间', room()); await click('取消', room());
    expect(port.actions.map(item => item.action.kind)).toEqual(['create']);
    await click('关闭房间', room());
    const closing = await startAction('确认关闭房间', 'close');
    expect(closing.action).toEqual({ kind: 'close', roomId: session.roomId, expectedRoomEpoch: session.roomEpoch });
    await port.deliver(responseEvent(closing, serviceFixture.operations.close.success.result));
    expect(room().textContent).toContain('房间已关闭。');
    expect(button('生成战报')).toBeTruthy();
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText);
    await click('断开本机房间连接', room());
    expect(ordinarySnapshot()).toEqual(before); assertNoExecution();
  });

  it('joins as the exact member without uploading the local draft and leaves only after confirmation', async () => {
    seedOrdinary(); await mount(); await click('恢复草稿'); const before = ordinarySnapshot(); await open();
    await change('#arena-room-join-code', serviceFixture.operations.join.success.result.roomId);
    const joining = await startAction('加入房间', 'join');
    expect(joining.action).toEqual({ kind: 'join', roomId: serviceFixture.operations.join.success.result.roomId, request: { displayName: '普通账号' } });
    const session = await confirmMembership(joining, 'member');
    expect(room().textContent).toContain('你是成员'); expect(button('关闭房间', room())).toBeUndefined();
    await publishOnline(session); assertConstrained();
    await click('离开房间', room()); await click('取消', room());
    expect(port.actions.map(item => item.action.kind)).toEqual(['join']);
    await click('离开房间', room()); const leaving = await startAction('确认离开房间', 'leave');
    expect(leaving.action).toEqual({ kind: 'leave', roomId: session.roomId, expectedRoomEpoch: session.roomEpoch });
    await port.deliver(responseEvent(leaving, serviceFixture.operations.leave.success.result));
    expect(room().textContent).toContain('已离开房间。');
    expect(room().querySelector('[aria-label="房间成员列表"]')).toBeNull();
    await click('断开本机房间连接', room());
    expect(ordinarySnapshot()).toEqual(before);
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText); assertNoExecution();
  });

  it.each(['host', 'member'] as const)('does not revive a previous %s confirmation after same-account reattachment to the same room epoch', async role => {
    seedOrdinary(); await mount(); await click('恢复草稿'); const before = ordinarySnapshot(); await open();
    const roomId = serviceFixture.operations.join.success.result.roomId;
    await change('#arena-room-join-code', roomId);
    const originalJoin = await startAction('加入房间', 'join');
    const originalSession = await confirmMembership(originalJoin, role);
    await publishOnline(originalSession);
    const exitLabel = role === 'host' ? '关闭房间' : '离开房间';
    const confirmLabel = role === 'host' ? '确认关闭房间' : '确认离开房间';
    const exitKind = role === 'host' ? 'close' : 'leave';
    await click(exitLabel, room());
    expect(room().querySelector('[role="alertdialog"][aria-label="确认房间管理动作"]')).not.toBeNull();
    expect(button(confirmLabel, room())).toBeTruthy();
    expect(port.actions.map(item => item.action.kind)).toEqual(['join']);

    await act(async () => { await getDesktopCloudSessionStore().signOut(); });
    expect(getDesktopCloudSessionStore().getSnapshot().verification).toBe('signed-out');
    expect(room().querySelector('[aria-label="房间成员列表"]')).toBeNull();
    account = { userId: serviceFixture.expectedUserId, username: '普通账号' };
    await act(async () => { await getDesktopCloudSessionStore().refresh(); });
    expect(getDesktopCloudSessionStore().getSnapshot().verification).toBe('verified');
    await click('打开多人大厅', room());
    expect(port.order.filter(item => item === 'attach')).toHaveLength(2);
    await change('#arena-room-join-code', roomId);
    const nextJoin = await startAction('加入房间', 'join');
    const nextSession = await confirmMembership(nextJoin, role);
    // Same visible identity is deliberately insufficient: the owner/credential generation changed.
    expect(nextSession).toEqual(originalSession);
    expect(nextJoin.handle).not.toBe(originalJoin.handle);
    await publishOnline(nextSession);
    expect(room().querySelector('[role="alertdialog"][aria-label="确认房间管理动作"]')).toBeNull();
    expect(button(confirmLabel, room())).toBeUndefined();
    expect(port.actions.map(item => item.action.kind)).toEqual(['join', 'join']);
    assertConstrained();

    await click(exitLabel, room());
    expect(room().querySelector('[role="alertdialog"][aria-label="确认房间管理动作"]')).not.toBeNull();
    const freshExit = await startAction(confirmLabel, exitKind);
    expect(freshExit.action).toEqual({ kind: exitKind, roomId, expectedRoomEpoch: nextSession.roomEpoch });
    expect(freshExit.handle).toBe(nextJoin.handle);
    await port.deliver(responseEvent(freshExit, serviceFixture.operations[exitKind].success.result));
    expect(port.actions.map(item => item.action.kind)).toEqual(['join', 'join', exitKind]);
    expect(ordinarySnapshot()).toEqual(before);
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText);
    assertNoExecution();
  });

  it('requires an explicit canonical-empty choice when the real public selection lacks an observed version', async () => {
    seedOrdinary(savedDraft({ combatants: [] })); await mount(); await click('恢复草稿');
    await click('选择本地 / 公开角色');
    const tab = buttons().find(item => item.textContent?.startsWith('公开')); expect(tab).toBeTruthy();
    await act(async () => tab!.click());
    const select = document.querySelector<HTMLButtonElement>('[aria-label="选择缺版本在线角色"]'); expect(select).not.toBeNull();
    await act(async () => select!.click());
    const selected = JSON.parse(localStorage.getItem(ADVANCED_ARENA_DRAFT_KEY)!).draft.combatants.at(-1);
    expect(selected).toMatchObject({ desktopSource: 'online', sourceDataCardId: publicCard.id });
    expect(selected.sourceDataCardUpdatedAt).toBeUndefined();
    const before = ordinarySnapshot(); await open(); await click('创建多人房间', room());
    expect(room().textContent).toContain('在线内容引用缺少版本信息');
    expect(button('明确创建空草稿房间', room())).toBeTruthy(); expect(port.actions).toEqual([]);
    expect(ordinarySnapshot()).toEqual(before);
    await click('明确创建空草稿房间', room());
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('项目标准空草稿'));
    expect(port.actions).toEqual([]);
    vi.mocked(window.confirm).mockReturnValue(true);
    const empty = await startAction('明确创建空草稿房间', 'create');
    expect(empty.action).toMatchObject({ kind: 'create', request: { sharedConfig: { battleMode: 'classic', reportFormat: 'markdown', combatants: [], teams: [], scenario: null, auxScenarios: [], materials: [], userGuidance: '', historySettings: { readArenaHistoryLimit: 3 } } } });
    expect(port.actions).toHaveLength(1); expect(ordinarySnapshot()).toEqual(before);
    await click('断开本机房间连接', room());
    expect(ordinarySnapshot()).toEqual(before);
    expect(container.querySelector('[aria-label="战报结果"]')?.textContent).toContain(reportText); assertNoExecution();
  });

  it('requires confirmation to resume only the original unknown create intent and never sends a fresh create', async () => {
    await mount(); await open(); const creating = await startAction('创建多人房间', 'create');
    const original = structuredClone(creating.action);
    await port.deliver({ kind: 'mutation-unknown', operation: 'create', intentId: 'original-create-intent', roomId: null });
    await port.deliver({ kind: 'request-error', requestId: creating.requestId, operation: 'create', error: ipcFixture.error });
    expect(room().textContent).toContain('原创建操作结果未知'); assertConstrained();
    await click('确认恢复原创建意图', room());
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('resume-only'));
    expect(port.actions).toHaveLength(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    const resumed = await startAction('确认恢复原创建意图', 'resume-create');
    expect(resumed.action).toEqual({ kind: 'resume-create', intentId: 'original-create-intent' });
    expect(port.actions.map(item => item.action.kind)).toEqual(['create', 'resume-create']);
    expect(creating.action).toEqual(original);
    await confirmMembership(resumed, 'host');
    expect(room().querySelector('[aria-label="核对未知房间操作"]')).toBeNull(); assertNoExecution();
  });

  it.each(['join', 'leave', 'close'] as const)('reconciles an unknown %s only with a scoped session read', async operation => {
    port.pendingIntent = { operation, intentId: `original-${operation}-intent`, roomId: serviceFixture.operations.session.success.result.roomId };
    await mount(); await open(); assertConstrained();
    expect(port.actions).toEqual([]);
    const read = await startAction('读取房间核对结果', 'session');
    expect(read.action).toEqual({ kind: 'session', roomId: port.pendingIntent.roomId });
    expect(window.confirm).not.toHaveBeenCalled();
    await confirmMembership(read, operation === 'close' ? 'host' : 'member');
    expect(port.actions.map(item => item.action.kind)).toEqual(['session']);
    expect(room().querySelector('[aria-label="核对未知房间操作"]')).toBeNull(); assertNoExecution();
  });

  it('renders bounded directory member counts without claiming online presence or accumulating pages', async () => {
    await mount(); await open(); const discovery = await startAction('刷新', 'discover');
    expect(discovery.action).toEqual({ kind: 'discover', query: { limit: 50 } });
    await port.deliver(responseEvent(discovery, serviceFixture.boundaryExamples.directoryWith50Items.result));
    const list = room().querySelector('[aria-label="公开房间列表"]')!;
    expect(list.children).toHaveLength(50); expect(list.textContent).toContain('2/32 人');
    expect(list.querySelector('[data-member-presence]')).toBeNull(); assertNoOnline();
    expect(room().textContent).toContain('人数不是在线人数');
    const next = await startAction('下一页', 'discover');
    expect(next.action).toEqual({ kind: 'discover', query: { limit: 50, cursor: 'next-page' } });
    await port.deliver(responseEvent(next, serviceFixture.operations.discover.success.result));
    expect(room().querySelector('[aria-label="公开房间列表"]')!.children).toHaveLength(1);
    expect(button('下一页', room())).toBeUndefined(); assertNoOnline(); assertNoExecution();
  });

  it.each(['account', 'document'] as const)('drops a late pulled membership batch after %s retirement without resurrecting UI', async retirement => {
    seedOrdinary(); const router = await mount(); await click('恢复草稿'); await open();
    const joining = await (async () => { await change('#arena-room-join-code', serviceFixture.operations.join.success.result.roomId); return startAction('加入房间', 'join'); })();
    const late = port.queue(responseEvent(joining, sessionFor('member')), { holdPull: true });
    await act(async () => { port.notify(late); await late.pullStarted.promise; });
    if (retirement === 'account') {
      await act(async () => { await getDesktopCloudSessionStore().signOut(); });
      expect(getDesktopCloudSessionStore().getSnapshot().verification).toBe('signed-out');
    } else {
      Object.defineProperty(window, '__MAHOSHOJO_ROOM_DOCUMENT_V1__', { configurable: true, writable: true, value: 'b'.repeat(64) });
      vi.mocked(window.confirm).mockReturnValue(true);
      await act(async () => { await router.navigate({ to: '/battle' }); });
      expect(button('打开多人大厅')).toBeUndefined();
    }
    const afterRetirement = container.textContent;
    await act(async () => { late.pullGate.resolve(); await late.pullReturned.promise; });
    const pulls = port.order.filter(item => item.startsWith('pull:'));
    await act(async () => port.notify(late));
    expect(port.order.filter(item => item.startsWith('pull:'))).toEqual(pulls);
    expect(container.textContent).toBe(afterRetirement);
    expect(container.querySelector('[aria-label="房间成员列表"]')).toBeNull();
    expect(port.subscriptions).toEqual([]);
    expect(port.actions.map(item => item.action.kind)).toEqual(['join']);
    expect(port.acknowledgements).toHaveLength(retirement === 'account' ? 1 : 0);
    assertNoExecution();
  });
});
