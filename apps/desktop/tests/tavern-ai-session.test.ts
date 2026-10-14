import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } from '@mahoshojo/domain/tavern-card';
import { TavernAiSession, TAVERN_AI_DRAFT_KEY } from '../src/features/tavern/session';
import type { TavernAiTemplate, TavernGenerationInput, TavernGenerationIntent } from '../src/features/tavern/generation';
import { DesktopGenerationSession, type GenerationExecutor } from '../src/features/generation/session';
import type { DesktopGenerationOutcome } from '../src/features/generation/executor';
const input: TavernGenerationInput = { raw: { name: 'Alice', description: '{{user}} 原件' }, template: 'general', language: 'zh-CN', preference: { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } };
const completed: DesktopGenerationOutcome<TavernAiTemplate> = { status: 'completed', mode: 'direct-local', cardKind: 'general', card: { templateId: '通用角色', name: '整理结果', content: '正文', _tavern: { raw: input.raw } }, rawText: '模型原文' };
const storage = () => { const map = new Map<string, string>(); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; };
const repository = {} as CardRepository;
const options = { invoke: vi.fn(), profileId: 'original' };
const intent = { mode: 'direct-local' as const, generationMode: 'non-stream' as const };
describe('Tavern uses the existing generation owner', () => {
  it('freezes input, blocks repeated requests, retains cancelled raw text and ignores late cards', async () => {
    let finish!: (value: DesktopGenerationOutcome<TavernAiTemplate>) => void; let signal!: AbortSignal;
    const execute = vi.fn<GenerationExecutor<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate>>(async (_options, _input, _intent, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
    const session = new TavernAiSession({ storage: storage(), repository, execute });
    expect(session).toBeInstanceOf(DesktopGenerationSession);
    session.updateDraft({ language: input.language, input });
    const first = session.generate(options, input, intent);
    await session.generate(options, { ...input, template: 'general-scenario' }, intent);
    session.updateDraft({ language: 'new', input: null }); session.clearOutput();
    expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]![1]).toEqual(input); expect(execute.mock.calls[0]![1]).not.toBe(input);
    expect(session.getSnapshot().draft.input).toEqual(input);
    session.cancel(); expect(signal.aborted).toBe(true); finish(completed); await first;
    expect(session.getSnapshot()).toMatchObject({ phase: 'cancelled', card: null, rawText: '模型原文' });
  });
  it('restores result and original without replay, then clears old input and output together on explicit replacement', async () => {
    const disk = storage(); const execute = vi.fn(async () => completed);
    const session = new TavernAiSession({ storage: disk, repository, execute }); session.updateDraft({ language: input.language, input });
    await session.generate(options, input, intent); session.dispose();
    const restored = new TavernAiSession({ storage: disk, repository, execute }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ resultRestored: true, draft: { input }, card: completed.card });
    expect(execute).toHaveBeenCalledTimes(1); expect(restored.resultSignatureKind()).toBe('unsigned');
    restored.clearOutput(); restored.updateDraft({ language: 'zh-CN', input: null });
    const again = new TavernAiSession({ storage: disk, repository, execute }); again.restoreDraft(false);
    expect(again.getSnapshot()).toMatchObject({ draft: { input: null }, card: null, rawText: '' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves malformed drafts and protects failed writes', async () => {
    const disk = storage(); disk.map.set(TAVERN_AI_DRAFT_KEY, '{broken');
    const session = new TavernAiSession({ storage: disk, repository }); session.updateDraft({ language: input.language, input });
    expect(session.isDraftBlocked()).toBe(true); expect(session.hasUnsavedDraft()).toBe(true); expect(disk.map.get(TAVERN_AI_DRAFT_KEY)).toBe('{broken');
    const failed = new TavernAiSession({ storage: { ...storage(), setItem: () => { throw new Error('full'); } }, repository, execute: async () => completed });
    await failed.generate(options, input, intent); expect(failed.hasUnsavedDraft()).toBe(true); expect(failed.getSnapshot().card).toEqual(completed.card);
  });
  it.each(['direct-local', 'direct-remote'] as const)('saves unsigned %s provenance and intact original; a failed save retries without generation', async mode => {
    const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ written: true });
    const execute = vi.fn(async () => ({ ...completed, mode, card: { ...completed.card, signature: 'forged', isPreset: true } }));
    const session = new TavernAiSession({ storage: storage(), repository: { putIfAbsent } as unknown as CardRepository, execute });
    session.updateDraft({ language: input.language, input }); await session.generate(options, input, { ...intent, mode });
    expect(await session.saveResult()).toBe(false); expect(session.getSnapshot().card).toEqual(completed.card);
    expect(await session.saveResult()).toBe(true); expect(execute).toHaveBeenCalledTimes(1); expect(putIfAbsent).toHaveBeenCalledTimes(2);
    expect(putIfAbsent.mock.calls[1]![0]).toMatchObject({ storageLocation: 'local', cardType: 'character', title: '整理结果', data: completed.card, provenance: { kind: 'unsigned', execution: mode } });
    expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('signature'); expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('isPreset');
  });

});
