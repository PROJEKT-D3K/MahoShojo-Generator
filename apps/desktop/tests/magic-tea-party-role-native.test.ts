import { describe, expect, it } from 'vitest';
import { applyMagicTeaPartyRoleDraft } from '@mahoshojo/domain/magic-tea-party/role-editor';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { teaSessionView } from '../src/features/magic-tea-party/direct';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

// Requires the same-source Rust harness. No renderer mock can satisfy this gate.
describe.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('real Native session role editing', () => {
  it('preserves extensions through update receipt and SQLite reopen without model requests', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); let sequence = 0;
    const owner = new DesktopTeaSession(createIpcTeaNativePort(probe.invoke), () => `role-native-${++sequence}`);
    try {
      await owner.create(); const id = owner.getSnapshot().record!.session.id;
      const role = { id: 'r', name: '原名', source: 'local' as const, signature: 'opaque-original', isNative: false,
        card: { templateId: '通用角色', name: '原名', content: '原件', extension: { keep: ['😀', 1] }, current_state: { summary: '原状态', fields: { hp: 8 } } } };
      expect(await owner.update({ roles: [role] })).toBe(true);
      const source = teaSessionView(owner.getSnapshot().record!.session).roles[0]!;
      const next = applyMagicTeaPartyRoleDraft(source, { name: '新名', notes: '备注', currentState: '新状态' }, '2026-10-18T00:00:00Z');
      expect(await owner.update({ roles: [next] })).toBe(true);
      await probe.control('reopen'); await owner.select(id);
      expect(owner.getSnapshot().record!.session.roles[0]).toEqual(next);
      expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
});
