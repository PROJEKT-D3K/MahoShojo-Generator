import type { MagicTeaPartyMessage, MagicTeaPartySession } from './types';

/** Preserve the historical summary watermark while keeping coverage tied to retained message identities. */
export const resolveMagicTeaPartyBranchSummary = (params: {
  session: MagicTeaPartySession;
  messages: MagicTeaPartyMessage[];
  replaceFromIndex: number;
  clonedMessageIds?: ReadonlyMap<string, string>;
}): Pick<MagicTeaPartySession, 'summary' | 'summarySections' | 'summaryMeta'> => {
  const { session, messages, replaceFromIndex, clonedMessageIds } = params;
  let summaryMeta = session.summaryMeta;
  const clear = { summary: undefined, summarySections: undefined, summaryMeta: undefined };
  if (summaryMeta?.toMessageId) {
    const summaryIndex = messages.findIndex(message => message.id === summaryMeta?.toMessageId);
    if (summaryIndex >= replaceFromIndex) return clear;
  }
  if (summaryMeta) {
    summaryMeta = { ...summaryMeta };
    const coverage = summaryMeta.coverage;
    if (clonedMessageIds) {
      // Keep the full-history watermark; selected coverage endpoints are not interchangeable with it.
      for (const key of ['fromMessageId', 'toMessageId'] as const) {
        const id = summaryMeta[key];
        if (id && clonedMessageIds.has(id)) summaryMeta[key] = clonedMessageIds.get(id);
      }
      if (coverage) {
        // Dropping only the evidence would retain summary text about an omitted branch tail.
        // Missing identities are equally unprovable, so fail closed for the whole summary.
        if ([...coverage.selectedMessageIds, ...coverage.clippedMessageIds].some(id => !clonedMessageIds.has(id))) return clear;
        summaryMeta.coverage = {
          ...coverage,
          selectedMessageIds: coverage.selectedMessageIds.map(id => clonedMessageIds.get(id)!),
          clippedMessageIds: coverage.clippedMessageIds.map(id => clonedMessageIds.get(id)!),
        };
      }
    } else if (coverage) {
      const retainedIds = new Set(messages.slice(0, replaceFromIndex).map(message => message.id));
      if ([...coverage.selectedMessageIds, ...coverage.clippedMessageIds].some(id => !retainedIds.has(id))) return clear;
    }
  }
  return { summary: session.summary, summarySections: session.summarySections, summaryMeta };
};

