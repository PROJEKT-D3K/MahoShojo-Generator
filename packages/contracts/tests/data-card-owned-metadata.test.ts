import {
  OwnedDataCardMetadataAcknowledgementSchema,
  OwnedDataCardMetadataRequestSchema,
} from '@mahoshojo/contracts/data-cards';
import { OwnedDataCardMetadataRequestSchema as RootRequestSchema } from '@mahoshojo/contracts';

const request = {
  expectedUserId: 7, id: 'card', expectedVersion: 'a'.repeat(64),
  name: '名称', description: '', isPublic: 0,
};

describe('owned metadata wire contract', () => {
  it('exports a strict metadata-only contract and trims names', () => {
    expect(RootRequestSchema).toBe(OwnedDataCardMetadataRequestSchema);
    expect(OwnedDataCardMetadataRequestSchema.parse({ ...request, name: ' 名称 ' }).name).toBe('名称');
    for (const field of ['data', 'type', 'reviewStatus', 'review_status', 'public_since', 'ownerUserId', 'signature', 'nativeAllowed']) {
      expect(OwnedDataCardMetadataRequestSchema.safeParse({ ...request, [field]: 'injected' }).success).toBe(false);
    }
  });
  it.each([
    { expectedUserId: '7' }, { expectedUserId: 0 }, { expectedUserId: Number.MAX_SAFE_INTEGER + 1 },
    { id: '' }, { id: ' '.repeat(5) }, { id: 'x'.repeat(201) }, { expectedVersion: '' },
    { expectedVersion: 'A'.repeat(64) }, { name: '' }, { name: '   ' }, { name: '名'.repeat(21) },
    { description: null }, { description: 'x'.repeat(301) }, { isPublic: true }, { isPublic: '1' },
    { isPublic: 2 }, { isPublic: null },
  ])('rejects invalid metadata or fence %j', (patch) => {
    expect(OwnedDataCardMetadataRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it.each([-1, 0, 1])('accepts visibility %s and inclusive text boundaries', (isPublic) => {
    expect(OwnedDataCardMetadataRequestSchema.safeParse({
      ...request, isPublic, name: '名'.repeat(20), description: '字'.repeat(300),
    }).success).toBe(true);
  });
  it('requires every request field and a metadata-specific acknowledgement', () => {
    for (const field of Object.keys(request)) {
      const partial: Record<string, unknown> = { ...request }; delete partial[field];
      expect(OwnedDataCardMetadataRequestSchema.safeParse(partial).success).toBe(false);
    }
    const ack = { success: true, id: 'card', accountFenceVersion: 1, ownerUserId: 7, metadataVersion: 1 };
    expect(OwnedDataCardMetadataAcknowledgementSchema.parse(ack)).toEqual(ack);
    for (const patch of [{ success: false }, { id: '' }, { ownerUserId: '7' }, { accountFenceVersion: 2 }, { metadataVersion: 2 }, { metadataVersion: undefined }, { message: 'unexpected' }]) {
      expect(OwnedDataCardMetadataAcknowledgementSchema.safeParse({ ...ack, ...patch }).success).toBe(false);
    }
    expect(OwnedDataCardMetadataAcknowledgementSchema.safeParse({
      success: true, id: 'card', accountFenceVersion: 1, ownerUserId: 7, replacementVersion: 1, pendingReview: false,
    }).success).toBe(false);
  });
});
