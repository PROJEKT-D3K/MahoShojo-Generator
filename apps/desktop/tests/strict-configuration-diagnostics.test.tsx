// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSeasonMeta, PublicSeasonsConfig } from '@mahoshojo/contracts/public-ranking';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { SCENARIO_PRESET_LIST } from '@mahoshojo/domain/scenario-presets';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class {} }));
import { DesktopStrictConfigurationDiagnostics } from '../src/features/arena/strict-configuration-diagnostics';
import { describeDesktopStrictSetup, type DesktopStrictSetupInput } from '../src/features/arena/strict-setup';
import { createInitialArenaDraft } from '../src/features/arena/session';

const season: PublicSeasonMeta = { id: 'S1', name: '合成赛季', status: 'current', startsAt: '2026-01-01', description: '' };
const reply = (seasons: PublicSeasonMeta[] = [season]) => ({ kind: 'seasons', data: { schemaVersion: 1, seasons } satisfies PublicSeasonsConfig });
const input = (): DesktopStrictSetupInput => {
  const draft = createInitialArenaDraft();
  return { draft: { ...draft, combatants: PRESET_LIST.slice(0, 2).map((preset) => ({ type: 'general-character', data: { name: '角色' }, isValid: false, isPreset: true, filename: preset.filename })),
    settings: { ...draft.settings, readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false } },
  isAuthenticated: true, executionLocation: 'server', modelId: 'default', modelUnavailable: false, adjudicationEventCount: 0 };
};
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
let root: Root; let container: HTMLDivElement;
const render = (props = input()) => act(async () => root.render(<DesktopStrictConfigurationDiagnostics {...props} />));
const toggle = (open: boolean) => act(async () => {
  const node = container.querySelector<HTMLDetailsElement>('details[aria-label="严格排位配置检查"]')!;
  node.open = open; node.dispatchEvent(new Event('toggle'));
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(reply());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No renderer networking for configuration diagnostics'); }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Desktop explicit read-only Strict diagnostic', () => {
  it('does no work while collapsed and uses only the anonymous season operation when opened', async () => {
    const props = input(); const before = structuredClone(props);
    await render(props); expect(mocks.invoke).not.toHaveBeenCalled();
    await toggle(true);
    expect(mocks.invoke.mock.calls).toEqual([['cloud_public_ranking_read', { request: { kind: 'seasons' } }]]);
    expect(fetch).not.toHaveBeenCalled(); expect(props).toEqual(before);
    expect(container.textContent).toContain('合成赛季（S1）');
    expect(container.textContent).toContain('基础配置已对齐；服务器资格仍未知');
    expect(container.textContent).not.toContain('可计分');
    expect(container.textContent).not.toContain('一键严格设置');
  });
  it('updates local hints immediately without reading accounts, changing preference, or reloading seasons', async () => {
    const props = input(); await render(props); await toggle(true);
    await render({ ...props, isAuthenticated: null, executionLocation: 'client', modelId: null, modelUnavailable: true,
      draft: { ...props.draft, selectedLanguage: 'en-US' }, adjudicationEventCount: 2 });
    expect(container.textContent).toContain('账号登录状态尚未确认');
    expect(container.textContent).toContain('当前选择为客户端');
    expect(container.textContent).toContain('当前 AI 模型配置尚不可用');
    expect(container.textContent).toContain('生成语言需为「简体中文」');
    expect(container.textContent).toContain('需清空「随机判定器事件」');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('fences a late response after closing and reopening with a new reader', async () => {
    const old = deferred<ReturnType<typeof reply>>(); mocks.invoke.mockReturnValueOnce(old.promise);
    await render(); await toggle(true); expect(container.textContent).toContain('正在读取公开赛季规则');
    await toggle(false); expect(container.textContent).not.toContain('正在读取公开赛季规则');
    mocks.invoke.mockResolvedValue(reply([{ ...season, name: '新赛季' }]));
    await toggle(true); expect(container.textContent).toContain('新赛季');
    await act(async () => old.resolve(reply([{ ...season, name: '旧迟到赛季' }])));
    expect(container.textContent).not.toContain('旧迟到赛季');
    expect(container.textContent).toContain('新赛季');
  });
  it('coalesces same-turn refresh clicks and ignores their late result after reopening', async () => {
    await render(); await toggle(true);
    const old = deferred<ReturnType<typeof reply>>(); mocks.invoke.mockReturnValueOnce(old.promise);
    const refresh = container.querySelector('button')!;
    await act(async () => { refresh.click(); refresh.click(); });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button')).toBeNull();
    await toggle(false);
    mocks.invoke.mockResolvedValue(reply([{ ...season, name: '刷新后的新赛季' }]));
    await toggle(true);
    await act(async () => old.resolve(reply([{ ...season, name: '迟到旧刷新' }])));
    expect(container.textContent).toContain('刷新后的新赛季');
    expect(container.textContent).not.toContain('迟到旧刷新');
  });
  it('keeps StrictMode effect replay and unmounted reads from publishing into a later opening', async () => {
    const old = deferred<ReturnType<typeof reply>>();
    mocks.invoke.mockReturnValue(old.promise);
    await act(async () => root.render(<StrictMode><DesktopStrictConfigurationDiagnostics {...input()} /></StrictMode>));
    expect(mocks.invoke).not.toHaveBeenCalled();
    await toggle(true);
    expect(mocks.invoke.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.invoke.mock.calls.every(([command, args]) => command === 'cloud_public_ranking_read' && args.request.kind === 'seasons')).toBe(true);
    await toggle(false);
    await act(async () => old.resolve(reply([{ ...season, name: '卸载前的旧赛季' }])));
    expect(container.textContent).not.toContain('卸载前的旧赛季');
    mocks.invoke.mockResolvedValue(reply()); await toggle(true);
    expect(container.textContent).toContain('合成赛季');
    expect(container.textContent).not.toContain('卸载前的旧赛季');
  });
  it('keeps service failure, retry, missing season and unknown future preset distinct', async () => {
    mocks.invoke.mockRejectedValueOnce({ code: 'network', message: 'private diagnostic' });
    await render(); await toggle(true);
    expect(container.textContent).toContain('无法读取公开赛季规则');
    expect(container.textContent).not.toContain('基础配置已对齐');
    expect(container.textContent).not.toContain('未找到当前赛季');
    mocks.invoke.mockResolvedValue(reply([]));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('未找到当前赛季');
    await toggle(false);
    mocks.invoke.mockResolvedValue(reply([{ ...season, specialRules: { mode: 'scenario', scenarioPresetFilename: 'future-scenario.json' } }]));
    await toggle(true);
    expect(container.textContent).toContain('此客户端尚不能识别赛季指定情景');
    expect(container.textContent).not.toContain('基础配置已对齐');
  });
});

describe('Desktop diagnostic source projection', () => {
  it('never promotes cloud IDs, cached provenance or imported content to online role identity', () => {
    const props = input();
    const draft = { ...props.draft, combatants: props.draft.combatants.map((card) => ({ ...card, isPreset: false,
      sourceDataCardId: 'unverified-id', data: { ...card.data, cloudRef: { id: 'cloud-id' }, nativeAllowed: true }, characterGuidance: '不要遗漏' })) };
    const before = structuredClone(draft);
    const result = describeDesktopStrictSetup({ ...props, draft }, season);
    expect(result.reasons).toContain('本地、缓存或导入副本的线上角色身份尚未确认');
    expect(result.reasons).toContain('需先选择 1 位可计分的参战角色（数据卡/预设）');
    expect(result.reasons).toContain('需清空「角色行动引导」');
    expect(draft).toEqual(before);
  });
  it('does not infer preset scenario origin from a matching upload filename', () => {
    const props = input(); const filename = SCENARIO_PRESET_LIST[0]!.filename;
    const result = describeDesktopStrictSetup({ ...props, draft: { ...props.draft, battleMode: 'scenario', scenario: { content: { title: '上传内容' }, fileName: filename } } },
      { ...season, specialRules: { mode: 'scenario', scenarioPresetFilename: filename } });
    expect(result.reasons).toContain('主情景的预设来源尚未确认');
  });
  it('projects selected Lore exactly as the existing generation input, keeping disabled and legacy cases', () => {
    const props = input();
    const selected = [{ source: 'preset' as const, useLore: false, questionnaire: { id: 'required', kind: 'magical-girl' as const, title: '设定', questions: [], loreMarkdown: '设定正文' } }];
    const required = { ...season, specialRules: { questionnaireLorePresetIds: ['required'] } };
    const typed = { ...props, draft: { ...props.draft, selectedQuestionnaires: selected, questionnaires: [{ id: 'required', loreMarkdown: '旧字段不可借用' }] } };
    expect(describeDesktopStrictSetup(typed, required).reasons).toContain('需启用赛季指定的「问卷/设定卡 Lore 注入」');
    expect(describeDesktopStrictSetup({ ...typed, draft: { ...typed.draft, selectedQuestionnaires: [{ ...selected[0]!, useLore: true }] } }, required).reasons).not.toContain('需启用赛季指定的「问卷/设定卡 Lore 注入」');
    const legacy = { ...props, draft: { ...props.draft, questionnaires: [{ id: 'old', loreMarkdown: '旧草稿设定' }] } };
    expect(describeDesktopStrictSetup(legacy, season).reasons).toContain('需关闭「问卷/设定卡 Lore 注入」');
  });
});
