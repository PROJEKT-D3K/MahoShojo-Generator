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
