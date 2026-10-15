// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTavernGeneralCharacter, isTavernGeneralScenario, getTavernMagicalGirlPreview, getTavernProjectionTitle, getTavernProjectionCardType, isTavernStructuredScenario, TavernTemplateSelector, TAVERN_LOCAL_IMPORT_TEMPLATES, TavernCandidateSelector, TavernFileInput, TavernLocalProjection, TavernOriginalExport, TavernLocalSources, useTavernSourceSelection, readTavernFile } from '../src/tavern';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { convertTavernToCanshouCard, convertTavernToGeneralCard, convertTavernToGeneralScenarioCard, MAX_TAVERN_TEXT_BYTES, MAX_TAVERN_FILE_BYTES, type TavernCardCandidate } from '@mahoshojo/domain/tavern-card';
let root: Root; let container: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const candidate: TavernCardCandidate = { keyword: 'json', chunkType: 'tEXt', parseMethod: 'json', parsed: { name: '未知/角色', description: '中文', extension: { keep: true } } };
describe('shared Tavern original journey controls', () => {
  it('supports PNG/JSON and repeated selection of the same file', () => {
    const select = vi.fn(); act(() => root.render(<TavernFileInput onFileSelected={select} />));
    const input = container.querySelector('input')!; expect(input.accept).toContain('.json');
    const file = new File(['{}'], 'same.json'); Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(select).toHaveBeenCalledTimes(2); expect(input.value).toBe('');
  });
  it('keeps candidate selection controlled and disabled during a host operation', () => {
    const select = vi.fn(); act(() => root.render(<TavernCandidateSelector candidates={[candidate, { ...candidate, keyword: 'chara' }]} selectedIndex={0} onSelect={select} disabled />));
    expect([...container.querySelectorAll('input')].every((input) => input.disabled)).toBe(true);
    expect(container.querySelector('input')!.checked).toBe(true);
  });
  it('keeps template selection controlled and limited to host-supported choices', () => {
    const onChange = vi.fn();
    act(() => root.render(<TavernTemplateSelector value="general" templates={TAVERN_LOCAL_IMPORT_TEMPLATES} onChange={onChange} />));
    const select = container.querySelector('select')!;
    expect(container.querySelector('label')!.htmlFor).toBe(select.id);
    act(() => { select.value = 'general-scenario'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('general-scenario');
    act(() => root.render(<TavernTemplateSelector value="general-scenario" templates={TAVERN_LOCAL_IMPORT_TEMPLATES} onChange={onChange} disabled />));
    expect(select.value).toBe('general-scenario'); expect(select.disabled).toBe(true);
    act(() => { select.value = 'general'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('uses scenario titles for export names and hides old character save notices after a template switch', async () => {
    let resolve!: (result: 'saved') => void;
    const save = vi.fn(() => new Promise<'saved'>((done) => { resolve = done; })); const exportFile = vi.fn();
    const character = convertTavernToGeneralCard(candidate); const scenario = convertTavernToGeneralScenarioCard(candidate);
    act(() => root.render(<TavernLocalProjection data={character} exportFile={exportFile} saveCard={save} />));
    act(() => container.querySelectorAll('button')[1].click());
    act(() => root.render(<TavernLocalProjection data={scenario} exportFile={exportFile} saveCard={save} />));
    await act(async () => resolve('saved')); expect(container.textContent).not.toContain('已保存到本地卡库');
    expect(container.textContent).toContain('通用情景（规则映射）');
    await act(async () => container.querySelector('button')!.click());
    expect(exportFile.mock.calls[0][0].name).toBe('未知_角色.json');
    expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls[0][0].bytes))).toEqual(scenario);
  });
  it('exports structured scenario JSON independently of its Markdown preview and reports save failures without dropping raw', async () => {
    const data = { title: '结构/情景', elements: { events: '正文' }, _tavern: { raw: candidate.parsed } };
    const exportFile = vi.fn(); const save = vi.fn().mockRejectedValue(new Error('disk full'));
    expect(isTavernStructuredScenario(data)).toBe(true); expect(isTavernStructuredScenario({ ...data, elements: [] })).toBe(false);
    expect(getTavernProjectionTitle(data)).toBe(data.title); expect(getTavernProjectionCardType(data)).toBe('scenario');
    act(() => root.render(<TavernLocalProjection conversionMode="ai" data={data} exportFile={exportFile} saveCard={save} />));
    expect(container.textContent).toContain('结构化情景（AI 深度转换）');
    await act(async () => container.querySelectorAll('button')[1].click()); expect(container.textContent).toContain('disk full');
    await act(async () => container.querySelector('button')!.click());
    expect(exportFile.mock.calls[0][0].name).toBe('结构_情景.json');
    expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls[0][0].bytes))).toEqual(data);
  });
  it('isolates late saves across all three projections and describes the Canshou loss accurately', async () => {
    let resolve!: (result: 'saved') => void;
    const save = vi.fn(() => new Promise<'saved'>((done) => { resolve = done; })); const exportFile = vi.fn();
    const projections = [convertTavernToGeneralCard(candidate), convertTavernToGeneralScenarioCard(candidate), convertTavernToCanshouCard(candidate)];
    for (let index = 0; index < projections.length; index++) {
      const data = projections[index]; const next = projections[(index + 1) % projections.length];
      act(() => root.render(<TavernLocalProjection data={data} exportFile={exportFile} saveCard={save} />));
      act(() => container.querySelectorAll('button')[1].click());
      act(() => root.render(<TavernLocalProjection data={next} exportFile={exportFile} saveCard={save} />));
      await act(async () => resolve('saved')); expect(container.textContent).not.toContain('已保存到本地卡库');
    }
    const data = projections[2];
    act(() => root.render(<TavernLocalProjection data={data} exportFile={exportFile} saveCard={save} />));
    expect(container.textContent).toContain('残兽（保守规则映射）'); expect(container.textContent).toContain('开场白与标签不进入残兽正文');
    expect(container.textContent).not.toContain('正文仅映射描述、性格、场景、开场白');
    await act(async () => container.querySelector('button')!.click());
    expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls[0][0].bytes))).toEqual(data);
    expect(exportFile.mock.calls[0][0].name).toBe('未知_角色.json');
  });
  it('reads retained scenario originals but keeps the character export picker character-only', async () => {
    const character = { id: 'character', cardType: 'character', title: '角色', data: convertTavernToGeneralCard(candidate) };
    const scenario = { id: 'scenario', cardType: 'scenario', title: '情景', data: convertTavernToGeneralScenarioCard(candidate) };
    const tombstone = { ...scenario, id: 'deleted', title: '已删除', deletedAt: '2026-10-01T00:00:00Z' };
    const structured = { id: 'structured', cardType: 'scenario', title: '结构化情景', data: { title: '场景', elements: {}, _tavern: { raw: candidate.parsed } } };
    const list = vi.fn(async () => ({ items: [character, scenario, tombstone, structured] }));
    const get = vi.fn(async () => scenario);
    const repository = { list, get } as unknown as CardRepository; const onSource = vi.fn();
    function Harness({ mode = 'original' }: { mode?: 'original' | 'character' }) { const selection = useTavernSourceSelection(); return <TavernLocalSources repository={repository} selection={selection} onSource={onSource} mode={mode} />; }
    act(() => root.render(<Harness />)); await act(async () => container.querySelector('button')!.click());
    expect(list).toHaveBeenLastCalledWith({ cardTypes: ['character', 'scenario'], limit: 100 });
    expect(container.textContent).not.toContain('已删除'); expect(container.textContent).toContain('结构化情景');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '情景')!.click());
    expect(JSON.parse(new TextDecoder().decode(await onSource.mock.calls[0][0].arrayBuffer()))).toEqual(scenario.data);
    get.mockResolvedValueOnce(tombstone);
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '情景')!.click());
    expect(onSource).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('已不可用');
    act(() => root.render(<Harness key="character" mode="character" />)); await act(async () => container.querySelector('button')!.click());
    expect(list).toHaveBeenLastCalledWith({ cardTypes: ['character'], limit: 100 });
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '情景')).toBe(false);
  });
  it('exports semantic original JSON with correct extension and reports dispatch, not confirmed filesystem save', async () => {
    const exportFile = vi.fn(); act(() => root.render(<TavernOriginalExport candidate={candidate} exportFile={exportFile} />));
    await act(async () => container.querySelector('button')!.click());
    expect(exportFile.mock.calls[0][0].name).toMatch(/\.json$/); expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls[0][0].bytes))).toEqual(candidate.parsed);
    expect(container.textContent).toContain('已发起下载'); expect(container.textContent).toContain('统一为所选候选');
  });
  it('single-flights local writes and hides late results from a previous selected source', async () => {
    let resolve!: (result: 'saved') => void; const save = vi.fn(() => new Promise<'saved'>((done) => { resolve = done; }));
    const data = convertTavernToGeneralCard(candidate); const next = { ...data, name: 'next' };
    act(() => root.render(<TavernLocalProjection data={data} exportFile={vi.fn()} saveCard={save} />));
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes('保存通用卡'))!;
    act(() => { button.click(); button.click(); }); expect(save).toHaveBeenCalledTimes(1);
    act(() => root.render(<TavernLocalProjection data={next} exportFile={vi.fn()} saveCard={save} />));
    await act(async () => resolve('saved')); expect(container.textContent).not.toContain('已保存到本地卡库');
  });
  it('ignores an earlier delayed library read after a newer file intent and discloses unreadable rows', async () => {
    let resolve!: (item: unknown) => void;
    const item = { id: 'card-a', cardType: 'character', title: 'Card A', data: { _tavern: { raw: candidate.parsed } } };
    const repository = { list: async () => ({ items: [item], unreadable: ['broken'], nextCursor: undefined }), get: () => new Promise((done) => { resolve = done; }) } as unknown as CardRepository;
    const onSource = vi.fn();
    function Harness() { const selection = useTavernSourceSelection(); return <><button onClick={() => { selection.begin(); onSource('file-b'); }}>New file</button><TavernLocalSources repository={repository} selection={selection} onSource={onSource} /></>; }
    act(() => root.render(<Harness />));
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('从本地'))!.click());
    expect(container.textContent).toContain('1 条本地记录暂不可读');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Card A')!.click());
    act(() => container.querySelector('button')!.click());
    await act(async () => resolve(item));
    expect(onSource).toHaveBeenCalledTimes(1); expect(onSource).toHaveBeenCalledWith('file-b');
  });
  it.each([['large.png', MAX_TAVERN_FILE_BYTES + 1], ['large.json', MAX_TAVERN_TEXT_BYTES + 1]])('rejects %s before materializing bytes', async (name, size) => {
    const arrayBuffer = vi.fn(); await expect(readTavernFile({ name: name as string, size: size as number, arrayBuffer })).rejects.toThrow('上限'); expect(arrayBuffer).not.toHaveBeenCalled();
  });
});


it('previews sparse historical magical-girl cards without altering structured export or unsigned status', async () => {
  const data = { codename: '星/花', _tavern: { raw: candidate.parsed }, _custom: { retain: true } };
  expect(getTavernMagicalGirlPreview(data).appearance.overallLook).toBe('');
  expect(data).not.toHaveProperty('appearance');
  expect(getTavernProjectionTitle(data)).toBe('星/花'); expect(getTavernProjectionCardType(data)).toBe('character');
  const exportFile = vi.fn(); const save = vi.fn().mockResolvedValue('saved');
  act(() => root.render(<TavernLocalProjection conversionMode="ai" data={data} exportFile={exportFile} saveCard={save} />));
  expect(container.textContent).toContain('魔法少女（AI 深度转换）');
  await act(async () => container.querySelector('button')!.click());
  expect(exportFile.mock.calls[0][0].name).toBe('星_花.json');
  expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls[0][0].bytes))).toEqual(data);
  await act(async () => container.querySelectorAll('button')[1].click());
  expect(container.textContent).toContain('未签名 AI 转换');
});


it('requires the actual general-card shape before classifying a templateId as a preview', () => {
  const general = convertTavernToGeneralCard(candidate);
  const scenario = convertTavernToGeneralScenarioCard(candidate);
  expect(isTavernGeneralCharacter(general)).toBe(true);
  expect(isTavernGeneralScenario(scenario)).toBe(true);
  expect(isTavernGeneralCharacter(scenario)).toBe(false);
  expect(isTavernGeneralScenario(general)).toBe(false);
  const sparseCharacter = { name: '残兽', templateId: '通用情景' };
  expect(isTavernGeneralScenario(sparseCharacter)).toBe(false);
  expect(getTavernProjectionCardType(sparseCharacter)).toBe('character');
  expect(getTavernProjectionTitle(sparseCharacter)).toBe('残兽');
  expect(isTavernGeneralScenario({ ...scenario, content: 7 })).toBe(false);
  expect(isTavernGeneralCharacter({ ...general, name: 7 })).toBe(false);
});


it('keeps legal general-card extensions visible even when they resemble a Tavern source', async () => {
  const general = { ...convertTavernToGeneralCard(candidate), description: '合法扩展' };
  const scenario = { ...convertTavernToGeneralScenarioCard(candidate), name: '旧名称扩展', description: '合法扩展' };
  expect(isTavernGeneralCharacter(general)).toBe(true);
  expect(isTavernGeneralScenario(scenario)).toBe(true);
  expect(getTavernProjectionTitle(general)).toBe(general.name);
  expect(getTavernProjectionTitle(scenario)).toBe(scenario.title);
  expect(getTavernProjectionCardType(scenario)).toBe('scenario');
  const exportFile = vi.fn();
  for (const data of [general, scenario]) {
    act(() => root.render(<TavernLocalProjection conversionMode="ai" data={data} exportFile={exportFile} saveCard={vi.fn()} />));
    await act(async () => container.querySelector('button')!.click());
    expect(JSON.parse(new TextDecoder().decode(exportFile.mock.calls.at(-1)![0].bytes))).toEqual(data);
  }
});
