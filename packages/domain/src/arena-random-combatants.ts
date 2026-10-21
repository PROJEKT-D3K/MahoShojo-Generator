import type { CombatantData } from './arena-file-parser';
import { generateRandomCanshou, generateRandomMagicalGirl } from './random-character';

export interface ArenaRandomCombatantPlaceholder {
  type: 'random-magical-girl' | 'random-canshou';
  id: string;
  filename: string;
  teamId?: number;
}

/** 识别占位形状，不替代宿主对持久化字段与分队编号的准入校验。 */
export const isArenaRandomCombatantPlaceholder = (
  value: unknown,
): value is ArenaRandomCombatantPlaceholder => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.type === 'random-magical-girl' || item.type === 'random-canshou')
    && typeof item.id === 'string' && item.id.trim().length > 0
    && typeof item.filename === 'string' && item.filename.trim().length > 0
    && (item.teamId === undefined || (typeof item.teamId === 'number' && Number.isFinite(item.teamId)));
};

type RandomCombatantGenerators = {
  generateRandomMagicalGirl: typeof generateRandomMagicalGirl;
  generateRandomCanshou: typeof generateRandomCanshou;
};

export const materializeArenaRandomCombatants = (
  placeholders: readonly ArenaRandomCombatantPlaceholder[],
  generators: RandomCombatantGenerators = { generateRandomMagicalGirl, generateRandomCanshou },
): CombatantData[] => placeholders.map((placeholder) => {
  const data = placeholder.type === 'random-magical-girl'
    ? generators.generateRandomMagicalGirl()
    : generators.generateRandomCanshou();
  return {
    type: data.codename ? 'magical-girl' : 'canshou',
    data,
    filename: `${placeholder.filename} - ${data.codename || data.name}`,
    // 本地随机生成器不持有签名能力，不得自行授予原生标记。
    isValid: false,
    isPreset: false,
    isNonStandard: false,
    ...(placeholder.teamId === undefined ? {} : { teamId: placeholder.teamId }),
  };
});
