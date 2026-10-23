import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

// Both exact build provenances must be recorded by the verification run. This is not a mock old validator.
describe.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY || !process.env.MAHO_TEA_LEGACY_JOURNEY_BINARY)('real old Tea reader compatibility boundary', () => {
  it('rejects new organization receipts before opening the old store, leaves its database intact, and restores with the new reader', async () => {
    const fresh = await startMagicTeaPartyJourneyProbe({ keepRoot: true });
    const root = fresh.root; let sequence = 0; const owner = new DesktopTeaSession(createIpcTeaNativePort(fresh.invoke), () => `compat-${++sequence}`);
    let oldRoot: string | undefined;
    let old: Awaited<ReturnType<typeof startMagicTeaPartyJourneyProbe>> | undefined;
    try {
      await owner.create(); const deletedId = owner.getSnapshot().record!.session.id;
      await owner.create(); const id = owner.getSnapshot().record!.session.id;
      await owner.setPin(id, true);
      expect(await owner.deleteSelected(owner.prepareCleanup([deletedId])!)).toBe(true);
      const snapshot = await fresh.control('snapshot');
      const backup = await fresh.control('checkpoint', { action: 'backup' }) as { backupId: string; directory: string; absolutePath: string };
      owner.dispose(); await fresh.close();
      const bytes = readFileSync(join(root, 'library.sqlite')); let diagnostic = '';
      await expect(startMagicTeaPartyJourneyProbe({ root, binary: process.env.MAHO_TEA_LEGACY_JOURNEY_BINARY,
        onDiagnostic: text => { diagnostic += text; } })).rejects.toThrow();
      expect(diagnostic).toContain('UpgradeBackup(Corrupt)');
      expect(readFileSync(join(root, 'library.sqlite'))).toEqual(bytes);
      old = await startMagicTeaPartyJourneyProbe({ binary: process.env.MAHO_TEA_LEGACY_JOURNEY_BINARY, keepRoot: true }); oldRoot = old.root;
      // New-format backup supplied to a separate, valid old library, never two simultaneous writers.
      const target = join(old.root, 'backups', backup.backupId); cpSync(backup.absolutePath, target, { recursive: true, errorOnExist: true });
      const oldBefore = await old.control('snapshot'); const originalBackup = readFileSync(join(target, 'library.sqlite'));
      await expect(old.control('checkpoint', { action: 'prepare-restore', backupId: backup.backupId })).rejects.toMatchObject({ code: 'tea-io' });
      expect(await old.control('snapshot')).toEqual(oldBefore); expect(readFileSync(join(target, 'library.sqlite'))).toEqual(originalBackup);
      expect(existsSync(join(old.root, 'restore.intent'))).toBe(false);
      await old.close();
      const reopened = await startMagicTeaPartyJourneyProbe({ root });
      try {
        expect(await reopened.control('snapshot')).toEqual(snapshot);
        const changedOwner = new DesktopTeaSession(createIpcTeaNativePort(reopened.invoke), () => `post-backup-${++sequence}`);
        try { await changedOwner.refreshDirectory(); await changedOwner.setPin(id, false); }
        finally { changedOwner.dispose(); }
        expect(await reopened.control('snapshot')).not.toEqual(snapshot);
        const prepared = await reopened.control('checkpoint', { action: 'prepare-restore', backupId: backup.backupId }) as { restartRequired: boolean };
        expect(prepared).toBeTruthy();
        await reopened.control('reopen');
        expect(await reopened.control('snapshot')).toEqual(snapshot);
      } finally { await reopened.close(); }
    } finally {
      owner.dispose(); await fresh.close().catch(() => {}); await old?.close().catch(() => {});
      rmSync(root, { recursive: true, force: true }); if (oldRoot) rmSync(oldRoot, { recursive: true, force: true });
    }
  }, 60000);
});
