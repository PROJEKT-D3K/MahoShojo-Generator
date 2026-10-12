import { describe, expect, it } from 'vitest';

import {
  areArenaRoomSharedConfigsEqual,
  areArenaRoomSharedConfigsExactlyEqual,
  areArenaRoomSharedConfigsSemanticallyEqual,
} from '../src/index';
import { baseConfig } from './state-machine-fixtures';

const onlineConfig = (versionToken: string) => {
  const entry = <T extends 'character' | 'scenario' | 'material'>(id: string, kind: T) => ({
    key: `data-card:${id}`, ref: { id, kind, versionToken },
  });
  return {
    ...baseConfig(),
    combatants: [entry('character-1', 'character'), entry('character-2', 'character')],
    scenario: entry('scenario-1', 'scenario'),
    auxScenarios: [entry('scenario-2', 'scenario')],
    materials: [entry('material-1', 'material')],
  };
};

describe('Arena Room shared config equality', () => {
  it('仅 canonical 在线引用的观察版本不属于用户配置意图，exact 比较始终保留版本', () => {
    const original = onlineConfig('v1');
    const newer = onlineConfig('v2');
    const untouched = structuredClone(original);
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, newer)).toBe(true);
    expect(areArenaRoomSharedConfigsExactlyEqual(original, newer)).toBe(false);
    expect(areArenaRoomSharedConfigsEqual).toBe(areArenaRoomSharedConfigsSemanticallyEqual);
    expect(original).toEqual(untouched);
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, {
      ...newer, combatants: [...newer.combatants].reverse(),
    })).toBe(false);
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, { ...newer, userGuidance: 'changed' }))
      .toBe(false);
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, { ...newer, scenario: null })).toBe(false);
  });

  it.each(['preset:scenario-1', 'data-card:other-id', 'custom:scenario-1'])('%s 的版本不能被当作在线观察忽略', (key) => {
    const original = { ...onlineConfig('v1'), scenario: {
      key, ref: { id: 'scenario-1', kind: 'scenario' as const, versionToken: 'v1' },
    } };
    const newer = { ...original, scenario: {
      ...original.scenario, ref: { ...original.scenario.ref, versionToken: 'v2' },
    } };
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, newer)).toBe(false);
    expect(areArenaRoomSharedConfigsExactlyEqual(original, newer)).toBe(false);
  });

  it('host-local 正文版本变化始终是配置变化', () => {
    const original = { ...baseConfig(), combatants: [{
      key: 'host-local:character:one', displayName: '角色', type: 'general-character' as const,
      source: 'host-local' as const, contentVersion: `sha256:${'a'.repeat(64)}`,
    }] };
    const newer = { ...original, combatants: [{
      ...original.combatants[0]!, contentVersion: `sha256:${'b'.repeat(64)}`,
    }] };
    expect(areArenaRoomSharedConfigsSemanticallyEqual(original, newer)).toBe(false);
    expect(areArenaRoomSharedConfigsExactlyEqual(original, newer)).toBe(false);
  });

  it('对象属性顺序不影响两种比较，null 与空配置保持不同', () => {
    const original = onlineConfig('v1');
    const reordered = { ...original, scenario: {
      ref: { versionToken: 'v1', kind: 'scenario' as const, id: 'scenario-1' }, key: 'data-card:scenario-1',
    } };
    for (const equal of [areArenaRoomSharedConfigsExactlyEqual, areArenaRoomSharedConfigsSemanticallyEqual]) {
      expect(equal(original, reordered)).toBe(true);
      expect(equal(null, null)).toBe(true);
      expect(equal(null, original)).toBe(false);
      expect(equal(original, null)).toBe(false);
    }
  });
});
