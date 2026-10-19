import type { MagicalGirlCardData } from '../character-card';

/** 样板间展示用静态数据：字段形态与生产结果卡一致，内容为展示占位文本。 */
export const SHOWROOM_MAGICAL_GIRL: MagicalGirlCardData = {
  codename: '样板间·澄星',
  appearance: {
    outfit: '以澄澈星光为主题的连衣裙，裙摆缀有渐变棱镜碎片。',
    accessories: '耳侧悬浮的星形水晶，随情绪明暗。',
    colorScheme: '紫色、蓝色',
    overallLook: '轻盈、通透、带有水晶折射感。',
  },
  magicConstruct: {
    name: '澄星棱镜',
    form: '可拆分成七枚碎片的星形棱镜',
    basicAbilities: ['折射光束', '短暂悬浮', '感知恶意'],
    description: '把周围的微光汇聚并折射成防护或攻击用的光束。',
  },
  wonderlandRule: {
    name: '等价折射',
    description: '输出的光强永远等于此前吸收的总量。',
    tendency: '积累型',
    activation: '在黑暗中停留三秒后自动点亮。',
  },
  blooming: {
    name: '满天棱镜',
    evolvedAbilities: ['全向折射', '星屑护盾'],
    evolvedForm: '七枚碎片环绕成环的完整形态',
    evolvedOutfit: '裙摆化为细碎星屑的礼服',
    powerLevel: '中高',
  },
  analysis: {
    personalityAnalysis: '安静、观察力强，习惯先把局势看明白再行动。',
    abilityReasoning: '棱镜意象对应她"先吸收、再回应"的处事方式。',
    coreTraits: ['克制', '敏锐', '守序'],
    predictionBasis: '样板间固定展示数据，不代表真实生成结果。',
    background: {
      belief: '光不该浪费，每一次照亮都要有意义。',
      bonds: '与同队的火系少女互为光与热的对照。',
    },
  },
};
