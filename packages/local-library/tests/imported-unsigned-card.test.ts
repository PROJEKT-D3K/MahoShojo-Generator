import { describe, expect, it, vi } from 'vitest';
import { saveImportedUnsignedCharacter, saveImportedUnsignedCard } from '../src/imported-unsigned-card';
import type { CardRepository } from '../src/repository';
import type { LocalCardRecordV1 } from '../src/record';
function repository() {
  let saved: LocalCardRecordV1 | null = null;
  const port = { putIfAbsent: vi.fn(async (record: LocalCardRecordV1) => { if (saved) return { alreadyPresent: true } as const; saved = record; return { written: true } as const; }), get: vi.fn(async () => saved) } as unknown as CardRepository;
  return { port, get saved() { return saved!; } };
}
describe('imported unsigned local projection', () => {
  it('uses existing-wins and never promotes nested signature or provenance claims', async () => {
    const repo = repository();
    const data = { templateId: '通用角色', name: 'x', content: 'text', _tavern: { raw: { signature: 'untrusted', provenance: 'official-signed', unknown: [1] } } };
    expect(await saveImportedUnsignedCharacter(repo.port, data, 'x')).toBe('saved');
    expect(repo.saved.provenance).toEqual({ kind: 'unsigned', execution: 'imported' });
    expect(repo.saved.data).toEqual(data);
    expect(await saveImportedUnsignedCharacter(repo.port, data, 'x')).toBe('already-present');
    repo.saved.deletedAt = new Date().toISOString();
    await expect(saveImportedUnsignedCharacter(repo.port, data, 'x')).rejects.toThrow('回收站');
  });
  it('saves scenarios with the correct type and preserves existing-wins and tombstones', async () => {
    const repo = repository();
    const data = { templateId: '通用情景', title: '庭院', content: '正文', _tavern: { raw: { name: '庭院', signature: 'unverified' } } };
    expect(await saveImportedUnsignedCard(repo.port, data, data.title, 'scenario')).toBe('saved');
    expect(repo.saved.cardType).toBe('scenario'); expect(repo.saved.title).toBe('庭院');
    expect(repo.saved.provenance).toEqual({ kind: 'unsigned', execution: 'imported' });
    expect(await saveImportedUnsignedCard(repo.port, data, data.title, 'scenario')).toBe('already-present');
    repo.saved.deletedAt = new Date().toISOString();
    await expect(saveImportedUnsignedCard(repo.port, data, data.title, 'scenario')).rejects.toThrow('回收站');
  });
  it('does not report success after repository write failure', async () => {
    const repo = repository(); vi.mocked(repo.port.putIfAbsent).mockRejectedValue(new Error('disk full'));
    await expect(saveImportedUnsignedCharacter(repo.port, { name: 'x' }, 'x')).rejects.toThrow('disk full');
  });
});
