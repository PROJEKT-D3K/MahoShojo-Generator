// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArenaProposalChange } from '@mahoshojo/contracts/arena-room';
import {
  ArenaProposalChangeDescription,
  arenaProposalChangeProposedSummary,
  arenaProposalExpectedBaseSummary,
  arenaProposalValueSummary,
  changeRefTitle,
  type ArenaProposalChangeLabels,
} from '../src/arena-room';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const language: ArenaProposalChange = {
  changeId: 'language', type: 'setSelectedLanguage', value: 'zh-TW',
  expectedBase: { kind: 'value', value: 'zh-CN' },
};

it('uses injected language copy and otherwise preserves an unknown language code', () => {
  expect(arenaProposalChangeProposedSummary(language)).toBe('语言改为 zh-TW');
  expect(arenaProposalChangeProposedSummary(language, { language: () => undefined })).toBe('语言改为 zh-TW');
  expect(arenaProposalChangeProposedSummary(language, { language: () => '繁體中文' })).toBe('语言改为 繁體中文');
});

it('keeps raw reference identity and uses optional reference labels without fetching', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const change: ArenaProposalChange = {
    changeId: 'add', type: 'addCombatant', key: 'preset:character-long-id',
    ref: { id: 'character-long-id', kind: 'character', versionToken: 'v1' },
    expectedBase: { kind: 'absent' },
  };
  expect(arenaProposalChangeProposedSummary(change)).toBe('新增角色 预设:character-long-id');
  expect(arenaProposalChangeProposedSummary(change, { ref: () => undefined })).toBe('新增角色 预设:character-long-id');
  const ref = vi.fn(() => '<img src=x onerror=alert(1)>');
  await act(async () => root.render(<ArenaProposalChangeDescription change={change} labels={{ ref }} />));
  expect(ref).toHaveBeenCalledWith(change.ref, change.key);
  expect(container.textContent).toContain('新增角色 <img src=x onerror=alert(1)>');
  expect(container.querySelector('[title]')?.getAttribute('title')).toBe('preset:character-long-id');
  expect(container.querySelector('img,button,input,form')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('shares target base, dependency and atomic-group details while allowing hosts to place them separately', async () => {
  const change: ArenaProposalChange = {
    ...language, dependsOn: ['mode', 'add'], atomicGroupId: 'group-1',
  };
  await act(async () => root.render(<ArenaProposalChangeDescription change={change} />));
  expect(container.textContent).toContain('提案基准：zh-CN · 依赖 mode、add · 联动变更组 group-1');
  await act(async () => root.render(<ArenaProposalChangeDescription change={change} showDetails={false} />));
  expect(container.textContent).toBe('语言改为 zh-TW');
});

it('preserves reorder, assignment, guidance and history summaries with labels and ID fallback', () => {
  const labels: ArenaProposalChangeLabels = {
    combatantKey: (key) => key === 'data-card:c1' ? '角色一' : undefined,
    teamKey: (key) => key === 'team:1' ? '一队' : undefined,
  };
  expect(arenaProposalChangeProposedSummary({
    changeId: 'order', type: 'reorderTeamCombatants', teamKey: 'team:1',
    value: ['data-card:c1', 'data-card:c2'],
    expectedBase: { kind: 'value', value: ['data-card:c2', 'data-card:c1'] },
  }, labels)).toBe('调整队伍 一队 内角色顺序：角色一 → data-card:c2');
  expect(arenaProposalChangeProposedSummary({
    changeId: 'assign', type: 'assignTeam', combatantKey: 'data-card:c1', teamKey: 'team:1',
    expectedBase: { kind: 'value', value: null },
  }, labels)).toBe('角色 角色一 分配至队伍 一队');
  expect(arenaProposalChangeProposedSummary({
    changeId: 'guidance', type: 'setCharacterGuidance', combatantKey: 'data-card:c1', value: null,
    expectedBase: { kind: 'value', value: '旧引导' },
  }, labels)).toBe('清空角色 角色一 引导');
  const history = {
    readArenaHistory: true, isArenaHistoryUnlimited: true, readArenaHistoryLimit: 3, writeArenaHistory: false,
    readCurrentState: false, writeCurrentState: true,
    readNarrativeHistory: true, isNarrativeHistoryUnlimited: false, readNarrativeHistoryLimit: 7, writeNarrativeHistory: false,
  };
  expect(arenaProposalChangeProposedSummary({
    changeId: 'history', type: 'setHistorySettings', value: history,
    expectedBase: { kind: 'value', value: history },
  })).toBe('竞技场历史 读取=开(无限)、写入=关；当前状态 读取=关、写入=开；叙事历史 读取=开(7)、写入=关');
});

it('preserves expected-base namespace and safely summarizes absent, object and long values', () => {
  const change: ArenaProposalChange = {
    changeId: 'scene', type: 'setScenario', ref: null,
    expectedBase: { kind: 'ref', key: 'preset:scene', ref: { id: 'scene', kind: 'scenario', versionToken: 'v1' } },
  };
  expect(arenaProposalExpectedBaseSummary(change)).toBe('提案基准：preset:scene');
  expect(changeRefTitle(change)).toBeUndefined();
  expect(arenaProposalExpectedBaseSummary({
    changeId: 'team', type: 'addTeam', teamKey: 'team:1', displayName: '一队', expectedBase: { kind: 'absent' },
  })).toBe('提案基准：目标不存在');
  expect(arenaProposalExpectedBaseSummary({
    changeId: 'order', type: 'reorderTeams', value: ['team:2', 'team:1'],
    expectedBase: { kind: 'value', value: ['team:1', 'team:2'] },
  })).toBe('提案基准：已绑定安全值');
  expect(arenaProposalValueSummary(undefined)).toBe('无');
  expect(arenaProposalValueSummary('')).toBe('空值');
  expect(arenaProposalValueSummary('长'.repeat(121))).toBe(`${'长'.repeat(120)}…`);
  expect(arenaProposalValueSummary({ current: true })).toBe('{"current":true}');
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(arenaProposalValueSummary(circular)).toBe('不可序列化值');
});
