import type { ArenaRoomSharedConfig, ArenaProposalChange } from '@mahoshojo/contracts/arena-room';
import type { ArenaProposalChangeLabels } from '../proposal-presentation';
import type { ArenaMemberReferenceRequest } from './types';

export function buildArenaMemberProposalLabels(config: ArenaRoomSharedConfig, resolveName: (request: ArenaMemberReferenceRequest) => string | undefined, language?: ArenaProposalChangeLabels['language']): ArenaProposalChangeLabels {
  const refLabel = (request: ArenaMemberReferenceRequest) => `${request.source === 'preset' ? '预设' : '在线'}:${resolveName(request) || (request.id.length > 20 && request.source !== 'preset' ? `${request.id.slice(0, 20)}…` : request.id)}`;
  const keyLabel = (kind: ArenaMemberReferenceRequest['kind']) => (key: string): string | undefined => {
    const item = [...config.combatants, ...config.auxScenarios, ...config.materials, ...(config.scenario ? [config.scenario] : [])].find(entry => entry.key === key);
    if (item && !('ref' in item)) return `房主本地:${item.displayName}`;
    if (item && 'ref' in item) return refLabel({ source: key.startsWith('preset:') ? 'preset' : 'data-card', ...item.ref, kind });
    if (key.startsWith('preset:') || key.startsWith('data-card:')) return refLabel({ source: key.startsWith('preset:') ? 'preset' : 'data-card', kind, id: key.slice(key.indexOf(':') + 1) });
    return undefined;
  };
  return { language, combatantKey: keyLabel('character'), scenarioKey: keyLabel('scenario'), materialKey: keyLabel('material'),
    teamKey: key => config.teams.find(team => team.key === key)?.displayName,
    ref: (ref, key) => refLabel({ source: key?.startsWith('preset:') ? 'preset' : 'data-card', ...ref, kind: ref.kind === 'scenario' ? 'scenario' : ref.kind === 'material' ? 'material' : 'character' }),
  };
}
export function collectArenaMemberChangeReferences(changes: readonly ArenaProposalChange[]): ArenaMemberReferenceRequest[] {
  return changes.flatMap(change => 'ref' in change && change.ref ? [{ source: 'key' in change && change.key?.startsWith('preset:') ? 'preset' as const : 'data-card' as const, ...change.ref }] : []);
}
