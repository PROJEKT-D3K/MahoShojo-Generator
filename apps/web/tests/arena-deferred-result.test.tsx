// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => { resolve = done; });
  return { ready, resolve, cardLoads: vi.fn(), illustrationLoads: vi.fn(), engineMount: vi.fn(),
    engineCleanup: vi.fn(), repairMount: vi.fn(), repairCleanup: vi.fn(), stop: vi.fn(), download: vi.fn() };
});
vi.mock('@/components/stream/StreamingBattleReportCard', async () => {
  fixture.cardLoads();
  await fixture.ready;
  return { default: ({ content }: { content: string }) => <article>{content}</article> };
});
vi.mock('@/components/arena/components/BattleIllustrationPanel', () => {
  fixture.illustrationLoads();
  return { BattleIllustrationPanel: () => <aside>插图工具</aside> };
});
vi.mock('@/components/arena/hooks/useBattleEngine', async () => {
  const { useEffect } = await import('react');
  return { useBattleEngine: () => {
    useEffect(() => { fixture.engineMount(); return fixture.engineCleanup; }, []);
    return { stopGeneration: fixture.stop, arenaGenerationConnectionState: 'recovering', isRecoveringArenaGeneration: true };
  } };
});
vi.mock('@/components/arena/hooks/useCombatantRepair', async () => {
  const { useEffect } = await import('react');
  return { useCombatantRepair: () => {
    useEffect(() => { fixture.repairMount(); return fixture.repairCleanup; }, []);
    return { isInRoom: false, hasRepairContext: false };
  } };
});
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: fixture.download }));
import { BattleResult } from '@/components/arena/components/BattleResult';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';

test('无结果仍挂载生成和恢复hooks但不载入卡片/插图；首段等待期间可停止/导出且保留最新结果', async () => {
  const initial = useBattleStore.getInitialState();
  useBattleStore.setState({ ...initial, generationMode: 'stream', streamingMarkdown: null,
    settings: { ...initial.settings, writeArenaHistory: false, writeCurrentState: false } }, true);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BattleResult onSaveImage={() => {}} />));
    expect(fixture.engineMount).toHaveBeenCalledOnce(); expect(fixture.repairMount).toHaveBeenCalledOnce();
    expect(fixture.cardLoads).not.toHaveBeenCalled(); expect(fixture.illustrationLoads).not.toHaveBeenCalled();
    await act(async () => useBattleStore.setState({ isGenerating: true, streamingMarkdown: '' }));
    expect(container.textContent).toContain('正在加载战报卡片');
    await act(async () => useBattleStore.setState({ streamingMarkdown: '# 首段' }));
    await vi.waitFor(() => expect(fixture.cardLoads).toHaveBeenCalledOnce());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '放弃恢复')!.click());
    expect(fixture.stop).toHaveBeenCalledOnce();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '导出正文')!.click());
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(fixture.download.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(fixture.illustrationLoads).not.toHaveBeenCalled();
    await act(async () => useBattleStore.setState({ streamingMarkdown: '# 最新完整正文', isGenerating: false }));
    await act(async () => { fixture.resolve(); await vi.dynamicImportSettled(); });
    expect(container.querySelector('article')?.textContent).toBe('# 最新完整正文');
    expect(container.textContent).toContain('插图工具');
    expect(fixture.engineMount).toHaveBeenCalledOnce(); expect(fixture.repairMount).toHaveBeenCalledOnce();
    expect(fixture.engineCleanup).not.toHaveBeenCalled(); expect(fixture.repairCleanup).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove();
    useBattleStore.setState(initial, true);
  }
  expect(fixture.engineCleanup).toHaveBeenCalledOnce(); expect(fixture.repairCleanup).toHaveBeenCalledOnce();
});
