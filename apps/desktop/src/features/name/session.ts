import type { NameGenerationInput, NameGenerationResult } from '@mahoshojo/domain/name-generation';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { DesktopHostedJsonExecutionOptions } from '../generation/executor';
import { DesktopGenerationSession, type GenerationDraftStorage, type GenerationExecutor, type GenerationSessionFamily } from '../generation/session';
import { executeNameGeneration, validateNameResult, type NameCardKind, type NameGenerationIntent } from './generation';

export const NAME_DRAFT_KEY = 'mahoshojo.desktop.name.draft.v1';
export interface NameDraft {
  inputName: string;
  selectedLanguage: string;
  /** Last successful registration card; a failed new attempt keeps its own raw output separately. */
  lastSuccessfulResult?: NameGenerationResult;
}
export const createEmptyNameDraft = (): NameDraft => ({ inputName: '', selectedLanguage: 'zh-CN' });

const NAME_SESSION_FAMILY: GenerationSessionFamily<NameDraft, NameGenerationInput, NameGenerationIntent, NameCardKind> = {
  draftKey: NAME_DRAFT_KEY,
  defaultCardKind: 'name',
  parseDraftFields: (value) => {
    if (typeof value.inputName !== 'string' || typeof value.selectedLanguage !== 'string') throw new Error('草稿版本不受支持或内容损坏');
    return { inputName: value.inputName, selectedLanguage: value.selectedLanguage, ...(value.lastSuccessfulResult === undefined ? {} : { lastSuccessfulResult: validateNameResult(value.lastSuccessfulResult) }) };
  },
  normalizeStoredCardKind: () => 'name',
  isResidueDraft: (draft) => !draft.lastSuccessfulResult && !draft.inputName.trim() && (!draft.output || (draft.output.phase === 'idle' && !draft.output.card && !draft.output.rawText)),
  validateCard: (_kind, value) => validateNameResult(value),
  cardTypeOf: () => 'character',
  titleOf: (_kind, card) => typeof card.name === 'string' ? card.name : '魔法少女',
  signatureFrom: () => undefined,
  stripSignature: (card) => { delete card.signature; delete card.templateId; },
  executeGeneration: executeNameGeneration,
};

/** Name-specific fields only; recovery, cancellation, single-flight and raw output use the existing owner. */
export class NameSession extends DesktopGenerationSession<NameDraft, NameGenerationInput, NameGenerationIntent, NameCardKind> {
  constructor(dependencies: {
    storage: GenerationDraftStorage;
    repository: CardRepository;
    initialDraft?: NameDraft;
    execute?: GenerationExecutor<NameGenerationInput, NameGenerationIntent, NameCardKind>;
    requestId?: () => string;
  }) { super(NAME_SESSION_FAMILY, { ...dependencies, initialDraft: dependencies.initialDraft ?? createEmptyNameDraft() }); }

  override async generate(options: DesktopHostedJsonExecutionOptions, input: NameGenerationInput, intent: Omit<NameGenerationIntent, 'requestId'>, confirmUncertain = false): Promise<void> {
    const before = this.getSnapshot();
    if (this.isBusy() || before.pendingRestore || (before.phase === 'uncertain' && !confirmUncertain)) return;
    const previous = before.card ? validateNameResult(before.card) : before.draft.lastSuccessfulResult;
    if (previous) this.updateDraft({ ...before.draft, lastSuccessfulResult: previous });
    // The base owner still controls dispatch, cancellation and persistence. Its output slot
    // belongs to this attempt; the name-specific draft retains the previous successful card.
    await super.generate(options, input, intent, true);
    const after = this.getSnapshot();
    if (after.phase === 'completed' && after.card) {
      const { lastSuccessfulResult: _previous, ...draft } = after.draft;
      this.updateDraft(draft);
    }
  }
}
