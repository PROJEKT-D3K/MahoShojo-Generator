import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { buildNameGenerationResult } from '@mahoshojo/domain/name-generation';
import type { NameGenerationInput } from '@mahoshojo/domain/name-generation';
import type { NameGenerationIntent } from '../src/features/name/generation';
import { NameSession, NAME_DRAFT_KEY } from '../src/features/name/session';
import { DesktopGenerationSession, type GenerationExecutor } from '../src/features/generation/session';
import { GenerationTransportError, type DesktopGenerationOutcome } from '../src/features/generation/executor';

const generated = { flowerName: '铃兰', flowerDescription: '幸福归来', appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊' };
const card = { ...buildNameGenerationResult('小满', generated) };
const completed: DesktopGenerationOutcome<'name'> = { status: 'completed', mode: 'direct-local', card, cardKind: 'name', rawText: JSON.stringify(generated) };
const storage = () => { const map = new Map<string, string>(); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; };
const repository = {} as CardRepository;
const input = { realName: '小满', language: 'zh-CN' };
const options = { invoke: vi.fn(), profileId: 'original' };

describe('NameSession inherits the original generation owner', () => {
  it('automatically reopens completed output without another model request', async () => {
    const disk = storage(); const execute = vi.fn(async () => completed);
    const session = new NameSession({ storage: disk, repository, execute });
    expect(session).toBeInstanceOf(DesktopGenerationSession);
    session.updateDraft({ inputName: '小满', selectedLanguage: 'zh-CN' });
    await session.generate(options, input, { mode: 'direct-local' });
    session.dispose();
    const reopened = new NameSession({ storage: disk, repository, execute }); reopened.restoreDraft(false);
    expect(reopened.getSnapshot()).toMatchObject({ phase: 'completed', card, resultRestored: true, draftSaved: true });
    expect(reopened.resultSignatureKind()).toBe('unsigned');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('single-flights duplicate clicks, freezes input and ignores the completed card after cancel', async () => {
    const disk = storage(); let finish!: (value: DesktopGenerationOutcome<'name'>) => void; let signal!: AbortSignal;
    const execute = vi.fn<GenerationExecutor<NameGenerationInput, NameGenerationIntent, 'name'>>(async (_options, _input, _intent, abortSignal) => { signal = abortSignal; return new Promise<DesktopGenerationOutcome<'name'>>(resolve => { finish = resolve; }); });
    const session = new NameSession({ storage: disk, repository, execute }); session.updateDraft({ inputName: '小满', selectedLanguage: 'zh-CN' });
    const first = session.generate(options, input, { mode: 'direct-local', modelId: 'frozen' });
    await session.generate(options, { ...input, realName: 'new' }, { mode: 'direct-remote', modelId: 'changed' });
    session.updateDraft({ inputName: 'changed', selectedLanguage: 'en' });
    expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]![1]).toEqual(input);
    expect(session.getSnapshot().draft.inputName).toBe('小满');
    session.cancel(); expect(signal.aborted).toBe(true); finish(completed); await first;
    expect(session.getSnapshot()).toMatchObject({ phase: 'cancelled', card: null, rawText: completed.rawText });
  });
  it('retains raw output on transport failure and restores it without replay', async () => {
    const disk = storage(); const execute = vi.fn(async () => { throw new GenerationTransportError('half raw', new Error('offline')); });
    const session = new NameSession({ storage: disk, repository, execute });
    await session.generate(options, input, { mode: 'direct-local' });
    const reopened = new NameSession({ storage: disk, repository, execute }); reopened.restoreDraft(false);
    expect(reopened.getSnapshot()).toMatchObject({ phase: 'failed', rawText: 'half raw', card: null }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite corrupt storage, reports failed writes, or accept forged output authority', async () => {
    const disk = storage(); disk.map.set(NAME_DRAFT_KEY, '{broken');
    const blocked = new NameSession({ storage: disk, repository }); blocked.updateDraft({ inputName: 'new', selectedLanguage: 'zh-CN' });
    expect(blocked.isDraftBlocked()).toBe(true); expect(blocked.hasUnsavedDraft()).toBe(true); expect(disk.map.get(NAME_DRAFT_KEY)).toBe('{broken');
    const session = new NameSession({ storage: { ...storage(), setItem: () => { throw new Error('full'); } }, repository, execute: async () => completed });
    await session.generate(options, input, { mode: 'direct-local' }); expect(session.getSnapshot()).toMatchObject({ phase: 'completed', card, draftSaved: false });
    const forged = new NameSession({ storage: storage(), repository, execute: async () => ({ ...completed, card: { ...card, signature: 'forged', templateId: 'official' } }) });
    await forged.generate(options, input, { mode: 'direct-local' }); expect(forged.getSnapshot().card).toEqual(card); expect(forged.resultSignatureKind()).toBe('unsigned');
  });
  it('retains the last successful card across repeated failures, cancellation and restart, then replaces it only on success', async () => {
    const disk = storage(); const execute = vi.fn<GenerationExecutor<NameGenerationInput, NameGenerationIntent, 'name'>>(async () => completed);
    const session = new NameSession({ storage: disk, repository, execute });
    await session.generate(options, input, { mode: 'direct-local' });
    execute.mockResolvedValue({ status: 'invalid-output', mode: 'direct-remote', rawText: 'bad one', message: 'invalid' });
    await session.generate(options, input, { mode: 'direct-remote' });
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', card: null, rawText: 'bad one', draft: { lastSuccessfulResult: card } });
    execute.mockResolvedValue({ status: 'failed', mode: 'direct-remote', rawText: 'bad two', message: 'offline' });
    await session.generate(options, input, { mode: 'direct-remote' });
    const reopened = new NameSession({ storage: disk, repository, execute }); reopened.restoreDraft(false);
    expect(reopened.getSnapshot()).toMatchObject({ phase: 'failed', card: null, rawText: 'bad two', draft: { lastSuccessfulResult: card } });
    expect(execute).toHaveBeenCalledTimes(3);
    execute.mockResolvedValue({ status: 'cancelled', mode: 'direct-local', rawText: 'cancelled prefix' });
    await reopened.generate(options, input, { mode: 'direct-local' });
    expect(reopened.getSnapshot().draft.lastSuccessfulResult).toEqual(card);
    const next = { ...buildNameGenerationResult('新名字', { ...generated, flowerName: '茉莉' }) };
    execute.mockResolvedValue({ ...completed, card: next });
    await reopened.generate(options, { ...input, realName: '新名字' }, { mode: 'direct-local' });
    expect(reopened.getSnapshot().card).toEqual(next);
    expect(reopened.getSnapshot().draft).not.toHaveProperty('lastSuccessfulResult');
    expect(JSON.parse(disk.getItem(NAME_DRAFT_KEY)!).output.card).toEqual(next);
    reopened.discardDraft(); expect(reopened.getSnapshot().card).toBeNull(); expect(reopened.getSnapshot().draft).not.toHaveProperty('lastSuccessfulResult');
  });
  it('keeps a failed-write fallback in memory, preserving its unsigned projection', async () => {
    const disk = storage(); const execute = vi.fn<GenerationExecutor<NameGenerationInput, NameGenerationIntent, 'name'>>(async () => completed);
    const session = new NameSession({ storage: disk, repository, execute }); await session.generate(options, input, { mode: 'direct-local' });
    const original = disk.getItem(NAME_DRAFT_KEY);
    disk.setItem = () => { throw new Error('full'); };
    execute.mockResolvedValue({ status: 'failed', mode: 'direct-remote', rawText: 'new failure', message: 'failed' });
    await session.generate(options, input, { mode: 'direct-remote' });
    expect(session.getSnapshot()).toMatchObject({ draftSaved: false, draft: { lastSuccessfulResult: card }, rawText: 'new failure' });
    expect(session.getSnapshot().draft.lastSuccessfulResult).not.toHaveProperty('signature');
    expect(disk.getItem(NAME_DRAFT_KEY)).toBe(original);
  });

});
