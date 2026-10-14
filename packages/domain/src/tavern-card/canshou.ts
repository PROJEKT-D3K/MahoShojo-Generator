import { parseDataCardByTemplate } from '../data-card-schemas';
import { createBlankDataCard } from '../sublimation';
import type { TavernCardNormalized } from './types';

export const TAVERN_CANSHOU_TEMPLATE_ID = '魔法少女/心之花/残兽（问卷生成）' as const;

/** Original Web conservative mapping. Opening messages and tags stay only in the optional original. */
export function buildTavernCanshouCard(normalized: TavernCardNormalized) {
  const base = parseDataCardByTemplate('canshou', createBlankDataCard('canshou'));
  return {
    templateId: TAVERN_CANSHOU_TEMPLATE_ID as typeof TAVERN_CANSHOU_TEMPLATE_ID,
    name: normalized.name,
    materialAndSkin: base.materialAndSkin ?? '',
    featuresAndAppendages: base.featuresAndAppendages ?? '',
    coreConcept: base.coreConcept ?? '',
    evolutionStage: base.evolutionStage ?? '',
    attackMethod: base.attackMethod ?? '',
    specialAbility: base.specialAbility ?? '',
    origin: base.origin ?? '',
    birthEnvironment: base.birthEnvironment ?? '',
    appearance: normalized.description ?? base.appearance ?? '',
    coreEmotion: normalized.personality ?? base.coreEmotion ?? '',
    researcherNotes: [
      base.researcherNotes ? String(base.researcherNotes) : '',
      normalized.scenario ? `【场景】\n${normalized.scenario}` : '',
      normalized.mesExample ? `【对话样例】\n${normalized.mesExample}` : '',
    ].filter((part) => part.trim()).join('\n\n'),
  };
}
