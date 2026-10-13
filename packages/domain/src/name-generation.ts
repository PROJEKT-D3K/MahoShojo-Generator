import { COLOR_GRADIENTS, MainColor } from './main-color';

export const NAME_MAX_LENGTH = 300;
export type NameGenerationInput = { realName: string; language: string };
export type NameGeneratedData = Omit<NameGenerationResult, 'realName' | 'name' | 'level' | 'levelEmoji'> & { flowerName: string };

export interface NameGenerationResult {
  realName: string;
  name: string;
  flowerDescription: string;
  appearance: {
    height: string;
    weight: string;
    hairColor: string;
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    wearing: string;
    specialFeature: string;
    mainColor: string;
    firstPageColor: string;
    secondPageColor: string;
  };
  spell: string;
  level: string;
  levelEmoji: string;
}


const levels = [
  { name: '种', emoji: '🌱' },
  { name: '芽', emoji: '🍃' },
  { name: '叶', emoji: '🌿' },
  { name: '蕾', emoji: '🌸' },
  { name: '花', emoji: '🌺' },
  { name: '宝石权杖', emoji: '💎' }
];

function seedRandom(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getWeightedRandomFromSeed<T>(array: T[], weights: number[], seed: number, offset: number = 0): T {
  // 使用种子生成 0-1 之间的伪随机数
  const pseudoRandom = ((seed + offset) * 9301 + 49297) % 233280 / 233280.0;

  // 累计权重
  let cumulativeWeight = 0;
  const cumulativeWeights = weights.map(weight => cumulativeWeight += weight);
  const totalWeight = cumulativeWeights[cumulativeWeights.length - 1];

  // 找到对应的索引
  const randomValue = pseudoRandom * totalWeight;
  const index = cumulativeWeights.findIndex(weight => randomValue <= weight);

  return array[index >= 0 ? index : 0];
}

export function isNameWithinLength(name: string): boolean {
  return name.length <= NAME_MAX_LENGTH;
}

/** 保留经典 Web 的 UTF-16 名字种子、权重和输出字段顺序；此投影不携带签名。 */
export function buildNameGenerationResult(inputName: string, aiGenerated: NameGeneratedData): NameGenerationResult {
  // 等级概率配置: [种, 芽, 叶, 蕾, 花, 宝石权杖]
  const levelProbabilities = [0.1, 0.2, 0.3, 0.3, 0.07, 0.03];

  // 使用加权随机选择生成 level
  const seed = seedRandom(aiGenerated.flowerName + inputName);
  const level = getWeightedRandomFromSeed(levels, levelProbabilities, seed, 6);

  return {
    realName: inputName,
    name: aiGenerated.flowerName,
    flowerDescription: aiGenerated.flowerDescription,
    appearance: aiGenerated.appearance,
    spell: aiGenerated.spell,
    level: level.name,
    levelEmoji: level.emoji
};
}

export const nameResultGradient = (result: NameGenerationResult): string => {
  const colors = COLOR_GRADIENTS[result.appearance.mainColor as keyof typeof COLOR_GRADIENTS] ?? COLOR_GRADIENTS[MainColor.Pink];
  return `linear-gradient(135deg, ${colors.first} 0%, ${colors.second} 100%)`;
};

export const serializeNameGenerationResult = (result: NameGenerationResult): string => JSON.stringify(result, null, 2);
