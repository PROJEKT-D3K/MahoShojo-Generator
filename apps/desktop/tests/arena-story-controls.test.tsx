// @vitest-environment jsdom
/** Real shared views + device owner + Direct adapter + storage bridge. Synthetic native
 * protocol fixture; never described as Windows/Tauri or a paid-model verification. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopArenaStoryControls } from '../src/features/arena/story-controls';
import { DesktopArenaStorySession } from '../src/features/arena/story-session';
import { prepareStoryStorageCommit } from '../src/platform/arena-story-storage';
import { deferred, installStoryCrypto, StoryFixturePort, storyDraft, storyExecution } from './helpers/story-fixture';
installStoryCrypto();
let root:Root,container:HTMLDivElement,owner:DesktopArenaStorySession;
const button=(text:string)=>[...container.querySelectorAll('button')].find((node)=>node.textContent===text)!;
const click=async(text:string)=>{expect(button(text)).toBeTruthy();await act(async()=>{button(text).click();});};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;container=document.createElement('div');document.body.append(container);root=createRoot(container);HTMLElement.prototype.scrollIntoView=vi.fn();vi.spyOn(window,'scrollTo').mockImplementation(()=>{});vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{act(()=>root.unmount());owner?.dispose();container.remove();vi.restoreAllMocks();});
const mount=async(options:{cardWidthPx?:number|null;draft?:ReturnType<typeof storyDraft>;product?:'battle'|'arena';rawText?:string;beforeTerminal?:()=>Promise<void>;beforeEnd?:()=>Promise<void>;budget?:number;unknown?:boolean;reportPorts?:import('@mahoshojo/ui-web/arena-report').BattleReportHostPorts}={})=>{
 const port=new StoryFixturePort(),execution=storyExecution(options.rawText,options.beforeTerminal),draft=options.draft??storyDraft(),download=vi.fn();let id=0;
 port.hideReceipts=!!options.unknown;port.loseEndReply=!!options.unknown;port.beforeEnd=options.beforeEnd;
 let generation=Promise.resolve();
 owner=new DesktopArenaStorySession({port,id:()=>`ui-${++id}`,exportMarkdown:async()=>({absolutePath:'complete.md',byteLength:10}),...(options.budget===undefined?{}:{prepareCommit:(input)=>prepareStoryStorageCommit(input,options.budget)})});owner.setExecutionScope('A');
 await act(async()=>{root.render(<DesktopArenaStoryControls cardWidthPx={options.cardWidthPx} reportPorts={options.reportPorts} owner={owner} product={options.product} draft={draft} disabled={false} unavailableReason={null} onStart={(chapterPlan)=>{generation=owner.start({draft,product:options.product??'battle',chapterPlan},execution.prepare);}} onContinue={(guidance)=>{generation=owner.continue(guidance,execution.prepare);}} download={download} onNavigateExternal={()=>{}}/>);await owner.initialize();});
 return{port,execution,download,settleGeneration:()=>act(async()=>{await generation;})};
};
describe('continuous-story actual controlled surface',()=>{
 it.each([null, 640, 920])('applies the current display width %s to current and saved chapters without storing it in the story', async cardWidthPx => {
  const { port, execution, settleGeneration } = await mount({ cardWidthPx }); await click('新建连续战报'); await settleGeneration();
  for (const region of ['[aria-label="本次章节结果"]', '[data-story-read-status="loaded"]']) {
   expect(container.querySelector<HTMLElement>(`${region} .result-card`)?.style.maxWidth).toBe(cardWidthPx === null ? '100%' : `${cardWidthPx}px`);
  }
  expect(JSON.stringify(execution.requests)).not.toContain('cardWidth');
  expect(JSON.stringify([...port.documents.values()])).not.toContain('cardWidth');
 });
 it('shares native directory and chapter read errors without automatic retry or losing explicit read actions', async () => {
  const { port, execution, settleGeneration } = await mount(); await click('新建连续战报'); await settleGeneration();
  const head = owner.getSnapshot().active!, writes = port.begin.mock.calls.length;
  const focused = button('刷新故事目录'); focused.focus();
  port.listSessions.mockRejectedValueOnce(new Error('读取目录失败\n保留原目录'));
  await click('刷新故事目录');
  expect(container.querySelector('.error-message[role=alert] .whitespace-pre-wrap')?.textContent).toBe('读取目录失败\n保留原目录');
  expect(document.activeElement).toBe(focused); expect(owner.getSnapshot().sessions).toHaveLength(1);
  await click('刷新故事目录'); expect(container.querySelector('[role=alert]')).toBeNull();
  port.listChapters.mockRejectedValueOnce(new Error('读取章节目录失败'));
  await act(async () => owner.selectSession(head));
  expect(container.querySelector('.error-message[role=alert]')?.textContent).toBe('读取章节目录失败');
  await click('重读章节目录'); expect(container.querySelector('[role=alert]')).toBeNull();
  const gate = deferred<void>();
  port.beforeRead = async descriptor => { if (descriptor.kind === 'chapter') { await gate.promise; throw new Error('读取章节失败\n原章节未改写'); } };
  let read: Promise<void>;
  await act(async () => { read = owner.selectChapter(head.lastChapterId); });
  expect(container.querySelector('[data-story-read-status=loading] [role=status]')?.textContent).toBe('正在读取章节...');
  expect(container.querySelector('[role=alert]')).toBeNull();
  await act(async () => { gate.resolve(); await read!; });
  const error = container.querySelector('[data-story-read-status=error] .error-message[role=alert]')!;
  expect(error.querySelector('.whitespace-pre-wrap')?.textContent).toBe('读取章节失败\n原章节未改写');
  expect(document.activeElement).toBe(focused);
  const reads = port.read.mock.calls.length;
  await act(async () => { await Promise.resolve(); }); expect(port.read).toHaveBeenCalledTimes(reads);
  const retry = button('重试读取本章'); retry.focus(); expect(document.activeElement).toBe(retry);
  port.beforeRead = undefined; await click('重试读取本章');
  expect(container.querySelector('[data-story-read-status=loaded]')?.textContent).toContain('甲与乙继续前行');
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(port.begin).toHaveBeenCalledTimes(writes); expect(execution.requests).toHaveLength(1);
 });
 it('renders actual shared directories and selected loaded body after one explicit request',async()=>{
  const {execution,port,settleGeneration}=await mount();await click('新建连续战报');await settleGeneration();
  expect(container.querySelector('[data-story-read-status="loaded"]')?.textContent).toContain('甲与乙继续前行');
  expect(execution.requests).toHaveLength(1);expect(port.begin).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('共 1 章');await click('继续续写');await settleGeneration();expect(execution.requests).toHaveLength(2);
 });
 it('shows frozen chapter metadata and both current/saved image ports without rereading the edited draft', async () => {
  const draft = storyDraft(); draft.battleMode = 'scenario'; draft.scenario.content = { title: '原情景' };
  const captured: Array<{ text: string | null; logo: string | undefined; maxWidth: string }> = [];
  const saveImage = vi.fn(async (element: HTMLElement) => {
   captured.push({ text: element.textContent, logo: element.querySelector<HTMLElement>('.logo-placeholder')?.style.display, maxWidth: element.style.maxWidth });
  });
  const { execution, settleGeneration } = await mount({ draft, cardWidthPx: 760, reportPorts: { saveImage, generatedBy: <span>已验证用户名</span> } });
  await click('新建连续战报'); await settleGeneration();
  draft.scenario.content = { title: '当前草稿情景' }; draft.settings.userGuidance = '当前草稿引导';
  await act(async () => { await owner.refreshSessions(); });
  for (const region of ['[aria-label="本次章节结果"]', '[data-story-read-status="loaded"]']) {
   const card = container.querySelector(region)!;
   for (const expected of ['actual-model', '首章引导', '原情景', '输入 未提供', '已验证用户名']) expect(card.textContent).toContain(expected);
   expect(card.textContent).not.toContain('当前草稿');
   const image = [...card.querySelectorAll('button')].find(node => node.textContent?.includes('保存为图片'))!;
   await act(async () => image.click());
  }
  expect(saveImage).toHaveBeenCalledTimes(2); expect(execution.requests).toHaveLength(1);
  for (const image of captured) {
   expect(image.text).toContain('已验证用户名'); expect(image.text).toContain('actual-model'); expect(image.logo).toBe('flex'); expect(image.maxWidth).toBe('760px');
  }
 });
 it('reads legacy saved card telemetry without losing false flags or borrowing missing metadata', async () => {
  const { port, execution, settleGeneration } = await mount(); await click('新建连续战报'); await settleGeneration();
  const head = owner.getSnapshot().active!, stored = port.documents.get(`${head.id}:${head.lastChapterId}`)!;
  stored.value.cardSnapshot = { aiModel: '原服务器模型', scenarioDisplayName: '原封存情景', mode: 'scenario',
   userGuidance: '封存引导', narrativeHistoryReadCount: 0,
   aiUsage: { completionTokens: 7, promptTokens: null, reasoningTokens: null, completionTokensIncludesReasoning: false } };
  stored.bytes = Uint8Array.from(new TextEncoder().encode(JSON.stringify(stored.value)));
  await act(async () => { await owner.selectChapter(head.lastChapterId); });
  expect(owner.getSnapshot().selected, JSON.stringify(owner.getSnapshot().selected)).toMatchObject({ status: 'loaded' });
  const read = () => container.querySelector('[data-story-read-status="loaded"]')!.textContent;
  for (const expected of ['原服务器模型', '原封存情景', '封存引导', '输入 未提供', '推理 未提供', '输出 7', '叙事历史读取：0 条']) expect(read()).toContain(expected);
  stored.value.cardSnapshot = { mode: 'daily', scenarioDisplayName: '旧情景不属于本章', aiUsage: { completionTokens: 7, reasoningTokens: null, completionTokensIncludesReasoning: true } };
  stored.bytes = Uint8Array.from(new TextEncoder().encode(JSON.stringify(stored.value)));
  await act(async () => { await owner.selectChapter(head.lastChapterId); });
  expect(read()).toContain('模型：未提供'); expect(read()).toContain('输出 未提供');
  expect(read()).not.toContain('actual-model'); expect(read()).not.toContain('原封存情景'); expect(read()).not.toContain('旧情景不属于本章');
  expect(execution.requests).toHaveLength(1);
 });
 it.each(['failed','cancelled'] as const)('keeps metadata-only raw output visible and exportable after %s with no commit',async(status)=>{
  const raw='<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"仅元数据"}} -->';const gate=deferred<void>();
  const {port,execution,download,settleGeneration}=await mount({rawText:raw,beforeTerminal:()=>gate.promise});
  await click('新建连续战报');await act(async()=>{await vi.waitFor(()=>expect(owner.getSnapshot().result?.rawText).toBe(raw));});
  const focused=button('刷新故事目录');focused.focus();expect(document.activeElement).toBe(focused);
  if(status==='cancelled')await click('停止章节生成');
  await act(async()=>{gate.resolve();});
  await settleGeneration();expect(owner.getSnapshot().phase).toBe(status);
  const message=owner.getSnapshot().message;
  expect(container.querySelector('.error-message[role=alert]')).toBeNull();
  expect([...container.querySelectorAll('[role=status]')].some(node=>node.textContent===message)).toBe(true);
  expect(document.activeElement).toBe(focused);expect(focused.tabIndex).toBe(0);
  expect(owner.getSnapshot().result?.markdown).toBe('');expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain(raw);
  await click('导出完整原始输出');expect(JSON.parse(download.mock.calls.at(-1)![1]).rawText).toBe(raw);
  expect(port.begin).not.toHaveBeenCalled();expect(execution.requests).toHaveLength(1);
  await click('清除本次预览');expect(owner.hasUnsavedResult()).toBe(false);
 });
 it('budget refusal has full-result exports but no deterministic retry affordance or save IPC',async()=>{
  const {port,execution,download,settleGeneration}=await mount({budget:1});await click('新建连续战报');await settleGeneration();
  const pending=container.querySelector('[data-story-pending-outcome]')!;
  expect(pending.textContent).toContain('生成完成，未保存到会话');expect(button('重试本地保存')).toBeUndefined();
  expect([...pending.querySelectorAll('button')].map(node=>node.textContent)).toEqual(['导出未保存章节','导出完整原始输出','丢弃当前结果']);
  const result=owner.getSnapshot().result!;
  await click('导出未保存章节');expect(download.mock.calls.at(-1)![1]).toBe(result.markdown);
  await click('导出完整原始输出');expect(JSON.parse(download.mock.calls.at(-1)![1])).toMatchObject({rawText:result.rawText,reasoning:result.reasoning});
  expect(owner.hasUnsavedResult()).toBe(true);expect(port.begin).not.toHaveBeenCalled();expect(execution.requests).toHaveLength(1);
 });
 it.each(['battle','arena'] as const)('%s shared pending retries the original unwritten package once without another model request',async(product)=>{
  const {port,execution,settleGeneration}=await mount({product});port.failBegin=true;
  await click('新建连续战报');await settleGeneration();
  const original=port.begin.mock.calls[0]![0],pending=container.querySelector('[data-story-pending-outcome]')!;
  expect(owner.getSnapshot().pending).toMatchObject({evidence:'not-written',retryable:true});
  expect([...pending.querySelectorAll('button')].map(node=>node.textContent)).toEqual(['重试本地保存','导出未保存章节','导出完整原始输出','丢弃当前结果']);
  expect([...pending.querySelectorAll('button')].every(node=>node.tabIndex===0)).toBe(true);
  const gate=deferred<void>();port.failBegin=false;port.beforeEnd=()=>gate.promise;
  const save=vi.spyOn(owner,'savePending');
  await act(async()=>{button('重试本地保存').click();button('重试本地保存').click();});
  await act(async()=>{await vi.waitFor(()=>expect(port.end).toHaveBeenCalledTimes(1));});
  expect(pending.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain('正在保存已完成章节');
  expect(button('重试本地保存').disabled).toBe(true);expect(button('丢弃当前结果').disabled).toBe(true);
  expect(port.begin).toHaveBeenCalledTimes(2);expect(port.begin.mock.calls[1]![0]).toBe(original);expect(execution.requests).toHaveLength(1);
  await act(async()=>{gate.resolve();await Promise.all(save.mock.results.map(result=>result.value));});
  expect(container.querySelector('[data-story-pending-outcome]')).toBeNull();
  expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain('已保存');
  expect(owner.getSnapshot()).toMatchObject({pending:null,resultSaved:true,active:{chapterCount:1}});
  expect(port.begin).toHaveBeenCalledTimes(2);expect(execution.requests).toHaveLength(1);
 });
 it('keeps saved-unread recovery outside pending after a manual selection and a failed read',async()=>{
  const {port,execution,settleGeneration}=await mount();await click('新建连续战报');await settleGeneration();
  const first=owner.getSnapshot().active!.lastChapterId,gate=deferred<void>();port.beforeEnd=()=>gate.promise;
  await click('继续续写');await act(async()=>{await vi.waitFor(()=>expect(port.end).toHaveBeenCalledTimes(2));});
  const firstRow=[...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(node=>node.textContent?.startsWith('第 1 章'))!;
  await act(async()=>{firstRow.click();await vi.waitFor(()=>expect(owner.getSnapshot().selected).toMatchObject({status:'loaded',chapterId:first}));gate.resolve();});await settleGeneration();
  const saved=owner.getSnapshot().active!.lastChapterId;
  expect(container.querySelector('[data-story-read-status="loaded"]')?.getAttribute('data-story-chapter-id')).toBe(first);
  expect(container.querySelector('[data-story-pending-outcome]')).toBeNull();expect(button('读取刚保存的章节')).toBeTruthy();
  expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain('本次第 2 章 · 已保存');
  port.beforeRead=async descriptor=>{if(descriptor.kind==='chapter'&&descriptor.recordId===saved)throw new Error('reader temporarily unavailable');};
  const read=vi.spyOn(owner,'readSavedResult');await click('读取刚保存的章节');await act(async()=>{await read.mock.results.at(-1)!.value;});
  expect(container.querySelector('[data-story-read-status="error"]')).toBeTruthy();expect(button('读取刚保存的章节')).toBeTruthy();
  expect(container.querySelector('[data-story-pending-outcome]')).toBeNull();expect(button('重试本地保存')).toBeUndefined();
  port.beforeRead=undefined;await click('读取刚保存的章节');await act(async()=>{await read.mock.results.at(-1)!.value;});
  expect(container.querySelector('[data-story-read-status="loaded"]')?.getAttribute('data-story-chapter-id')).toBe(saved);
  expect(button('读取刚保存的章节')).toBeUndefined();expect(owner.getSnapshot()).toMatchObject({pending:null,savedUnread:null,resultSaved:true});
  expect(port.begin).toHaveBeenCalledTimes(2);expect(execution.requests).toHaveLength(2);
 });
 it('uses the shared long-content guard without mounting giant headings and exports both full copies',async()=>{
  const raw='# '+ '题'.repeat(270000)+'\n\n完整尾文';
  const {execution,download,settleGeneration}=await mount({rawText:raw});await click('新建连续战报');await settleGeneration();
  expect(owner.getSnapshot().resultSaved).toBe(true);
  expect(container.querySelector('[data-story-read-status="loaded"]')).toBeTruthy();expect(execution.requests).toHaveLength(1);
  expect(container.querySelectorAll('[data-story-content-preview]')).toHaveLength(2);
  expect(container.textContent!.length).toBeLessThan(300000); // raw details intentionally retains the original
  expect(container.querySelector('[data-story-read-status="loaded"]')?.textContent!.length).toBeLessThan(1000);
  expect(container.querySelectorAll('h1')).toHaveLength(0);
  await click('导出当前完整正文');expect(download.mock.calls.at(-1)![1]).toBe(raw);
  await click('导出本章完整正文');expect(download.mock.calls.at(-1)![1]).toBe(raw);
 });
 it('unknown UI action is query-only and survives execution scope change',async()=>{
  const endGate=deferred<void>();
  const {port,execution,settleGeneration}=await mount({unknown:true,beforeEnd:()=>endGate.promise});await click('新建连续战报');
  await act(async()=>{await vi.waitFor(()=>expect(port.end).toHaveBeenCalledTimes(1));});
  expect(owner.getSnapshot().saving).toBe(true);expect(container.textContent).toContain('正在保存已完成章节');
  await act(async()=>{endGate.resolve();});await settleGeneration();expect(container.textContent).toContain('保存状态待确认');
  expect(container.querySelector('[data-story-pending-outcome] [role=status][aria-live=polite]')?.textContent).toContain('保存状态待确认');
  expect(container.querySelector('.error-message[role=alert]')).toBeNull();
  const save=vi.spyOn(owner,'savePending');
  await act(async()=>owner.setExecutionScope('signed-out'));await click('查询原保存结果');await act(async()=>{await save.mock.results.at(-1)!.value;});
  expect(save).toHaveBeenCalledTimes(1);expect(container.textContent).toContain('保存状态待确认');expect(port.begin).toHaveBeenCalledTimes(1);expect(execution.requests).toHaveLength(1);
  port.hideReceipts=false;await click('查询原保存结果');await act(async()=>{await save.mock.results.at(-1)!.value;});
  expect(save).toHaveBeenCalledTimes(2);expect(container.textContent).toContain('完整章节已保存到本机故事');expect(port.begin).toHaveBeenCalledTimes(1);
 });
});


const modalButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === text)!;
const modalClick = async (text: string) => { expect(modalButton(text)).toBeTruthy(); await act(async () => { modalButton(text).click(); }); };
describe('whole-session deletion uses the shared controlled modal', () => {
  it.each(['battle', 'arena'] as const)('%s has an explicit safe confirmation and Escape/cancel never delete', async product => {
    const { port, execution, settleGeneration } = await mount({ product });
    expect(button('删除本机会话').disabled).toBe(true);
    await click('新建连续战报'); await settleGeneration(); const head = owner.getSnapshot().active!;
    await click('删除本机会话');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(head.id); expect(dialog?.textContent).toContain('共 1 章');
    expect(dialog?.textContent).toContain('无法在故事页撤销');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭对话框');
    expect(port.deleteSession).not.toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(owner.getSnapshot().active?.id).toBe(head.id);
    await click('删除本机会话'); await modalClick('返回'); expect(port.deleteSession).not.toHaveBeenCalled();
    await click('删除本机会话'); await modalClick('先导出');
    expect(owner.getSnapshot().exportResult?.absolutePath).toBe('complete.md'); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(port.deleteSession).not.toHaveBeenCalled(); expect(execution.requests).toHaveLength(1);
  });
  it('double confirm is one delete; in-flight Escape cannot turn it into another request', async () => {
    const { port, execution, settleGeneration } = await mount(); await click('新建连续战报'); await settleGeneration(); await click('删除本机会话');
    const gate = deferred<void>(); port.beforeDelete = () => gate.promise;
    await act(async () => { const confirm = modalButton('确认删除本机会话'); confirm.click(); confirm.click(); });
    expect(port.deleteSession).toHaveBeenCalledTimes(1);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(owner.getSnapshot().deletion).toBeNull()); });
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).toContain('已删除本机会话');
    expect(owner.getSnapshot().active).toBeNull(); expect(execution.requests).toHaveLength(1);
  });
  it('unknown modal offers only observation and return, and does not silently retry deletion', async () => {
    const { port, execution, settleGeneration } = await mount(); await click('新建连续战报'); await settleGeneration(); await click('删除本机会话');
    port.loseDeleteReply = true; await modalClick('确认删除本机会话');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除状态待确认');
    expect(modalButton('确认删除本机会话')).toBeUndefined(); expect(modalButton('先导出')).toBeUndefined();
    expect(port.deleteSession).toHaveBeenCalledTimes(1); await modalClick('只读核对当前状态');
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).toContain('目前已确认本机会话不存在');
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(port.begin).toHaveBeenCalledTimes(1); expect(execution.requests).toHaveLength(1);
  });
  it.each(['battle', 'arena'] as const)('%s closed unknown keeps an inline read-only exit and only fences A continuation', async product => {
    const { port, execution, settleGeneration } = await mount({ product });
    await click('新建连续战报'); await settleGeneration(); const first = owner.getSnapshot().active!;
    await click('新建连续战报'); await settleGeneration(); const second = owner.getSnapshot().active!;
    await act(async () => { await owner.selectSession(first); });
    await click('删除本机会话'); port.loseDeleteReply = true; await modalClick('确认删除本机会话'); await modalClick('返回');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('删除状态待确认'); expect(button('只读核对当前状态')).toBeTruthy();
    expect(button('继续续写').disabled).toBe(true); expect(button('新建连续战报').disabled).toBe(false);
    await act(async () => { await owner.selectSession(second); });
    expect(button('继续续写').disabled).toBe(false); expect(button('导出完整 Markdown').disabled).toBe(false);
    expect(button('删除本机会话').disabled).toBe(true); expect(button('删除本机会话').title).toContain('只读核对上一个删除');
    await click('继续续写'); await settleGeneration(); expect(owner.getSnapshot().resultSaved).toBe(true); expect(execution.requests).toHaveLength(3);
    await click('只读核对当前状态'); expect(owner.getSnapshot().deletion).toBeNull();
    expect(owner.getSnapshot().active?.id).toBe(second.id); expect(owner.getSnapshot().active?.chapterCount).toBe(2);
    expect(port.deleteSession).toHaveBeenCalledTimes(1); expect(button('删除本机会话').disabled).toBe(false);
  });
  it('a completed but unsaved result keeps the deletion trigger disabled', async () => {
    const { port, execution, settleGeneration } = await mount(); await click('新建连续战报'); await settleGeneration();
    port.failBegin = true; await click('继续续写'); await settleGeneration();
    expect(owner.getSnapshot().pending).not.toBeNull(); expect(button('删除本机会话').disabled).toBe(true);
    await click('删除本机会话'); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(port.deleteSession).not.toHaveBeenCalled(); expect(execution.requests).toHaveLength(2);
  });
});

describe('controlled branch product actions', () => {
  it.each(['battle', 'arena'] as const)('%s cannot dispatch a branch without its host callback', async (product) => {
    const { settleGeneration } = await mount({ product });
    await click('新建连续战报');
    await settleGeneration();
    expect(container.querySelector('[data-story-read-status="loaded"]')).toBeTruthy();
    expect(button('创建分支').disabled).toBe(true);
    expect(button('从第 1 章创建分支').disabled).toBe(true);
    expect('branch' in owner).toBe(false);
  });
});


const changePlanInput = async (value: string) => {
 const field = container.querySelector<HTMLInputElement>('[aria-label="新会话章节规划"] input')!;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
};
describe('Desktop real story owner chapter-planning adapter', () => {
 it.each(['battle', 'arena'] as const)('%s uses shared shortcuts and freezes only the explicit start plan', async product => {
  const { execution, port, settleGeneration } = await mount({ product });
  for (const count of [2, 3, 5, 8, 12]) { await click(`${count} 章`); expect(container.textContent).toContain(`用户设置｜0 / ${count}`); }
  expect(execution.requests).toHaveLength(0); expect(port.begin).not.toHaveBeenCalled();
  await click('5 章'); await click('新建连续战报'); await settleGeneration();
  expect(owner.getSnapshot().active?.chapterPlan).toEqual({ totalChapters: 5, source: 'user', locked: false });
  await click('8 章'); expect(owner.getSnapshot().active?.chapterPlan?.totalChapters).toBe(5);
  expect(execution.requests).toHaveLength(1); expect(port.begin).toHaveBeenCalledOnce();
 });
 it.each(['battle', 'arena'] as const)('%s preserves fixed scenario precedence over shortcuts', async product => {
  const draft = storyDraft(); draft.battleMode = 'scenario';
  draft.scenario = { ...draft.scenario, content: { title: '固定情景', _battle_story: { total_chapters: 4, plan_mode: 'fixed' } } };
  const { execution, settleGeneration } = await mount({ product, draft });
  const panel = container.querySelector('[aria-label="新会话章节规划"]')!;
  expect(panel.textContent).toContain('情景卡固定｜0 / 4');
  for (const item of panel.querySelectorAll('button')) { expect(item.disabled).toBe(true); await act(async () => item.click()); }
  expect(panel.querySelector('input')!.disabled).toBe(true); expect(panel.querySelector('input')!.value).toBe('4');
  expect(execution.requests).toHaveLength(0); await click('新建连续战报'); await settleGeneration();
  expect(owner.getSnapshot().active?.chapterPlan).toEqual({ totalChapters: 4, source: 'scenario', locked: true });
 });
 it('keeps suggested scenario, unlimited and manual input as next-story choices', async () => {
  const draft = storyDraft(); draft.battleMode = 'scenario';
  draft.scenario = { ...draft.scenario, content: { title: '建议情景', _battle_story: { total_chapters: 6, plan_mode: 'suggested' } } };
  const { execution, port, settleGeneration } = await mount({ draft });
  expect(container.textContent).toContain('情景卡建议｜0 / 6');
  await click('不限制'); expect(container.querySelector('[aria-label="新会话章节规划"]')?.textContent).not.toContain('情景卡建议｜');
  await changePlanInput('7'); expect(container.textContent).toContain('用户设置｜0 / 7');
  await click('自动'); expect(container.textContent).toContain('情景卡建议｜0 / 6');
  expect(execution.requests).toHaveLength(0); expect(port.begin).not.toHaveBeenCalled();
  await click('新建连续战报'); await settleGeneration();
  expect(owner.getSnapshot().active?.chapterPlan).toEqual({ totalChapters: 6, source: 'scenario', locked: false });
 });
 it.each(['', '0', '21', '1.5'])('invalid custom input %s keeps start disabled without model or storage writes', async value => {
  const { execution, port } = await mount(); await click('5 章'); await changePlanInput(value);
  expect(container.querySelector('[aria-label="新会话章节规划"] [role=alert]')?.textContent).toContain('1–20');
  expect(button('新建连续战报').disabled).toBe(true); await click('新建连续战报');
  expect(execution.requests).toHaveLength(0); expect(port.begin).not.toHaveBeenCalled();
  await click('不限制'); expect(button('新建连续战报').disabled).toBe(false);
 });
 it('preserves the Desktop busy lock without changing the frozen plan', async () => {
  const gate = deferred<void>(); const { execution, settleGeneration } = await mount({ beforeTerminal: () => gate.promise });
  await click('5 章'); await click('新建连续战报');
  const panel = container.querySelector('[aria-label="新会话章节规划"]')!;
  expect([...panel.querySelectorAll('button')].every(item => item.disabled)).toBe(true);
  expect(panel.querySelector('input')!.disabled).toBe(true); await click('8 章');
  await act(async () => gate.resolve()); await settleGeneration();
  expect(owner.getSnapshot().active?.chapterPlan?.totalChapters).toBe(5); expect(execution.requests).toHaveLength(1);
 });
});
