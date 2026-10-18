// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomGenerationResult, type RoomGenerationView } from '../src/arena-room';

const preview: RoomGenerationView = {
  phase: 'running', markdown: '仅供报告组件消费的正文', gap: null,
  finalAuthoritative: false, generationRecordId: null, errorCode: null,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = async (generation: RoomGenerationView, props: Partial<Parameters<typeof RoomGenerationResult>[0]> = {}) => {
  await act(async () => root.render(<RoomGenerationResult generation={generation} report={<article>宿主报告</article>} {...props} />));
};

describe('shared current room generation result', () => {
  it('renders the host report once, retains its section style/ref, and does not duplicate the body', async () => {
    const resultRef = createRef<HTMLElement>();
    await render(preview, { resultRef });
    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(container.textContent).toContain('实时生成中');
    expect(container.textContent).not.toContain(preview.markdown);
    expect(resultRef.current).toBe(container.querySelector('section'));
    expect(resultRef.current?.className).toBe('rounded-xl border border-fuchsia-200 bg-white/80 p-4 dark:border-fuchsia-900 dark:bg-gray-900/70');
    expect(container.querySelector('h3')?.id).toBe('arena-room-generation-heading');
  });

  it('does not render the report for idle-empty or unknown, even when stale preview exists', async () => {
    const report = vi.fn(() => <article>不应挂载</article>);
    const Report = report;
    await render({ ...preview, phase: 'idle', markdown: '' }, { report: <Report /> });
    expect(container.childElementCount).toBe(0);
    await render({ ...preview, phase: 'unknown' }, { report: <Report /> });
    expect(container.textContent).toContain('正在确认生成状态');
    expect(container.textContent).toContain('请暂时不要再次点击开始');
    expect(report).not.toHaveBeenCalled();
  });

  it('does not promote completed preview into an authoritative report', async () => {
    await render({ ...preview, phase: 'completed', generationRecordId: 'record-1' });
    expect(container.textContent).toContain('正在确认战报');
    expect(container.textContent).not.toContain('战报已完成');
    expect(container.textContent).not.toContain('最终内容已从生成记录恢复并核验');
    await render({ ...preview, phase: 'completed', finalAuthoritative: true, generationRecordId: 'record-1' });
    expect(container.textContent).toContain('战报已完成');
    expect(container.textContent).toContain('最终内容已从生成记录恢复并核验');
  });

  it('keeps provider failure, missing preview and read recovery separate; retry runs only on click', async () => {
    const onRetry = vi.fn();
    await render({ ...preview, phase: 'failed', errorCode: 'ARENA_PROVIDER_UNKNOWN',
      recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT', gap: { expectedChunkSeq: 2, receivedChunkSeq: 3 } }, { onRetry });
    expect(container.textContent).toContain('模型服务配置无效');
    expect(container.textContent).toContain('检测到战报内容有缺失');
    expect(container.textContent).toContain('暂时无法同步战报，请稍后重新同步');
    expect(container.querySelector('[role="alert"]')?.getAttribute('data-generation-error-code')).toBe('ARENA_PROVIDER_UNKNOWN');
    expect(onRetry).not.toHaveBeenCalled();
    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('重新同步战报');
    await act(async () => retry!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: 'resyncing' as const, recoveryCode: 'ROOM_GENERATION_RECOVERY_TRANSIENT' },
    { phase: 'unavailable' as const, recoveryCode: 'ROOM_GENERATION_RECOVERY_NOT_FOUND' },
  ])('does not offer retry during $phase / $recoveryCode', async state => {
    const onRetry = vi.fn();
    await render({ ...preview, ...state, markdown: '' }, { onRetry });
    expect(container.querySelector('button')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('allows explicit protocol recovery but honors host busy/authority restrictions', async () => {
    const generation = { ...preview, phase: 'unavailable' as const, recoveryCode: 'ROOM_GENERATION_RECOVERY_PROTOCOL' };
    const onRetry = vi.fn();
    await render(generation, { onRetry });
    expect(container.querySelector('button')).not.toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    await render(generation, { onRetry, retryDisabled: true });
    expect(container.querySelector('button')).toBeNull();
    await render(generation);
    expect(container.querySelector('button')).toBeNull();
    await act(async () => root.render(null));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('preserves legacy recovery error fields without presenting them as provider failures', async () => {
    await render({ ...preview, phase: 'unavailable', markdown: '', errorCode: 'ROOM_GENERATION_RECOVERY_NOT_FOUND' });
    expect(container.textContent).toContain('当前房间已不再生成这份战报');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('等待服务器发布战报内容');
  });
});
