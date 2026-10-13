// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicTeaPartyImportExportPanel } from '@/components/magic-tea-party/ImportExportPanel';
import type { MagicTeaPartyMessage, MagicTeaPartyPreferences, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';

const host = vi.hoisted(() => ({
  download: vi.fn(), push: vi.fn(), checkSensitive: vi.fn(), maskText: vi.fn(), maskJson: vi.fn(),
  listSessions: vi.fn(), getSession: vi.fn(), listMessages: vi.fn(), listAssets: vi.fn(), getBlob: vi.fn(),
  putSession: vi.fn(), putMessage: vi.fn(), putAsset: vi.fn(),
}));

vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: host.push }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: host.download }));
vi.mock('@/lib/magic-tea-party/storage', () => ({
  listMagicTeaPartySessions: host.listSessions,
  getMagicTeaPartySession: host.getSession,
  listMagicTeaPartyMessages: host.listMessages,
  listMagicTeaPartyTachieAssets: host.listAssets,
  getMagicTeaPartyTachieBlob: host.getBlob,
  putMagicTeaPartySession: host.putSession,
  putMagicTeaPartyMessage: host.putMessage,
  putMagicTeaPartyTachieAsset: host.putAsset,
}));
vi.mock('@/lib/magic-tea-party/import-safety', () => ({
  checkMagicTeaPartySensitiveText: host.checkSensitive,
  maskMagicTeaPartyText: host.maskText,
  maskMagicTeaPartyJsonValue: host.maskJson,
}));

const preferences: MagicTeaPartyPreferences = {
  outputFormat: 'jsonl', outputPlan: { choices: 'auto', summary: 'off', updates: 'auto' },
  enableChoices: true, choiceCount: 4, language: 'zh-CN', userDisplayName: '旅人',
  enableSummary: true, updateApplyMode: 'auto', readArenaHistory: true, readArenaHistoryLimit: 3,
  isArenaHistoryUnlimited: false, readCurrentState: true, writeArenaHistory: false, writeCurrentState: false,
  tachieCacheMaxPerSession: 10, tachieCacheMaxGlobal: 20, tachieCacheMaxBytes: 1024,
  presetCharacterPanelCollapsed: true, presetScenarioPanelCollapsed: true, sessionRetentionDays: 60, maxSessions: 200,
};

const buildSession = (): MagicTeaPartySession => ({
  id: 'session-export', title: '茶会导出', createdAt: 1700000000000, updatedAt: 1700000000001,
  roles: [{ id: 'role-1', name: '星见澪', source: 'local', card: { name: '星见澪', extension: ['原卡'] } }],
  auxScenarios: [], playerRoleId: 'role-1',
  settings: { providerId: 'existing-provider', modelId: 'existing-model', userDisplayName: '旅人', outputFormat: 'jsonl' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((element) => element.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};

async function renderPanel(session: MagicTeaPartySession | null, onImported: (id: string) => void = vi.fn()) {
  await act(async () => root.render(
    <MagicTeaPartyImportExportPanel activeSession={session} preferences={preferences} onSessionImported={onImported} />,
  ));
  await act(async () => button('展开').click());
}

async function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function exportFromPanel(label: string) {
  const downloaded = deferred<{ blob: Blob; filename: string }>();
  host.download.mockImplementationOnce((blob: Blob, filename: string) => downloaded.resolve({ blob, filename }));
  let result!: { blob: Blob; filename: string };
  await act(async () => {
    button(label).click();
    result = await downloaded.promise;
  });
  expect(button(label).disabled).toBe(false);
  return { ...result, text: await readBlob(result.blob) };
}

beforeEach(() => {
  vi.resetAllMocks();
  host.listSessions.mockResolvedValue([]);
  host.getSession.mockResolvedValue(null);
  host.listMessages.mockResolvedValue([]);
  host.listAssets.mockResolvedValue([]);
  host.getBlob.mockResolvedValue(null);
  host.putSession.mockResolvedValue(undefined);
  host.putMessage.mockResolvedValue(undefined);
  host.putAsset.mockResolvedValue(undefined);
  host.checkSensitive.mockResolvedValue({ blocked: false });
  host.maskText.mockImplementation((value: string) => ({ value, hasShieldWords: false, detectedWords: [] }));
  host.maskJson.mockImplementation((value: unknown) => ({ value, hasShieldWords: false, detectedWords: [] }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Web 茶会真实导入导出面板消费共享格式核', () => {
  it('JSON 按钮导出会话和未知 metadata，只包含媒体引用而不读取 Blob', async () => {
    const session = { ...buildSession(), extension: { preserve: ['session'] } };
    const message = {
      id: 'message-1', sessionId: session.id, role: 'assistant' as const,
      content: '原始正文', createdAt: 1700000000002, extension: { preserve: true },
    };
    const asset = {
      id: 'asset-1', sessionId: session.id, anchorMessageId: message.id,
      cacheKey: 'cache', fragmentHash: 'fragment', styleId: 'style', createdAt: 1, lastUsedAt: 2,
      imageUrl: 'https://media.example.invalid/reference.png', blobRef: 'existing-local-reference',
      extension: { preserve: ['asset'] },
    };
    host.listMessages.mockResolvedValue([message]);
    host.listAssets.mockResolvedValue([asset]);
    await renderPanel(session);

    const result = await exportFromPanel('导出当前会话（JSON）');
    const exported = JSON.parse(result.text);
    const { roles, auxScenarios, ...sessionCore } = session;
    expect(exported).toEqual({
      schema: 'magic-tea-party.session.v1', exportedAt: expect.any(String), appVersion: 'unknown',
      session: sessionCore, roles, scenario: null, auxScenarios, messages: [message], tachieAssets: [asset],
    });
    expect(result.blob.type).toBe('application/json');
    expect(result.filename).toBe('茶会导出.json');
    expect(host.listMessages).toHaveBeenCalledWith(session.id);
    expect(host.listAssets).toHaveBeenCalledWith(session.id);
    expect(host.getBlob).not.toHaveBeenCalled();
    expect(host.putSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('会话已导出。');
  });

  it('JSONL 按钮使用分段正文并保留既有 extra，重新构造而非重放 rawLine', async () => {
    const session = buildSession();
    const message: MagicTeaPartyMessage = {
      id: 'message-1', sessionId: session.id, role: 'assistant', content: '不会优先导出的原正文',
      createdAt: 1700000000002, speakerId: 'role-1', tachieId: 'metadata-only',
      segments: [{ type: 'dialogue', speakerId: 'role-1', text: '欢迎来到茶会' }],
      meta: {
        source: { rawLine: '{"mes":"不能拿来直接导出"}' },
        sillyTavern: { extra: { foreign: { preserve: true }, magic_tea_party: { oldExtension: '旧扩展' } } },
      },
    };
    host.listMessages.mockResolvedValue([message]);
    await renderPanel(session);

    const result = await exportFromPanel('导出当前会话（SillyTavern JSONL）');
    const lines = result.text.split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { user_name: '旅人', character_name: '星见澪', create_date: expect.any(String), chat_metadata: { source: 'magic-tea-party' } },
      {
        name: '星见澪', mes: '星见澪: 欢迎来到茶会', send_date: 1700000000002, is_user: false,
        extra: {
          foreign: { preserve: true },
          magic_tea_party: { speakerId: 'role-1', segments: message.segments, choices: null, tachieId: 'metadata-only', revisionOf: null },
        },
      },
    ]);
    expect(result.blob.type).toBe('application/jsonl');
    expect(result.filename).toBe('茶会导出_SillyTavern.jsonl');
    expect(host.listAssets).not.toHaveBeenCalled();
    expect(host.getBlob).not.toHaveBeenCalled();
    expect(host.putMessage).not.toHaveBeenCalled();
    expect(container.textContent).toContain('SillyTavern JSONL 已导出。');
  });

  it('JSONL 文件经安全宿主检查后使用真实 parser，保留 legacy extra 并等待消息写入完成', async () => {
    const row = JSON.stringify({
      name: '叙述者', is_user: false, mes: '  导入正文  ', send_date: 1700000000,
      extra: { foreign: { preserve: true }, magic_tavern: { speakerId: 'role-old', tachieId: 'asset-old' } },
    });
    const text = ['{"user_name":"旅人","character_name":"叙述者"}', row, '{broken'].join('\r\n');
    const completed = deferred<string>();
    const messageWriteStarted = deferred<void>();
    const messageWriteFinished = deferred<void>();
    const onImported = vi.fn((id: string) => completed.resolve(id));
    host.putMessage.mockImplementation(() => {
      messageWriteStarted.resolve();
      return messageWriteFinished.promise;
    });
    await renderPanel(null, onImported);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = { name: '旧茶会.jsonl', type: 'application/jsonl', text: vi.fn(async () => text) };
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    try {
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await messageWriteStarted.promise;
      });
      expect(onImported).not.toHaveBeenCalled();
      expect(button('导入会话（JSON / JSONL）').disabled).toBe(true);
    } finally {
      await act(async () => { messageWriteFinished.resolve(); });
    }
    let importedId!: string;
    await act(async () => {
      importedId = await completed.promise;
    });

    expect(file.text).toHaveBeenCalledTimes(1);
    expect(host.checkSensitive).toHaveBeenCalledWith({
      text, reason: '使用危险符文', origin: '/magic-tea-party', label: '魔法茶会导入会话',
      filename: '旧茶会.jsonl', mimeType: 'application/jsonl',
    });
    expect(host.putSession).toHaveBeenCalledTimes(1);
    expect(host.putSession.mock.calls[0][0]).toMatchObject({
      id: importedId, title: '旧茶会', titleMeta: { source: 'manual', reason: 'import' },
      roles: [], auxScenarios: [], playerRoleId: null, settings: { providerId: 'unknown', modelId: '' },
    });
    expect(host.putMessage).toHaveBeenCalledTimes(1);
    expect(host.putMessage.mock.calls[0][0]).toEqual({
      id: expect.any(String), sessionId: importedId, role: 'assistant', content: '导入正文',
      createdAt: 1700000000000, status: 'done', speakerId: 'role-old', tachieId: 'asset-old',
      meta: {
        speakerName: '叙述者', source: { rawLine: row },
        sillyTavern: { extra: { foreign: { preserve: true }, magic_tavern: { speakerId: 'role-old', tachieId: 'asset-old' } } },
      },
    });
    expect(host.putAsset).not.toHaveBeenCalled();
    expect(host.getBlob).not.toHaveBeenCalled();
    expect(host.download).not.toHaveBeenCalled();
    expect(host.push).not.toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(button('导入会话（JSON / JSONL）').disabled).toBe(false);
    expect(input.value).toBe('');
    expect(container.textContent).toContain('已导入 1 条消息（1 行已跳过）。');
  });
});

async function importFromPanel(value: unknown, filename = 'archive.json') {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: filename, type: 'application/json', text: async () => JSON.stringify(value) }] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('导入会话（JSON / JSONL）').disabled).toBe(false);
}

const importEntry = (sessionId: string, prefix: string) => ({
  schema: 'magic-tea-party.session.v1',
  session: {
    id: sessionId, title: '屏蔽标题', createdAt: 1, updatedAt: 2,
    settings: { providerId: 'old-provider', modelId: 'old-model', temperature: 0.3, futureOption: { neverDispatch: true }, outputPlan: { choices: 'on', summary: 'off', updates: 'auto', future: true } },
    summary: '屏蔽摘要', summarySections: { recap: '屏蔽章节' },
    summaryMeta: { updatedAt: 3, fromMessageId: `${prefix}-user`, toMessageId: `${prefix}-assistant`, extension: { keep: true } },
    protocolShadow: {
      updatedAt: 4, source: 'manual',
      messageRange: { fromMessageId: `${prefix}-user`, toMessageId: `${prefix}-assistant`, extension: 'range' },
      drafts: [{ character: '屏蔽角色', current_state_summary: '屏蔽旧草稿', extension: true, meta: { sessionId, messageRange: { fromMessageId: `${prefix}-user`, toMessageId: `${prefix}-assistant`, count: 2 }, futureMeta: 'keep' } }],
      extension: ['shadow'],
    },
    updateSnapshot: {
      id: 'snapshot', createdAt: 5, mode: 'confirm',
      messageRange: { fromMessageId: `${prefix}-user`, toMessageId: `${prefix}-assistant` }, drafts: [],
      rolesBefore: [{ id: 'role', name: '屏蔽之前', source: 'local', card: { name: '屏蔽角色卡' } }],
      rolesAfter: [{ id: 'role', name: '屏蔽之后', source: 'local', card: { name: '屏蔽角色卡' } }], extension: true,
    },
    lastChoices: [{ id: 'choice', text: '屏蔽选项', future: true }], draft: '屏蔽输入', branchLabel: '原分支',
    extension: { mustKeep: '屏蔽未知值仍保持原样' },
  },
  roles: [{ id: 'role', name: '屏蔽角色', source: 'local', notes: '屏蔽备注', card: { name: '屏蔽卡', future: ['data'] }, extension: true }],
  scenario: { id: 'scenario', title: '屏蔽情景', source: 'local', card: { title: '屏蔽情景卡' }, extension: true },
  auxScenarios: [{ id: 'aux', title: '屏蔽辅情景', source: 'local', card: { title: '屏蔽辅卡' } }],
  messages: [
    { id: `${prefix}-user`, sessionId, role: 'user', content: '屏蔽用户', createdAt: 1, extension: { keep: true } },
    { id: `${prefix}-assistant`, sessionId, role: 'assistant', content: '屏蔽助手', createdAt: 2, status: 'streaming', sourceMessageId: `${prefix}-user`, revisionOf: `${prefix}-user`, tachieId: `${prefix}-asset`,
      segments: [{ type: 'dialogue', speakerId: 'role', speakerName: '屏蔽姓名', text: '屏蔽对白', future: true }],
      choices: [{ id: 'choice', text: '屏蔽选项', future: true }], meta: { speakerName: '屏蔽姓名', future: { keep: true } } },
  ],
  tachieAssets: [{ id: `${prefix}-asset`, sessionId, anchorMessageId: `${prefix}-assistant`, cacheKey: 'cache', fragmentHash: 'hash', styleId: 'style', imageUrl: 'https://media.invalid/reference.png', blobRef: 'old-local-reference', createdAt: 1, lastUsedAt: 2, extension: { keep: true } }],
  extensionEnvelope: { keep: true },
});

describe('Web import plan real panel regression', () => {
  it('imports a nonempty archive in one preflight, remaps forward parent links and keeps Web masking/media/unknown data', async () => {
    const child = importEntry('child', 'child'); const parent = importEntry('parent', 'parent');
    Object.assign(child.session, { forkedFrom: { sessionId: 'parent', messageId: 'parent-assistant', createdAt: 4, future: true } });
    child.messages[1].revisionOf = 'parent-assistant';
    host.maskText.mockImplementation((value: string) => ({ value: value.replaceAll('屏蔽', '＊＊'), hasShieldWords: true, detectedWords: ['屏蔽'] }));
    host.maskJson.mockImplementation((value: unknown) => ({ value: JSON.parse(JSON.stringify(value).replaceAll('屏蔽', '＊＊')), hasShieldWords: true, detectedWords: ['屏蔽'] }));
    const onImported = vi.fn();
    await renderPanel(null, onImported);
    await importFromPanel({ schema: 'magic-tavern.archive.v1', sessions: [child, parent], futureArchive: true });

    expect(host.putSession).toHaveBeenCalledTimes(2);
    expect(host.putMessage).toHaveBeenCalledTimes(4);
    expect(host.putAsset).toHaveBeenCalledTimes(2);
    const importedChild = host.putSession.mock.calls[0][0];
    const importedParent = host.putSession.mock.calls[1][0];
    const [childUser, childAssistant, , parentAssistant] = host.putMessage.mock.calls.map(call => call[0]);
    const childAsset = host.putAsset.mock.calls[0][0];
    expect(importedChild.forkedFrom).toEqual({ sessionId: importedParent.id, messageId: parentAssistant.id, createdAt: 4, future: true });
    expect(childAssistant).toMatchObject({ sessionId: importedChild.id, sourceMessageId: childUser.id, revisionOf: parentAssistant.id, tachieId: childAsset.id, status: 'done', content: '＊＊助手', segments: [{ speakerName: '＊＊姓名', text: '＊＊对白', future: true }], choices: [{ id: 'choice', text: '＊＊选项', future: true }], meta: { speakerName: '＊＊姓名', future: { keep: true } } });
    expect(childAsset).toMatchObject({ sessionId: importedChild.id, anchorMessageId: childAssistant.id, imageUrl: 'https://media.invalid/reference.png', blobRef: 'old-local-reference', extension: { keep: true } });
    expect(importedChild).toMatchObject({
      title: '＊＊标题', summary: '＊＊摘要', summarySections: { recap: '＊＊章节' }, draft: '＊＊输入',
      roles: [{ name: '＊＊角色', notes: '＊＊备注', card: { name: '＊＊卡', future: ['data'] }, extension: true }],
      scenario: { title: '＊＊情景', card: { title: '＊＊情景卡' }, extension: true },
      auxScenarios: [{ title: '＊＊辅情景', card: { title: '＊＊辅卡' } }],
      settings: { providerId: 'old-provider', modelId: 'old-model', temperature: 0.3, futureOption: { neverDispatch: true }, outputPlan: { future: true, choices: 'on', summary: 'off', updates: 'auto' } },
      summaryMeta: { fromMessageId: childUser.id, toMessageId: childAssistant.id, extension: { keep: true } },
      protocolShadow: { messageRange: { fromMessageId: childUser.id, toMessageId: childAssistant.id, count: 2, extension: 'range' }, drafts: [{ characterName: '＊＊角色', currentStateSummary: '＊＊旧草稿', extension: true, meta: { sessionId: importedChild.id, messageRange: { fromMessageId: childUser.id, toMessageId: childAssistant.id, count: 2 }, futureMeta: 'keep' } }], extension: ['shadow'] },
      updateSnapshot: { messageRange: { fromMessageId: childUser.id, toMessageId: childAssistant.id, count: 2 }, rolesBefore: [{ name: '＊＊之前' }], rolesAfter: [{ name: '＊＊之后' }], extension: true },
      lastChoices: [{ id: 'choice', text: '＊＊选项', future: true }],
      extension: { mustKeep: '屏蔽未知值仍保持原样' },
      importMetadata: { sourceEnvelope: { session: { extensionEnvelope: { keep: true } }, archive: { futureArchive: true } } },
    });
    expect(host.getSession).not.toHaveBeenCalled();
    expect(host.getBlob).not.toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledWith(importedChild.id);
    expect(container.textContent).toContain('已导入 2 个会话。');

    host.listMessages.mockResolvedValue([childUser, childAssistant]);
    host.listAssets.mockResolvedValue([childAsset]);
    await act(async () => root.render(<MagicTeaPartyImportExportPanel activeSession={importedChild} preferences={preferences} onSessionImported={onImported} />));
    const exported = JSON.parse((await exportFromPanel('导出当前会话（JSON）')).text);
    expect(exported.session.extension).toEqual(child.session.extension);
    expect(exported.session.settings.futureOption).toEqual({ neverDispatch: true });
    expect(exported.messages[0].extension).toEqual({ keep: true });
    expect(exported.tachieAssets[0].extension).toEqual({ keep: true });
    expect(exported.session.protocolShadow.extension).toEqual(['shadow']);
  });

  it.each(['session', 'message', 'asset'])('rejects duplicate %s IDs in a later archive entry with zero IndexedDB writes', async kind => {
    const a = importEntry('a', 'a'); const b = importEntry('b', 'b');
    if (kind === 'session') b.session.id = a.session.id;
    if (kind === 'message') b.messages[0].id = a.messages[0].id;
    if (kind === 'asset') b.tachieAssets[0].id = a.tachieAssets[0].id;
    const onImported = vi.fn(); await renderPanel(null, onImported);
    await importFromPanel({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] });
    expect(host.putSession).not.toHaveBeenCalled(); expect(host.putMessage).not.toHaveBeenCalled(); expect(host.putAsset).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(container.textContent).toContain('ID 重复');
  });

  it('retains external parent provenance without binding to an existing local session of the same ID', async () => {
    const input = importEntry('source', 'source');
    Object.assign(input.session, { forkedFrom: { sessionId: 'existing-local', messageId: 'existing-message', createdAt: 1 } });
    host.getSession.mockResolvedValue({ ...buildSession(), id: 'existing-local' });
    await renderPanel(null); await importFromPanel(input, 'session.json');
    expect(host.putSession).toHaveBeenCalledTimes(1);
    expect(host.putSession.mock.calls[0][0].forkedFrom).toBeUndefined();
    expect(host.putSession.mock.calls[0][0].importMetadata.unresolvedForkedFrom).toEqual({ sessionId: 'existing-local', messageId: 'existing-message', createdAt: 1 });
    expect(host.getSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('未解析来源');
  });

  it('completes Web masking for the last session before writing any part of the archive', async () => {
    const a = importEntry('a', 'a'); const b = importEntry('b', 'b');
    b.messages[1].content = 'mask-failure';
    host.maskText.mockImplementation((value: string) => {
      if (value === 'mask-failure') throw new Error('mask failed');
      return { value, hasShieldWords: false, detectedWords: [] };
    });
    await renderPanel(null); await importFromPanel({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] });
    expect(host.putSession).not.toHaveBeenCalled(); expect(host.putMessage).not.toHaveBeenCalled(); expect(host.putAsset).not.toHaveBeenCalled();
    expect(container.textContent).toContain('mask failed');
  });

  it('keeps the existing sensitive-text redirect before parsing or writing', async () => {
    host.checkSensitive.mockResolvedValue({ blocked: true, redirectTarget: '/blocked' });
    await renderPanel(null); await importFromPanel(importEntry('source', 'source'));
    expect(host.push).toHaveBeenCalledWith('/blocked');
    expect(host.putSession).not.toHaveBeenCalled(); expect(host.putMessage).not.toHaveBeenCalled(); expect(host.putAsset).not.toHaveBeenCalled();
    expect(host.maskText).not.toHaveBeenCalled();
  });
  it.each(['summary', 'draft-impact', 'draft-currentStateSummary', 'draft-winner'])('rejects malformed known %s in a later entry before any IndexedDB write', field => {
    const a = importEntry('a', 'a'); const b = importEntry('b', 'b');
    if (field === 'summary') Object.assign(b.session, { summary: { x: 1 } });
    else Object.assign(b.session.protocolShadow.drafts[0], { [field.slice('draft-'.length)]: { x: 1 } });
    return (async () => {
      await renderPanel(null); await importFromPanel({ schema: 'magic-tea-party.archive.v1', sessions: [a, b] });
      expect(host.putSession).not.toHaveBeenCalled(); expect(host.putMessage).not.toHaveBeenCalled(); expect(host.putAsset).not.toHaveBeenCalled();
      expect(container.textContent).toContain('必须为字符串');
    })();
  });

  it('keeps JSONL primitive skip warnings, numeric IDs and explicit placeholder-like IDs compatible', async () => {
    const rows = ['42', '[]', '{"id":12,"mes":"数字ID正文"}', '{"id":"@jsonl-message-1","mes":"显式ID正文"}'];
    await renderPanel(null);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'legacy.jsonl', type: 'application/jsonl', text: async () => rows.join('\n') }] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.putSession).toHaveBeenCalledTimes(1); expect(host.putMessage).toHaveBeenCalledTimes(2);
    expect(host.putMessage.mock.calls[0][0].meta.source.rawLine).toBe(rows[2]);
    expect(host.putMessage.mock.calls[1][0].meta.source.rawLine).toBe(rows[3]);
    expect(container.textContent).toContain('已导入 2 条消息（2 行已跳过）。');
  });

  it('remaps Web superseded metadata to a later imported session and leaves external/unknown metadata inert', async () => {
    const first = importEntry('first', 'first'); const later = importEntry('later', 'later');
    Object.assign(first.messages[1], { meta: { supersededBySessionId: 'later', future: { supersededBySessionId: 'later' } } });
    Object.assign(later.messages[1], { meta: { supersededBySessionId: 'external', future: true } });
    await renderPanel(null); await importFromPanel({ schema: 'magic-tea-party.archive.v1', sessions: [first, later] });
    expect(host.putSession).toHaveBeenCalledTimes(2);
    expect(host.putMessage.mock.calls[1][0].meta).toEqual({ supersededBySessionId: host.putSession.mock.calls[1][0].id, future: { supersededBySessionId: 'later' } });
    expect(host.putMessage.mock.calls[3][0].meta).toEqual({ supersededBySessionId: 'external', future: true });
  });

});
