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
const mount=async(options:{product?:'battle'|'arena';rawText?:string;beforeTerminal?:()=>Promise<void>;beforeEnd?:()=>Promise<void>;budget?:number;unknown?:boolean}={})=>{
 const port=new StoryFixturePort(),execution=storyExecution(options.rawText,options.beforeTerminal),draft=storyDraft(),download=vi.fn();let id=0;
 port.hideReceipts=!!options.unknown;port.loseEndReply=!!options.unknown;port.beforeEnd=options.beforeEnd;
 let generation=Promise.resolve();
 owner=new DesktopArenaStorySession({port,id:()=>`ui-${++id}`,exportMarkdown:async()=>({absolutePath:'complete.md',byteLength:10}),...(options.budget===undefined?{}:{prepareCommit:(input)=>prepareStoryStorageCommit(input,options.budget)})});owner.setExecutionScope('A');
 await act(async()=>{root.render(<DesktopArenaStoryControls owner={owner} product={options.product} draft={draft} disabled={false} unavailableReason={null} onStart={(chapterPlan)=>{generation=owner.start({draft,product:options.product??'battle',chapterPlan},execution.prepare);}} onContinue={(guidance)=>{generation=owner.continue(guidance,execution.prepare);}} download={download} onNavigateExternal={()=>{}}/>);await owner.initialize();});
 return{port,execution,download,settleGeneration:()=>act(async()=>{await generation;})};
};
describe('continuous-story actual controlled surface',()=>{
 it('renders actual shared directories and selected loaded body after one explicit request',async()=>{
  const {execution,port,settleGeneration}=await mount();await click('新建连续战报');await settleGeneration();
  expect(container.querySelector('[data-story-read-status="loaded"]')?.textContent).toContain('甲与乙继续前行');
  expect(execution.requests).toHaveLength(1);expect(port.begin).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('共 1 章');await click('继续续写');await settleGeneration();expect(execution.requests).toHaveLength(2);
 });
 it.each(['failed','cancelled'] as const)('keeps metadata-only raw output visible and exportable after %s with no commit',async(status)=>{
  const raw='<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"仅元数据"}} -->';const gate=deferred<void>();
  const {port,execution,download,settleGeneration}=await mount({rawText:raw,...(status==='cancelled'?{beforeTerminal:()=>gate.promise}:{})});
  await click('新建连续战报');await act(async()=>{await vi.waitFor(()=>expect(owner.getSnapshot().result?.rawText).toBe(raw));});
  if(status==='cancelled'){await click('停止章节生成');await act(async()=>{gate.resolve();});}
  await settleGeneration();expect(owner.getSnapshot().phase).toBe(status);
  expect(owner.getSnapshot().result?.markdown).toBe('');expect(container.querySelector('[aria-label="本次章节结果"]')?.textContent).toContain(raw);
  await click('导出完整原始输出');expect(JSON.parse(download.mock.calls.at(-1)![1]).rawText).toBe(raw);
  expect(port.begin).not.toHaveBeenCalled();expect(execution.requests).toHaveLength(1);
  await click('清除本次预览');expect(owner.hasUnsavedResult()).toBe(false);
 });
 it('budget refusal has full-result exports but no deterministic retry affordance or save IPC',async()=>{
  const {port,execution,download,settleGeneration}=await mount({budget:1});await click('新建连续战报');await settleGeneration();
  expect(container.textContent).toContain('生成完成，未保存到会话');expect(button('重试本地保存')).toBeUndefined();
  await click('导出未保存章节');expect(download.mock.calls.at(-1)![1]).toContain('甲与乙');expect(port.begin).not.toHaveBeenCalled();expect(execution.requests).toHaveLength(1);
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
