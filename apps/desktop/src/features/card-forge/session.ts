import type { GameCardGenerationInput } from '@mahoshojo/ai-core/game-card-generation';
import { GameCardFaceDataSchema } from '@mahoshojo/contracts/game-card';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { DesktopGenerationSession, type GenerationExecutor, type GenerationSessionFamily } from '../generation/session';
import type { DesktopDirectGenerationIntent } from '../generation/executor';
import { executeForgeGeneration } from './generation';

const family: GenerationSessionFamily<GameCardGenerationInput, GameCardGenerationInput, DesktopDirectGenerationIntent, 'game-card'> = {
  draftKey: 'forge-session', defaultCardKind: 'game-card',
  parseDraftFields: () => { throw new Error('工坊会话不恢复角色草稿。'); },
  normalizeStoredCardKind: () => 'game-card', isResidueDraft: () => true,
  validateCard: (_kind, value) => ({ ...GameCardFaceDataSchema.parse(value) }),
  cardTypeOf: () => 'character', titleOf: (_kind, card) => String(card.cardName),
  signatureFrom: () => undefined, stripSignature: card => { delete card.signature; },
  executeGeneration: executeForgeGeneration,
};

type ForgeOwner = DesktopGenerationSession<GameCardGenerationInput, GameCardGenerationInput, DesktopDirectGenerationIntent, 'game-card'>;

/** 只暴露工坊需要的生成生命周期，角色库保存和持久草稿 API 不向消费者开放。 */
export class ForgeGenerationSession {
  private readonly owner: ForgeOwner;

  constructor(repository: CardRepository, execute?: GenerationExecutor<GameCardGenerationInput, DesktopDirectGenerationIntent, 'game-card'>) {
    this.owner = new DesktopGenerationSession(family, { repository, execute, initialDraft: { sourceCardJson: '' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  }

  subscribe = (listener: () => void): (() => void) => this.owner.subscribe(listener);
  getSnapshot = () => this.owner.getSnapshot();
  generate = (...args: Parameters<ForgeOwner['generate']>): Promise<void> => this.owner.generate(...args);
  cancel = (): void => this.owner.cancel();
  dispose = (): void => this.owner.dispose();
}
