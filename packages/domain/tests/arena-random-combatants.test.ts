import { describe, expect, it, vi } from 'vitest';

import {
  isArenaRandomCombatantPlaceholder,
  materializeArenaRandomCombatants,
  type ArenaRandomCombatantPlaceholder,
} from '@mahoshojo/domain/arena-random-combatants';

const magicalGirlPlaceholder: ArenaRandomCombatantPlaceholder = {
  type: 'random-magical-girl',
  id: 'random-magical-girl-1',
  filename: '随机魔法少女',
  teamId: 7,
};
const canshouPlaceholder: ArenaRandomCombatantPlaceholder = {
  type: 'random-canshou',
  id: 'random-canshou-1',
  filename: '随机残兽',
};

describe('Arena 随机参战占位形状', () => {
  it('识别两类完整占位，而非仅凭 id 或 type 判断', () => {
    expect(isArenaRandomCombatantPlaceholder(magicalGirlPlaceholder)).toBe(true);
    expect(isArenaRandomCombatantPlaceholder(canshouPlaceholder)).toBe(true);
    for (const value of [
      null,
      [],
      'random-magical-girl',
      { id: 'body-id' },
      { type: 'random-magical-girl' },
      { ...magicalGirlPlaceholder, type: 'magical-girl', data: { id: 'body-id' } },
      { ...magicalGirlPlaceholder, id: 1 },
      { ...magicalGirlPlaceholder, id: ' ' },
      { ...magicalGirlPlaceholder, filename: null },
      { ...magicalGirlPlaceholder, filename: ' ' },
      { ...magicalGirlPlaceholder, teamId: '7' },
      { ...magicalGirlPlaceholder, teamId: NaN },
      { ...magicalGirlPlaceholder, teamId: Infinity },
    ]) {
      expect(isArenaRandomCombatantPlaceholder(value)).toBe(false);
    }
  });
});

describe('Arena 随机参战者物化', () => {
  it('保持输入顺序、现有名字规则与分队，但不继承占位来源或原生许可', () => {
    const placeholders = Object.freeze([
      Object.freeze({ ...canshouPlaceholder, sourceDataCardId: 'untrusted-source', signature: 'untrusted-signature', isValid: true }),
      Object.freeze({ ...magicalGirlPlaceholder }),
    ]);
    const original = structuredClone(placeholders);
    const girlData = { codename: '星花', name: '不应使用此名' };
    const canshouData = { name: '影兽' };
    const generateRandomMagicalGirl = vi.fn(() => girlData);
    const generateRandomCanshou = vi.fn(() => canshouData);

    expect(materializeArenaRandomCombatants(placeholders, { generateRandomMagicalGirl, generateRandomCanshou })).toEqual([
      {
        type: 'canshou', data: canshouData, filename: '随机残兽 - 影兽',
        isValid: false, isPreset: false, isNonStandard: false,
      },
      {
        type: 'magical-girl', data: girlData, filename: '随机魔法少女 - 星花',
        isValid: false, isPreset: false, isNonStandard: false, teamId: 7,
      },
    ]);
    expect(generateRandomMagicalGirl).toHaveBeenCalledOnce();
    expect(generateRandomCanshou).toHaveBeenCalledOnce();
    expect(placeholders).toEqual(original);
  });

  it('默认生成器复用现有素材，且不生成签名与占位身份', () => {
    const combatants = materializeArenaRandomCombatants([magicalGirlPlaceholder, canshouPlaceholder]);
    expect(combatants.map((combatant) => combatant.type)).toEqual(['magical-girl', 'canshou']);
    expect(combatants[1]).not.toHaveProperty('teamId');
    expect(combatants).toStrictEqual(JSON.parse(JSON.stringify(combatants)));
    for (const [index, combatant] of combatants.entries()) {
      const placeholder = [magicalGirlPlaceholder, canshouPlaceholder][index];
      expect(combatant.filename).toBe(`${placeholder.filename} - ${combatant.data.codename || combatant.data.name}`);
      expect(combatant).toMatchObject({ isValid: false, isPreset: false, isNonStandard: false });
      expect(combatant).not.toHaveProperty('id');
      expect(combatant).not.toHaveProperty('sourceDataCardId');
      expect(combatant).not.toHaveProperty('signature');
      expect(combatant.data).not.toHaveProperty('signature');
    }
  });

  it('空列表不调用生成器', () => {
    const generateRandomMagicalGirl = vi.fn();
    const generateRandomCanshou = vi.fn();
    expect(materializeArenaRandomCombatants([], { generateRandomMagicalGirl, generateRandomCanshou })).toEqual([]);
    expect(generateRandomMagicalGirl).not.toHaveBeenCalled();
    expect(generateRandomCanshou).not.toHaveBeenCalled();
  });

  it('生成失败向宿主抛出且不修改任何占位', () => {
    const placeholders = Object.freeze([
      Object.freeze({ ...magicalGirlPlaceholder }),
      Object.freeze({ ...canshouPlaceholder }),
    ]);
    const original = structuredClone(placeholders);
    const failure = new Error('随机生成失败');
    expect(() => materializeArenaRandomCombatants(placeholders, {
      generateRandomMagicalGirl: () => ({ codename: '星花' }),
      generateRandomCanshou: () => { throw failure; },
    })).toThrow(failure);
    expect(placeholders).toEqual(original);
  });
});
