// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MagicTeaPartyMessage, MagicTeaPartyPreferences, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';
import {
  MagicTeaPartyChatComposer, MagicTeaPartyChatMessage, MagicTeaPartyChatTimeline, MagicTeaPartySummaryBody,
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
  it.each(['raw', 'rendered'] as const)('reads legacy reasoning in %s view without rewriting the message', async outputView => {
    const original = { ...message, meta: { reasoningText: '旧思考原文😀', future: { untouched: true } } };
    const before = JSON.stringify(original);
    await render(<MagicTeaPartyChatMessage message={original} session={session} preferences={preferences} isGenerating={false} outputView={outputView} />);
    await act(async () => button('AI 思考过程').click());
    expect(container.textContent).toContain('旧思考原文😀');
    expect(container.textContent).toContain('来源：未知');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('prefers canonical reasoning over legacy text, including an intentionally unavailable envelope', async () => {
    const original = { ...message, meta: { reasoningText: '旧文本不应覆盖', aiReasoning: { status: 'done', source: 'provider', text: '共享信封正文' } } };
    await render(<MagicTeaPartyChatMessage message={original} session={session} preferences={preferences} isGenerating={false} />);
    await act(async () => button('AI 思考过程').click());
    expect(container.textContent).toContain('共享信封正文'); expect(container.textContent).not.toContain('旧文本不应覆盖');
    await render(<MagicTeaPartyChatMessage message={{ ...original, meta: { ...original.meta, aiReasoning: { status: 'unavailable', source: 'provider' } } }} session={session} preferences={preferences} isGenerating={false} />);
    expect(container.textContent).toContain('该模型未返回可展示思考内容'); expect(container.textContent).not.toContain('旧文本不应覆盖');
  });

  it.each([undefined, '', '  \n ', 42, { text: '不能猜测' }])('does not create a reasoning panel from empty or non-text legacy metadata %j', async reasoningText => {
    await render(<MagicTeaPartyChatMessage message={{ ...message, meta: { reasoningText } }} session={session} preferences={preferences} isGenerating={false} />);
    expect(container.querySelector('.ai-reasoning-panel')).toBeNull();
  });

  it.each([{}, [], { text: 42 }, { status: 'done', source: 'invalid', text: '不可信信封' },
    { status: 'invalid', source: 'provider', text: '不可信信封' }, { status: 'done', source: 'provider', summary: {} },
    { status: 'done', source: 'provider', text: 42 }, { status: 'done', source: 'provider', anomalyFlags: [{}] }])('falls back from malformed canonical reasoning %j without changing archive metadata', async aiReasoning => {
    const original = { ...message, meta: { aiReasoning, reasoningText: '仍可读取的旧思考' } }; const before = JSON.stringify(original);
    await render(<MagicTeaPartyChatMessage message={original} session={session} preferences={preferences} isGenerating={false} />);
    await act(async () => button('AI 思考过程').click());
    expect(container.textContent).toContain('仍可读取的旧思考'); expect(container.textContent).not.toContain('不可信信封');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps the shared summary presentation unchanged even when reasoning is preserved', async () => {
    await render(<MagicTeaPartyChatMessage message={{ ...message, meta: { kind: 'summary', reasoningText: '旧思考', aiReasoning: { status: 'done', source: 'provider', text: '新思考' } } }} session={session} preferences={preferences} isGenerating={false} />);
    expect(container.textContent).toContain('摘要生成记录'); expect(container.querySelector('.ai-reasoning-panel')).toBeNull();
  });

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

  it('gives all six setup controls unique native labels across simultaneous instances', async () => {
    const props = setupProps();
    const panels = () => <><MagicTeaPartySessionSetupPanel key="a" {...props} />
      <MagicTeaPartySessionSetupPanel key="b" {...props} activeSession={{ ...session, id: 's2' }} /></>;
    await render(panels());
    const controls = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')];
    expect(controls).toHaveLength(12); expect(new Set(controls.map(control => control.id)).size).toBe(12);
    const expected = ['角色', '粘贴 / 拖拽导入角色卡（JSON）', '情景', '粘贴 / 拖拽导入情景卡', '扮演方式', '会话标题'];
    for (const [index, control] of controls.entries()) {
      expect(control.id).not.toBe(''); expect(control.labels).toHaveLength(1);
      const label = control.labels![0]; expect(label.textContent).toBe(expected[index % 6]); expect(label.control).toBe(control);
      const activated = vi.fn(); control.addEventListener('click', activated);
      await act(async () => label.click()); expect(activated).toHaveBeenCalledOnce();
      // jsdom forwards native label activation but does not emulate the browser's focus default action.
      await act(async () => control.focus()); expect(document.activeElement).toBe(control);
    }
    const ids = controls.map(control => control.id); await render(panels());
    expect([...container.querySelectorAll('input,textarea,select')].map(control => control.id)).toEqual(ids);
    expect(props.onUpdateTitle).not.toHaveBeenCalled(); expect(props.onUpdatePlayerRole).not.toHaveBeenCalled();
    expect(props.onUploadRoles).not.toHaveBeenCalled(); expect(props.onUploadScenarios).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'readOnly', 'no-session'] as const)('keeps named controls inert when %s', async mode => {
    const props = setupProps(); await render(<MagicTeaPartySessionSetupPanel {...props}
      activeSession={mode === 'no-session' ? null : session} disabled={mode === 'disabled'} readOnly={mode === 'readOnly'} />);
    const controls = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')];
    expect(controls).toHaveLength(6);
    for (const control of controls) {
      expect(control.labels).toHaveLength(1); expect(control.disabled).toBe(true);
      const activated = vi.fn(); control.addEventListener('click', activated);
      await act(async () => { control.labels![0].click(); control.focus(); });
      expect(activated).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(control);
    }
    expect(props.onUpdateTitle).not.toHaveBeenCalled(); expect(props.onUpdatePlayerRole).not.toHaveBeenCalled();
    expect(props.onUploadRoles).not.toHaveBeenCalled(); expect(props.onUploadScenarios).not.toHaveBeenCalled();
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

describe('Tea text-host acknowledgement seams', () => {
  const paste = async (text: string) => {
    const field = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="粘贴角色"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new InputEvent('input', { bubbles: true })); });
    return field;
  };
  it('keeps failed pasted text and clears only the exact successfully accepted version', async () => {
    let settle!: (result: boolean) => void;
    const accept = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
    const props = { ...setupProps(), onImportRolesText: accept, importScope: 'first' };
    await render(<MagicTeaPartySessionSetupPanel {...props} />);
    const field = await paste('{"name":"原文"}');
    await act(async () => button('导入').click());
    expect(button('清空').disabled).toBe(true);
    await act(async () => button('清空').click());
    expect(field.value).toBe('{"name":"原文"}');
    await act(async () => settle(false));
    expect(field.value).toBe('{"name":"原文"}'); expect(container.textContent).toContain('粘贴原文已保留');
    await act(async () => button('导入').click());
    await paste('{"name":"后来输入"}');
    await act(async () => settle(true)); expect(field.value).toBe('{"name":"后来输入"}');
    await act(async () => button('导入').click()); await act(async () => settle(true)); expect(field.value).toBe('');
  });
  it('does not let an old incarnation clear the replacement paste editor', async () => {
    let settle!: (result: boolean) => void;
    const props = { ...setupProps(), onImportRolesText: () => new Promise<boolean>(resolve => { settle = resolve; }) };
    await render(<MagicTeaPartySessionSetupPanel {...props} importScope="one" />);
    await paste('old'); await act(async () => button('导入').click());
    await render(<MagicTeaPartySessionSetupPanel {...props} importScope="two" />);
    const field = await paste('new'); await act(async () => settle(true)); expect(field.value).toBe('new');
  });
  it('can locally clear retained paste without a session and synchronously updates dirty state', async () => {
    const dirty = vi.fn();
    const props = { ...setupProps(), onDirtyChange: dirty };
    await render(<MagicTeaPartySessionSetupPanel {...props} />);
    const roleField = await paste('{"name":"保留角色"}');
    const scenarioField = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="粘贴情景"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(scenarioField, '  ');
      scenarioField.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    const clearButtons = () => [...container.querySelectorAll('button')].filter(node => node.textContent?.trim() === '清空');
    for (const state of [{ disabled: true }, { readOnly: true }]) {
      await render(<MagicTeaPartySessionSetupPanel {...props} {...state} activeSession={null} />);
      expect(clearButtons().every(node => node.matches(':disabled'))).toBe(true);
      await act(async () => { for (const node of clearButtons()) node.click(); });
      expect(roleField.value).toBe('{"name":"保留角色"}'); expect(scenarioField.value).toBe('  ');
    }
    await render(<MagicTeaPartySessionSetupPanel {...props} activeSession={null} />);
    expect(roleField.disabled).toBe(true); expect(scenarioField.disabled).toBe(true);
    expect(clearButtons().every(node => !node.matches(':disabled'))).toBe(true);
    const imports = [...container.querySelectorAll('button')].filter(node => node.textContent?.trim() === '导入');
    expect(imports.every(node => node.disabled)).toBe(true);
    dirty.mockClear();
    await act(async () => {
      for (const node of imports) node.click();
      button('选择角色卡').click(); button('选择情景卡').click(); button('锁定标题').click();
      clearButtons()[0]!.click();
      expect(dirty).toHaveBeenLastCalledWith(true);
    });
    expect(roleField.value).toBe(''); expect(scenarioField.value).toBe('  ');
    await act(async () => { clearButtons()[1]!.click(); expect(dirty).toHaveBeenLastCalledWith(false); });
    expect(scenarioField.value).toBe('');
    expect(props.onImportRolesText).not.toHaveBeenCalled(); expect(props.onImportScenariosText).not.toHaveBeenCalled();
    expect(props.onOpenRoleModal).not.toHaveBeenCalled(); expect(props.onOpenScenarioModal).not.toHaveBeenCalled();
    expect(props.onUpdateRoles).not.toHaveBeenCalled(); expect(props.onUpdateScenarios).not.toHaveBeenCalled();
    expect(props.onUpdatePlayerRole).not.toHaveBeenCalled(); expect(props.onUpdateTitle).not.toHaveBeenCalled();
    expect(props.onLockTitle).not.toHaveBeenCalled();
  });
  it('bounds long rendering while retaining the original message for export', async () => {
    const large = { ...message, content: '😀'.repeat(100), segments: Array.from({ length: 3000 }, () => ({ type: 'narration' as const, text: 'a' })) };
    await render(<MagicTeaPartyChatMessage message={large} session={session} preferences={preferences} isGenerating={false}
      renderBudget={{ segments: 2000, characters: 1000, rawPreviewCharacters: 19 }} />);
    expect(container.textContent).toContain('预览');
    expect(container.querySelectorAll('p').length).toBeLessThan(20);
    expect(/[\uD800-\uDFFF]/u.test(container.textContent ?? '')).toBe(false);
    expect(large.segments).toHaveLength(3000); expect(large.content).toBe('😀'.repeat(100));
  });
  it('counts nested choices and segment text before rendering imported large messages', async () => {
    for (const segments of [[{ type: 'narration' as const, text: '大'.repeat(20000) }], [{ type: 'choices' as const, items: Array.from({ length: 3000 }, (_, i) => ({ id: String(i), text: '小' })) }]]) {
      const value = { ...message, content: '完整正文见导出', segments };
      await render(<MagicTeaPartyChatMessage message={value} session={session} preferences={preferences} isGenerating={false}
        renderBudget={{ segments: 2000, characters: 10000, rawPreviewCharacters: 10000 }} />);
      expect(container.textContent).toContain('内容较长'); expect(container.querySelectorAll('button').length).toBeLessThan(20);
      expect(value.segments).toBe(segments);
    }
  });
  it('counts every actual dialogue label so repeated short dialogue cannot bypass the render budget', async () => {
    const longName = '角色名'.repeat(200);
    for (const useExplicitName of [false, true]) {
      const value: MagicTeaPartyMessage = {
        ...message, content: '完整原文',
        segments: Array.from({ length: 20 }, () => ({ type: 'dialogue' as const, speakerId: 'role-1', text: '好',
          ...(useExplicitName ? { speakerName: longName } : {}) })),
      };
      const roleSession = { ...session, roles: [{ ...session.roles[0]!, name: useExplicitName ? '短名' : longName }] };
      const original = JSON.stringify({ value, roleSession });
      const markdown = vi.fn(() => null);
      await render(<MagicTeaPartyChatMessage message={value} session={roleSession} preferences={preferences} isGenerating={false}
        renderMarkdown={markdown} renderBudget={{ segments: 2000, characters: 10000, rawPreviewCharacters: 1000 }} />);
      expect(container.textContent).toContain('内容较长'); expect(container.textContent).toContain('完整原文');
      expect(container.textContent).not.toContain(longName); expect(markdown).not.toHaveBeenCalled();
      expect(JSON.stringify({ value, roleSession })).toBe(original);
    }
  });
  it('includes the bubble label in the same budget and bounds it on fallback without splitting emoji', async () => {
    const longName = '😀'.repeat(100);
    const roleSession = { ...session, roles: [{ ...session.roles[0]!, name: longName }] };
    const values: MagicTeaPartyMessage[] = [
      { ...message, segments: undefined, choices: undefined, content: '原文', meta: { speakerName: longName } },
      { ...message, role: 'user', speakerId: 'role-1', segments: undefined, choices: undefined, content: '原文' },
    ];
    for (const value of values) {
      const original = JSON.stringify({ value, roleSession });
      await render(<MagicTeaPartyChatMessage message={value} session={roleSession} preferences={preferences} isGenerating={false}
        renderBudget={{ segments: 2000, characters: 30, rawPreviewCharacters: 19 }} />);
      const label = container.firstElementChild?.firstElementChild?.textContent ?? '';
      expect(container.textContent).toContain('内容较长'); expect(container.textContent).toContain('原文');
      expect(label).toBe(`${'😀'.repeat(14)}…`); expect(label.length).toBeLessThanOrEqual(30);
      expect(/[\uD800-\uDFFF]/u.test(label)).toBe(false);
      expect(JSON.stringify({ value, roleSession })).toBe(original);
    }
  });
  it('keeps the original 20 UTF16 name budget without splitting a paired emoji', async () => {
    const onChange = vi.fn();
    await render(<MagicTeaPartyOutputPreferencesPanel activeSession={session} preferences={preferences} onChange={onChange} />);
    const field = container.querySelector<HTMLInputElement>('input[placeholder^="例如"]')!;
    await act(async () => inputValue(field, `${'x'.repeat(19)}😀`));
    expect(onChange).toHaveBeenLastCalledWith({ userDisplayName: 'x'.repeat(19) });
    await act(async () => inputValue(field, '保留\ud800'));
    expect(onChange).toHaveBeenLastCalledWith({ userDisplayName: '保留\ud800' });
  });
});


it('shows an explicitly controlled, initially off additional-request permission even when collapsed', async () => {
  const changed = vi.fn(); const generated = vi.fn();
  const props = { active: true, summary: '', disabled: false, isSummarizing: false, hasMessages: true,
    error: null, description: '摘要', collapsed: true, onCollapsedChange: vi.fn(), onGenerate: generated,
    onClear: vi.fn(), onChange: vi.fn(), onAutoSummaryEnabledChange: changed };
  await render(<MagicTeaPartySummaryBody {...props} />);
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(false);
  expect(container.textContent).toContain('额外请求一次当前模型');
  expect(container.textContent).toContain('原始消息全部保留');
  await act(async () => checkbox.click());
  expect(changed).toHaveBeenCalledWith(true); expect(generated).not.toHaveBeenCalled();
  await render(<MagicTeaPartySummaryBody {...props} autoSummaryEnabled disabled />);
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
});


it('keeps a visible summary stop control available during automatic or manual generation', async () => {
  const stop = vi.fn();
  await render(<MagicTeaPartySummaryBody active summary="旧摘要" disabled isSummarizing hasMessages error={null}
    description="摘要" collapsed onCollapsedChange={vi.fn()} onGenerate={vi.fn()} onClear={vi.fn()} onChange={vi.fn()} onStopSummary={stop} />);
  await act(async () => button('停止摘要').click());
  expect(stop).toHaveBeenCalledOnce(); expect(button('生成/更新摘要').disabled).toBe(true);
});
