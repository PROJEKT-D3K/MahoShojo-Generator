import { SYSTEM_PROMPTS } from '../arena-generation/prompt';
import { buildArenaDefaultScenario, buildArenaWorldbook } from '@mahoshojo/domain/tavern-card/worldbook';
import type { TavernCharacterBook } from '@mahoshojo/domain/tavern-card/worldbook';
import type { MagicTeaPartyChoiceCount } from '@mahoshojo/domain/magic-tea-party/types';

// 茶会保留既有经典风格，不引入 Arena Direct 后加的战斗约束。
const CLASSIC_SYSTEM_PROMPT = `
  现在角色们在 A.R.E.N.A.竞技场中展开战斗，请根据以下规则生成战斗简报：
  战斗推演核心规则：
1.  能力边界与平衡：角色可使用的能力必须严格来自其设定文本。
    * 平衡原则：战斗应有来有回，允许强者取得优势或短暂压制，但要避免单方面碾压和“无代价秒杀”。
    * 魔法少女等级体系：
        * 种级: 新成为魔法少女。
        * 芽级: 可使用【魔装】。
        * 叶级: 可使用各种【术式】（法术）。
        * 蕾级: 可使用【奇境】。
        * 花级: 可使用【繁开】。
        * 花牌: 魔力大幅增强（花级的2倍以上）。
    * 能力锁定：角色不能使用未达到对应等级解锁的能力。例如，叶级魔法少女无法使用奇境和繁开，但可以使用魔装与术式。

2.  常规战斗模式：绝大多数战斗都围绕着魔法少女的【基本能力】、【魔装】和【术式】展开，极少情况下才可能使用【奇境】及【繁开】。

3.  能力运用：
    * 使用能力可能会付出情报暴露的代价，因此在非必要的情况下，角色通常不使用过于强大的能力。例如，留给决战的王牌能力（如奇境和繁开）通常只在死斗时才会考虑使用。
    * 反制手段：没有无敌的能力，无论是什么能力都可能被对方【抵消】，或被强大的力量直接【破坏】。
    * 强度限制：任何能力都必须是【有代价、可被理解和应对的】，绝不能是无法破解的必胜技能。

请严格遵守以上战斗规则进行推演，构建一场强弱关系合理、有来有回、充满战术博弈的精彩战斗，而不是一场单纯的能力碾压。
`;

export type MagicTeaPartyPresetId = 'arena-classic' | 'arena-kizuna' | 'arena-daily';

export type MagicTeaPartyPreset = {
  id: MagicTeaPartyPresetId;
  title: string;
  description: string;
  systemPrompt: string;
  worldbookPresetId: 'arena-core';
  worldbook: TavernCharacterBook;
  defaultScenario: { title: string; content: string };
  defaultSettings: {
    outputFormat: 'jsonl' | 'markdown';
    enableChoices: boolean;
    choiceCount: MagicTeaPartyChoiceCount;
  };
};

export const MAGIC_TEA_PARTY_PRESETS: MagicTeaPartyPreset[] = [
  {
    id: 'arena-classic',
    title: '经典战报',
    description: '复刻竞技场经典战报口吻，偏叙事。',
    systemPrompt: CLASSIC_SYSTEM_PROMPT,
    worldbookPresetId: 'arena-core',
    worldbook: buildArenaWorldbook({ includeCore: true }),
    defaultScenario: { title: 'A.R.E.N.A.', content: buildArenaDefaultScenario() },
    defaultSettings: { outputFormat: 'jsonl', enableChoices: true, choiceCount: 3 },
  },
  {
    id: 'arena-kizuna',
    title: '羁绊战报',
    description: '更强调感情与羁绊的战斗故事。',
    systemPrompt: SYSTEM_PROMPTS.kizuna,
    worldbookPresetId: 'arena-core',
    worldbook: buildArenaWorldbook({ includeCore: true }),
    defaultScenario: { title: 'A.R.E.N.A.', content: buildArenaDefaultScenario() },
    defaultSettings: { outputFormat: 'jsonl', enableChoices: true, choiceCount: 3 },
  },
  {
    id: 'arena-daily',
    title: '日常互动',
    description: '偏日常互动的轻量模式。',
    systemPrompt: SYSTEM_PROMPTS.daily,
    worldbookPresetId: 'arena-core',
    worldbook: buildArenaWorldbook({ includeCore: true }),
    defaultScenario: { title: 'A.R.E.N.A.', content: buildArenaDefaultScenario() },
    defaultSettings: { outputFormat: 'jsonl', enableChoices: true, choiceCount: 4 },
  },
];

export const getMagicTeaPartyPreset = (id: string | null | undefined): MagicTeaPartyPreset | null => {
  const needle = typeof id === 'string' ? id.trim() : '';
  if (!needle) return null;
  return MAGIC_TEA_PARTY_PRESETS.find((preset) => preset.id === needle) ?? null;
};
