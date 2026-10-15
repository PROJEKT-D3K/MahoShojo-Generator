import type { CardRepository } from '@mahoshojo/local-library/repository';
import { DesktopGenerationSession, type GenerationDraftStorage, type GenerationExecutor, type GenerationSessionFamily } from '../generation/session';
import { executeTavernGeneration, prepareTavernGenerationInput, validateTavernGeneratedCard, type TavernAiTemplate, type TavernGenerationInput, type TavernGenerationIntent } from './generation';

export const TAVERN_AI_DRAFT_KEY = 'mahoshojo.desktop.tavern.ai.draft.v1';
export interface TavernAiDraft { language: string; input: TavernGenerationInput | null }
const FAMILY: GenerationSessionFamily<TavernAiDraft, TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> = {
  draftKey: TAVERN_AI_DRAFT_KEY,
  defaultCardKind: 'general',
  parseDraftFields: value => {
    if (typeof value.language !== 'string' || !value.language.trim() || value.language.length > 32) throw new Error('草稿语言无效');
    if (value.input !== null) prepareTavernGenerationInput(value.input as TavernGenerationInput);
    return { language: value.language, input: value.input as TavernGenerationInput | null };
  },
  normalizeStoredCardKind: value => value === 'general-scenario' || value === 'scenario' || value === 'magical-girl' || value === 'canshou' ? value : 'general',
  isResidueDraft: draft => !draft.input && !draft.output?.card && !draft.output?.rawText,
  validateCard: validateTavernGeneratedCard,
  cardTypeOf: kind => kind === 'scenario' || kind === 'general-scenario' ? 'scenario' : 'character',
  titleOf: (kind, card) => String(kind === 'scenario' || kind === 'general-scenario' ? card.title : kind === 'magical-girl' ? card.codename : card.name),
  signatureFrom: () => undefined,
  stripSignature: card => { delete card.signature; delete card.isPreset; },
  executeGeneration: executeTavernGeneration,
};
export class TavernAiSession extends DesktopGenerationSession<TavernAiDraft, TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate> {
  constructor(dependencies: { storage: GenerationDraftStorage; repository: CardRepository; execute?: GenerationExecutor<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate>; requestId?: () => string }) {
    super(FAMILY, { ...dependencies, initialDraft: { language: 'zh-CN', input: null } });
  }
}
