// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BattleReportCard, StreamingBattleReportCard, type NewsReport } from '../src/arena-report';
const report: NewsReport = { headline: '标题', reporterInfo: { name: '记者', publication: '日报' }, article: { body: '![图](https://i.imgur.com/a.png)', analysis: '分析' }, officialReport: { winner: '角色', conclusion: '结束' } };
describe('shared report capabilities', () => {
  it('has no implicit media/auth/export host and supports a real stream stop without image capability', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<BattleReportCard report={report} showImageAction />));
      expect(container.querySelector('img[src="https://i.imgur.com/a.png"]')).toBeNull();
      expect(container.querySelector('.buttons-container')).toBeNull();
      expect(container.textContent).not.toContain('生成者');
      const stop = vi.fn(); const download = vi.fn();
      await act(async () => root.render(<StreamingBattleReportCard content={"# 流式\n正文"} isStreaming onStopGeneration={stop} ports={{ downloadMarkdown: download }} />));
      const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!;
      await act(async () => button('停止生成').click()); expect(stop).toHaveBeenCalledOnce();
      await act(async () => button('下载记录').click()); expect(download).toHaveBeenCalledWith('# 流式\n正文', '魔法少女速报_流式.md');
      await act(async () => root.render(<StreamingBattleReportCard content={"# 流式\n正文"} />));
      expect(container.querySelector('.buttons-container')).toBeNull();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});

describe('完整报告导出展示契约', () => {
  it('安全内嵌内容沿用共享品牌和真实元数据，仅显式拥有页头的 Web 文档避免重复', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'), root = createRoot(container);
    const content = <pre>&lt;script&gt;安全源码&lt;/script&gt;</pre>;
    try {
      await act(async () => root.render(<StreamingBattleReportCard content="安全源码" reportContent={content} disableExport
        aiModel="actual-web-model" aiUsage={{ promptTokens: 12, completionTokens: 8, reasoningTokens: 2 }} />));
      expect(container.textContent).toContain('模型：actual-web-model');
      expect(container.textContent).toContain('输入 12｜推理 2｜输出 6');
      expect(container.querySelectorAll('img[src="/arena-white.svg"]')).toHaveLength(1);
      expect(container.textContent!.indexOf('模型：')).toBeLessThan(container.textContent!.indexOf('安全源码'));
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('.buttons-container')).toBeNull();
      await act(async () => root.render(<StreamingBattleReportCard content="安全源码" reportContent={content} disableExport />));
      expect(container.textContent).toContain('模型：未提供');
      expect(container.textContent).toContain('输入 未提供｜推理 未提供｜输出 未提供');
      await act(async () => root.render(<StreamingBattleReportCard content="安全源码" reportContent={content} reportContentIncludesHeader disableExport
        aiModel="actual-web-model" reporterInfo={{ name: '记者', publication: '日报' }} narrativeHistoryReadCount={2} />));
      expect(container.textContent).not.toContain('模型：');
      expect(container.querySelector('img[src="/arena-white.svg"]')).toBeNull();
      expect(container.textContent).toContain('记者 | 记者');
      expect(container.textContent).toContain('叙事历史读取：2 条');
    } finally { await act(async () => root.unmount()); }
  });
  it.each(['streaming', 'structured'] as const)('%s 显示真实模型/Tokens；图片捕获带署名/Logo，不带思考和操作栏，失败恢复', async kind => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const fail = vi.fn(); let release: (() => void) | undefined;
    const save = vi.fn(async (element: HTMLElement) => {
      expect(element.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('flex');
      expect(element.querySelector('.logo-placeholder')?.textContent).toContain('验收用户名');
      expect(element.querySelector('.logo-placeholder img')?.getAttribute('src')).toBe('/logo-white-qrcode.svg');
      expect(element.querySelector<HTMLElement>('.buttons-container')?.style.display).toBe('none');
      expect(element.querySelector<HTMLElement>('.ai-reasoning-panel')?.style.display).toBe('none');
      await new Promise<void>(resolve => { release = resolve; }); throw new Error('synthetic capture failure');
    });
    const ports = { saveImage: save, onImageSaveError: fail, generatedBy: <span>验收用户名</span> };
    const usage = { promptTokens: 10, completionTokens: 20, reasoningTokens: 3 };
    const reasoning = { status: 'done' as const, source: 'provider' as const, text: '不得进入保存图的思考原文' };
    try {
      await act(async () => root.render(kind === 'streaming'
        ? <StreamingBattleReportCard content="# 标题\n正文" aiModel="actual-model" aiUsage={usage} aiReasoning={reasoning} ports={ports} />
        : <BattleReportCard report={{ ...report, aiModel: 'actual-model', aiUsage: usage, aiReasoning: reasoning }} ports={ports} />));
      expect(container.textContent).toContain('模型：actual-model'); expect(container.textContent).toContain('输入 10｜推理 3｜输出 17');
      const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('保存为图片'))!;
      await act(async () => button.click());
      expect(save).toHaveBeenCalledOnce(); expect(button.disabled).toBe(true);
      await act(async () => { button.click(); release!(); });
      expect(save).toHaveBeenCalledOnce(); expect(fail).toHaveBeenCalledOnce();
      expect(container.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('none');
      expect(container.querySelector<HTMLElement>('.buttons-container')?.style.display).toBe('flex');
      expect(container.querySelector<HTMLElement>('.ai-reasoning-panel')?.style.display).toBe('');
      expect(button.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it('缺失 Tokens 不显示估算或零，明确 visible-output 标记保留服务端语义', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'), root = createRoot(container);
    try {
      await act(async () => root.render(<StreamingBattleReportCard content="正文" aiUsage={{ completionTokens: 20 }} />));
      expect(container.textContent).toContain('模型：未提供'); expect(container.textContent).toContain('输入 未提供｜推理 未提供｜输出 未提供');
      await act(async () => root.render(<StreamingBattleReportCard content="正文" aiUsage={{ completionTokens: 20, completionTokensIncludesReasoning: false, reasoningTokens: 0 }} />));
      expect(container.textContent).toContain('输入 未提供｜推理 0｜输出 20');
    } finally { await act(async () => root.unmount()); }
  });
});
