// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MagicTeaPartyMessage, MagicTeaPartyPreferences, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';
import {
  MagicTeaPartyChatComposer, MagicTeaPartyChatMessage, MagicTeaPartyChatTimeline,
  MagicTeaPartyHero, MagicTeaPartyNoticePanel, MagicTeaPartyOutputPreferencesPanel,
  MagicTeaPartyPageView, MagicTeaPartySessionList, MagicTeaPartySessionSetupPanel,
  MagicTeaPartyTransferPanel, type MagicTeaPartySessionSetupPanelProps, type MagicTeaPartySessionListItem,
} from '../src/magic-tea-party';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preferences: MagicTeaPartyPreferences = {
  outputFormat: 'jsonl', outputPlan: { choices: 'auto', summary: 'off', updates: 'auto' },
  enableChoices: true, choiceCount: 4, language: 'zh-CN', userDisplayName: '旅人',
  enableSummary: true, updateApplyMode: 'auto', readArenaHistory: true, readArenaHistoryLimit: 3,
  isArenaHistoryUnlimited: false, readCurrentState: true, writeArenaHistory: false, writeCurrentState: false,
  tachieCacheMaxPerSession: 10, tachieCacheMaxGlobal: 20, tachieCacheMaxBytes: 1024,
  presetCharacterPanelCollapsed: true, presetScenarioPanelCollapsed: true, sessionRetentionDays: 60, maxSessions: 200,
};
const session: MagicTeaPartySession = {
  id: 's1', title: '星光茶会', createdAt: 1, updatedAt: 2,
  roles: [{ id: 'role-1', name: '星见澪', source: 'local', card: { name: '星见澪' } }],
  scenario: { id: 'scene-1', title: '雨夜', source: 'local', card: { content: '雨夜' } },
  auxScenarios: [], playerRoleId: null,
  settings: { providerId: 'client', modelId: 'synthetic', outputFormat: 'jsonl' },
};
const message: MagicTeaPartyMessage = {
  id: 'm1', sessionId: 's1', role: 'assistant', content: '旁白\n星见澪：你好', createdAt: 3, status: 'done',
  segments: [{ type: 'narration', text: '旁白' }, { type: 'dialogue', speakerId: 'role-1', text: '你好' }, { type: 'choices', items: [{ id: 'choice-1', text: '喝茶' }] }],
  choices: [{ id: 'choice-1', text: '喝茶' }],
};
let container: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
const render = async (node: ReactNode) => act(async () => root.render(node));
const button = (label: string) => {
  const result = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
};
const inputValue = (node: HTMLInputElement, value: string, composing = false) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
};
const setupProps = (): MagicTeaPartySessionSetupPanelProps => ({
  activeSession: session, playerOptions: [{ value: '', label: '旁观者' }, { value: 'role-1', label: '星见澪' }],
  onOpenRoleModal: vi.fn(), onOpenScenarioModal: vi.fn(), onUploadRoles: vi.fn(), onUploadScenarios: vi.fn(),
  onUpdateRoles: vi.fn(), onUpdateScenarios: vi.fn(), onUpdatePlayerRole: vi.fn(), onUpdateTitle: vi.fn(),
  onLockTitle: vi.fn(), onCreateSession: vi.fn(), onImportRolesText: vi.fn(), onImportScenariosText: vi.fn(),
  onDropRoles: vi.fn(), onDropScenarios: vi.fn(),
});
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  frames = new Map(); let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => { frames.set(++frameId, fn); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('controlled Tea views', () => {
  it('shares the actual page columns and chat frame without owning host IO', async () => {
    await render(<MagicTeaPartyPageView
      hero={<MagicTeaPartyHero globalError={null} description="本机文本会话" homeLink={<a href="/">返回首页</a>} />}
      sidebar={<aside data-testid="sidebar">列表</aside>}
      setup={<section data-testid="setup">设置</section>}
      beforeChat={<MagicTeaPartyNoticePanel notices={[{ type: 'notice', level: 'warning', message: '未保存结果' }]} />}
      chat={<><div data-testid="timeline">时间线</div><div data-testid="composer">输入</div></>}
      afterChat={<div>宿主附加区</div>} footer={<footer>页脚</footer>} modals={<dialog>宿主确认</dialog>}
    />);
    expect(container.querySelector('.container')?.className).toBe('container !max-w-[1200px]');
    expect(container.querySelector('main')?.parentElement?.className).toBe('mt-6 grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]');
    expect(container.querySelector('[data-testid="timeline"]')?.parentElement)
      .toBe(container.querySelector('[data-testid="composer"]')?.parentElement);
    expect(container.querySelector('[data-testid="timeline"]')?.parentElement?.className)
      .toBe('rounded-xl border border-pink-100 bg-white p-4');
    expect(container.textContent).toContain('未保存结果');
    expect(container.textContent).not.toContain('本地浏览器');
  });

  it('omits unsupported extra calls and keeps send/continue truly disabled while busy', async () => {
    const send = vi.fn(), next = vi.fn();
    const props = { activeSession: { ...session, settings: { ...session.settings, outputFormat: 'markdown' as const } }, preferences,
      draft: '喝杯茶', onDraftChange: vi.fn(), onSend: send, onContinue: next, isGenerating: false, hasMessages: true, messageCharLimit: 2 };
    await render(<MagicTeaPartyChatComposer {...props} />);
    expect(container.textContent).not.toContain('生成选项');
    expect(container.textContent).not.toContain('额外调用');
    expect(container.textContent).not.toContain('自动保留首尾');
    await act(async () => { button('发送').click(); button('继续生成').click(); });
    expect(send).toHaveBeenCalledExactlyOnceWith('喝杯茶'); expect(next).toHaveBeenCalledTimes(1);
    await render(<MagicTeaPartyChatComposer {...props} disabled />);
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await act(async () => { button('发送').click(); button('继续生成').click(); });
    expect(send).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps title IME completion and does not leak the prior title across session switches', async () => {
    const props = setupProps(); await render(<MagicTeaPartySessionSetupPanel {...props} />);
    const title = container.querySelector<HTMLInputElement>('input[placeholder="输入会话标题"]')!;
    await act(async () => { title.focus(); title.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); inputValue(title, '新标题', true); });
    expect(props.onUpdateTitle).not.toHaveBeenCalled();
    await act(async () => title.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    expect(props.onUpdateTitle).toHaveBeenCalledExactlyOnceWith('新标题');
    await act(async () => title.blur()); expect(props.onUpdateTitle).toHaveBeenCalledTimes(1);
    await render(<MagicTeaPartySessionSetupPanel {...props} activeSession={{ ...session, id: 's2', title: '第二场' }} />);
    expect(title.value).toBe('第二场');
    await act(async () => { title.focus(); title.blur(); });
    expect(props.onUpdateTitle).toHaveBeenCalledTimes(1);
  });

  it('uses text-only file capability and read-only blocks drop, delete and title writes', async () => {
    const props = setupProps(); await render(<MagicTeaPartySessionSetupPanel {...props} readOnly />);
    const files = [...container.querySelectorAll<HTMLInputElement>('input[type=file]')];
    expect(files.map((node) => node.accept)).toEqual(['.json', '.json']);
    expect(container.textContent).not.toContain('PNG');
    expect([...container.querySelectorAll('input,select,textarea,button')].every((node) => node.matches(':disabled'))).toBe(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['{}'], 'role.json')] } });
    const zone = [...container.querySelectorAll('div')].find((node) => node.className.includes('border-dashed') && node.textContent?.includes('导入角色卡'))!;
    await act(async () => { zone.dispatchEvent(drop); button('移除主情景').click(); });
    expect(props.onDropRoles).not.toHaveBeenCalled(); expect(props.onUpdateScenarios).not.toHaveBeenCalled();
  });

  it('shows only supported output preferences, with the original controls enabled by Web capability', async () => {
    const change = vi.fn(); await render(<MagicTeaPartyOutputPreferencesPanel activeSession={session} preferences={preferences} onChange={change} />);
    expect(container.textContent).not.toContain('合并输出计划');
    expect(container.textContent).not.toContain('额外调用');
    await act(async () => button('+').click()); expect(change).toHaveBeenCalledExactlyOnceWith({ choiceCount: 5 });
    await render(<MagicTeaPartyOutputPreferencesPanel activeSession={session} preferences={preferences} onChange={change} outputPlanSupported choicesHint="Web 额外选项调用" />);
    expect(container.textContent).toContain('合并输出计划'); expect(container.textContent).toContain('摘要');
    expect(container.textContent).toContain('更新草案'); expect(container.textContent).toContain('Web 额外选项调用');
  });

  it('keeps loaded-page search honest and hides pin/merge operations without capability', async () => {
    const select = vi.fn();
    const sessions: MagicTeaPartySessionListItem[] = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`, title: `茶会${i}`, updatedAt: 2, roles: [{ name: '星见澪' }],
      ...(i === 1 ? { forkedFrom: { sessionId: 's0' } } : {}),
    }));
    await render(<MagicTeaPartySessionList sessions={sessions} activeSessionId="s1" onCreateSession={vi.fn()}
      onSelectSession={select} onDeleteSession={vi.fn()} pinnedCollapsed={false} recentCollapsed={false}
      onPinnedCollapsedChange={vi.fn()} onRecentCollapsedChange={vi.fn()} listScope="loaded" pagination={<button>读取更多</button>} />);
    expect(container.textContent).toContain('已加载 13 个会话'); expect(container.textContent).not.toContain('共 13');
    expect([...container.querySelectorAll('button')].filter((node) => node.textContent === '置顶')).toHaveLength(0);
    expect(container.textContent).not.toContain('合并到原会话');
    expect(container.textContent).not.toContain('返回原会话');
    expect([...container.querySelectorAll('button')].filter((node) => node.textContent === '删除')).toHaveLength(10);
    await act(async () => button('下一页').click());
    expect([...container.querySelectorAll('button')].filter((node) => node.textContent === '删除')).toHaveLength(3);
    const search = container.querySelector<HTMLInputElement>('input')!;
    expect(search.placeholder).toContain('已加载');
    await act(async () => inputValue(search, '茶会12'));
    expect(container.textContent).toContain('已加载 1 个会话');
    await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith('茶会12'))!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith('s12');
  });

  it('keeps ZIP labels and callback absent for the text transfer host', async () => {
    const current = vi.fn(), jsonl = vi.fn(), imported = vi.fn();
    const props = { activeTitle: session.title, busy: false, error: null, notice: null, onImportFile: imported, onExportSession: current, onExportSessionJsonl: jsonl };
    await render(<MagicTeaPartyTransferPanel {...props} />);
    expect(container.textContent).not.toContain('ZIP'); expect(container.textContent).toContain('当前会话：星光茶会');
    await act(async () => button('展开').click());
    expect(container.textContent).not.toContain('ZIP'); expect(container.textContent).not.toContain('导出全部');
    await act(async () => { button('导出当前会话（JSON）').click(); button('导出当前会话（SillyTavern JSONL）').click(); });
    expect(current).toHaveBeenCalledTimes(1); expect(jsonl).toHaveBeenCalledTimes(1);
    await render(<MagicTeaPartyTransferPanel {...props} busy />);
    expect(container.querySelector('input')?.matches(':disabled')).toBe(true);
    await act(async () => button('导出当前会话（JSON）').click()); expect(current).toHaveBeenCalledTimes(1);
  });

  it('renders real JSONL dialogue/choices without fabricating message tools', async () => {
    await render(<MagicTeaPartyChatMessage message={message} session={session} preferences={preferences} isGenerating={false} />);
    expect(container.textContent).toContain('星见澪'); expect(container.textContent).toContain('旁白'); expect(container.textContent).toContain('喝茶');
    expect(container.querySelector('button')).toBeNull();
    const choose = vi.fn(); await render(<MagicTeaPartyChatMessage message={message} session={session} preferences={preferences} isGenerating={false} onSelectChoice={choose} />);
    await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('喝茶'))!.click());
    expect(choose).toHaveBeenCalledExactlyOnceWith('喝茶');
  });

  it('does not load Markdown media or attachment URLs without host render ports', async () => {
    await render(<MagicTeaPartyChatMessage message={{ ...message, segments: undefined, choices: undefined, content: '正文 ![图](https://media.invalid/image.png)', tachieId: 'image-1' }}
      session={{ ...session, settings: { ...session.settings, outputFormat: 'markdown' } }} preferences={preferences} isGenerating={false} />);
    expect(container.querySelector('img,video,audio,iframe')).toBeNull();
    expect(container.textContent).toContain('正文');
  });

  it('keeps host message rendering and never drags a reader away from older messages', async () => {
    const host = vi.fn((props: { message: MagicTeaPartyMessage }) => <article>{props.message.content}</article>);
    const props = { activeSession: session, preferences, isGenerating: false, outputView: 'rendered' as const, onOutputViewChange: vi.fn(), renderMessage: host };
    await render(<MagicTeaPartyChatTimeline {...props} messages={[message]} />);
    expect(host).toHaveBeenCalled(); expect(container.querySelector('article')?.textContent).toBe(message.content);
    const scroll = container.querySelector<HTMLDivElement>('.overflow-y-auto')!;
    const scrollTo = vi.fn(); Object.defineProperty(scroll, 'scrollTo', { value: scrollTo });
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 400 }, scrollTop: { value: 0, writable: true } });
    frames.clear(); await act(async () => scroll.dispatchEvent(new Event('scroll')));
    await render(<MagicTeaPartyChatTimeline {...props} messages={[message, { ...message, id: 'm2', content: '新消息' }]} />);
    expect(frames.size).toBe(0); expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith('回到最新'))!.click());
    await act(async () => { for (const fn of frames.values()) fn(1); frames.clear(); });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1200, behavior: 'smooth' });
  });
});
