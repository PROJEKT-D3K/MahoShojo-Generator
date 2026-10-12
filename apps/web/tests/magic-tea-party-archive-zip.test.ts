import { describe, expect, it } from 'vitest';
import { buildMagicTeaPartySessionExport as sharedBuildSessionExport } from '@mahoshojo/domain/magic-tea-party/transfer';

import {
  buildMagicTeaPartyArchiveZipEntries,
  buildMagicTeaPartySessionExport,
} from '@/lib/magic-tea-party/transfer';
import type { MagicTeaPartyMessage, MagicTeaPartySession, MagicTeaPartyTachieAsset } from '@/lib/magic-tea-party/types';

const baseSettings: MagicTeaPartySession['settings'] = {
  providerId: 'test',
  modelId: 'model',
  enableChoices: false,
  choiceCount: 3,
  outputFormat: 'jsonl',
  outputPlan: { choices: 'off', summary: 'off', updates: 'off' },
  updateApplyMode: 'auto',
  language: 'zh-CN',
  userDisplayName: '旅人',
  enableSummary: true,
  readArenaHistory: true,
  readArenaHistoryLimit: 3,
  isArenaHistoryUnlimited: false,
  readCurrentState: true,
  writeArenaHistory: false,
  writeCurrentState: false,
};

const buildSession = (): MagicTeaPartySession => ({
  id: 'session-zip',
  title: '茶会归档',
  createdAt: 1,
  updatedAt: 1,
  roles: [],
  auxScenarios: [],
  playerRoleId: null,
  settings: baseSettings,
});

describe('buildMagicTeaPartyArchiveZipEntries', () => {
  it('宿主 ZIP 消费共享会话导出，保留扩展 metadata 并将无 Blob 的远端引用记为缺失', async () => {
    const session = {
      ...buildSession(),
      extension: { chapterLabels: ['原始扩展'] },
      settings: { ...baseSettings, extension: { preserve: true } },
    };
    const message = {
      id: 'message-extension', sessionId: session.id, role: 'assistant' as const,
      content: '完整正文', createdAt: 1, meta: { extension: ['保留'] },
      extension: { original: true },
    };
    const asset = {
      id: 'remote-reference', sessionId: session.id, cacheKey: 'remote-cache',
      fragmentHash: 'fragment', styleId: 'style', createdAt: 1, lastUsedAt: 2,
      anchorMessageId: message.id,
      imageUrl: 'https://media.example.invalid/original.png',
      blobRef: 'old-local-reference', blobSize: 123,
      extension: { description: '仅元数据' },
    };
    const sessionExport = sharedBuildSessionExport({
      session, messages: [message], tachieAssets: [asset],
      exportedAt: '2026-01-17T00:00:00.000Z',
    });
    const result = await buildMagicTeaPartyArchiveZipEntries({
      sessions: [sessionExport], tachieBlobs: {},
      exportedAt: '2026-01-17T00:00:00.000Z',
    });

    const decode = (name: string) => JSON.parse(new TextDecoder().decode(result.entries[name]));
    expect(decode(`sessions/${session.id}.json`)).toEqual(sessionExport);
    expect(decode(`sessions/${session.id}.json`).session.extension).toEqual(session.extension);
    expect(decode(`sessions/${session.id}.json`).messages[0].extension).toEqual(message.extension);
    expect(result.stats).toEqual({ sessionCount: 1, blobCount: 0, missingCount: 1 });
    expect(result.manifest).toMatchObject({ tachieCount: 0, missingBlobs: 1 });
    expect(decode('assets/tachie/index.json').items).toEqual([{
      ...asset, fileName: null, mimeType: 'application/octet-stream', blobSize: 0,
    }]);
    expect(Object.keys(result.entries).sort()).toEqual([
      'assets/tachie/index.json', 'manifest.json', `sessions/${session.id}.json`,
    ]);
    expect(asset.blobSize).toBe(123);
    expect(sessionExport.tachieAssets[0]).toBe(asset);
  });

  it('生成包含 manifest / 会话 / 立绘索引的 zip 条目', async () => {
    const session = buildSession();
    const messages: MagicTeaPartyMessage[] = [];
    const assets: MagicTeaPartyTachieAsset[] = [
      {
        id: 'asset-1',
        sessionId: session.id,
        cacheKey: 'cache-1',
        fragmentHash: 'hash-1',
        styleId: 'style-1',
        createdAt: 1,
        lastUsedAt: 1,
      },
      {
        id: 'asset-2',
        sessionId: session.id,
        cacheKey: 'cache-2',
        fragmentHash: 'hash-2',
        styleId: 'style-1',
        createdAt: 1,
        lastUsedAt: 1,
      },
    ];

    const sessionExport = buildMagicTeaPartySessionExport({
      session,
      messages,
      tachieAssets: assets,
      appVersion: 'test',
      exportedAt: '2026-01-17T00:00:00.000Z',
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const { entries } = await buildMagicTeaPartyArchiveZipEntries({
      sessions: [sessionExport],
      tachieBlobs: {
        'asset-1': blob,
        'asset-2': null,
      },
      exportedAt: '2026-01-17T00:00:00.000Z',
      appVersion: 'test',
    });

    expect(entries['sessions/session-zip.json']).toBeTruthy();
    expect(entries['manifest.json']).toBeTruthy();
    expect(entries['assets/tachie/index.json']).toBeTruthy();
    expect(entries['assets/tachie/asset-1.png']).toBeTruthy();
    expect(entries['assets/tachie/asset-2.bin']).toBeUndefined();

    const decoder = new TextDecoder();
    const manifest = JSON.parse(decoder.decode(entries['manifest.json']));
    expect(manifest.schema).toBe('magic-tea-party.archive.zip.v1');
    expect(manifest.sessionCount).toBe(1);
    expect(manifest.tachieCount).toBe(1);
    expect(manifest.missingBlobs).toBe(1);

    const index = JSON.parse(decoder.decode(entries['assets/tachie/index.json']));
    const item1 = index.items.find((item: any) => item.id === 'asset-1');
    const item2 = index.items.find((item: any) => item.id === 'asset-2');
    expect(item1.fileName).toBe('assets/tachie/asset-1.png');
    expect(item1.blobSize).toBe(3);
    expect(item2.fileName).toBeNull();
  });
});
