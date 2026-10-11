// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopArenaStoryControls } from '../src/features/arena/story-controls';
import * as snapshotModule from '../src/features/arena/story-snapshot';
import { directBranchOwnerFixture } from './helpers/arena-story-direct-branch-owner-fixture';
import { directBranchExecution } from './helpers/arena-story-direct-branch-fixture';
import { installStoryCrypto, storyDraft } from './helpers/story-fixture';

installStoryCrypto();
afterEach(() => vi.restoreAllMocks());
describe('branch result retains existing complete-output export', () => {
  it.each(['battle', 'arena'] as const)('%s exports complete received prose after projection failure and blocks another branch', async product => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const f = await directBranchOwnerFixture(), download = vi.fn(), rawText = '# 未存分支\n\n' + '完整正文中😀'.repeat(3000) + '\n完整尾文';
    const execution = directBranchExecution({ rawText }), container = document.createElement('div'), root = createRoot(container); document.body.append(container);
    vi.spyOn(snapshotModule, 'completeDesktopBranchRecords').mockImplementation(() => { expect(f.owner.getSnapshot().result?.markdown).toBe(rawText); throw new Error('projection failed after prose'); });
    try {
      await act(async () => root.render(<DesktopArenaStoryControls owner={f.owner} product={product} draft={storyDraft()}
        disabled={false} unavailableReason={null} onStart={() => {}} onContinue={() => {}} download={download} onNavigateExternal={() => {}} />));
      await act(async () => f.owner.generateBranch({ mode: 'direct', anchor: f.anchor, userGuidance: '新走向' }, execution.prepare));
      const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text);
      expect(button('重试本地保存')).toBeUndefined();
      expect(button('创建分支')?.disabled).toBe(true);
      await act(async () => button('导出未保存章节')!.click());
      expect(download).toHaveBeenLastCalledWith('未保存章节.md', rawText, 'text/markdown;charset=utf-8');
      await act(async () => button('导出完整原始输出')!.click());
      expect(JSON.parse(download.mock.calls.at(-1)![1])).toMatchObject({ rawText });
      expect(execution.requests).toHaveLength(1); expect(f.branch.begin).not.toHaveBeenCalled(); expect(f.reads.heads()).toHaveLength(1);
    } finally { await act(async () => root.unmount()); f.owner.dispose(); container.remove(); }
  });
});
