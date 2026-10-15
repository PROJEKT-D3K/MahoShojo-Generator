import { describe, expect, it } from 'vitest';

import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import * as sharedEditor from '@mahoshojo/multiplayer-core';
import * as webEditor from '@/lib/arena-room/proposal-editor';
import type { ArenaProposalEditorSnapshot } from '@/lib/arena-room/proposal-editor';

const historySettings = () => ({
  readArenaHistory: true,
  readArenaHistoryLimit: 3,
  isArenaHistoryUnlimited: false,
  writeArenaHistory: true,
  readCurrentState: true,
  writeCurrentState: true,
  readNarrativeHistory: false,
  readNarrativeHistoryLimit: 10,
  isNarrativeHistoryUnlimited: false,
  writeNarrativeHistory: false,
});

const combatant = (id: string, guidance?: string) => ({
  key: `data-card:${id}`,
  ref: { id, kind: 'character' as const, versionToken: `${id}-v1` },
  ...(guidance === undefined ? {} : { characterGuidance: guidance }),
});

const config = (overrides: Partial<ArenaRoomSharedConfig> = {}): ArenaRoomSharedConfig => ({
  battleMode: 'classic',
  reportFormat: 'markdown',
  combatants: [combatant('c1')],
  teams: [],
  scenario: null,
  auxScenarios: [],
  materials: [],
  userGuidance: '',
  storyLength: 'default',
  customStoryLength: null,
  selectedLanguage: 'zh-CN',
  historySettings: historySettings(),
  ...overrides,
});

const snapshot = (
  overrides: Partial<ArenaProposalEditorSnapshot> = {},
): ArenaProposalEditorSnapshot => ({
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  revision: 1,
  sharedConfig: config(),
  ...overrides,
});

describe('Web proposal editor shared-core compatibility', () => {
  it('re-exports every runtime entry unchanged, including the error class', () => {
    const entries = [
      'ArenaProposalEditorError',
      'assertArenaProposalSelection',
      'buildArenaProposalSubmitIntent',
      'createArenaProposalEditor',
      'editWorkingConfig',
      'previewArenaProposal',
      'replaceWorkingConfig',
      'resetArenaProposalEditor',
      'syncArenaProposalEditor',
    ] as const;

    expect(Object.keys(webEditor).sort()).toEqual([...entries].sort());
    for (const entry of entries) {
      expect(webEditor[entry]).toBe(sharedEditor[entry]);
    }
  });

  it('preserves instanceof and typed selection issues across both entry points', () => {
    const draft = webEditor.editWorkingConfig(
      sharedEditor.createArenaProposalEditor(snapshot()),
      (working) => ({
        ...working,
        combatants: [...working.combatants, combatant('c2', '新增角色引导')],
      }),
    );

    for (const preview of [webEditor.previewArenaProposal, sharedEditor.previewArenaProposal]) {
      let caught: unknown;
      try {
        preview(draft, ['change-2']);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(webEditor.ArenaProposalEditorError);
      expect(caught).toBeInstanceOf(sharedEditor.ArenaProposalEditorError);
      expect(caught).toMatchObject({
        code: 'selection-invalid',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'dependency-not-selected',
            changeId: 'change-2',
            dependencyId: 'change-1',
          }),
        ]),
      });
    }
  });

  it('keeps the Web draft, submit intent and room-replacement lifecycle on the shared model', () => {
    const draft = webEditor.editWorkingConfig(
      webEditor.createArenaProposalEditor(snapshot()),
      (working) => ({ ...working, userGuidance: '成员建议' }),
    );
    const incoming = snapshot({ revision: 2, sharedConfig: config({ storyLength: 'short' }) });
    const stale = webEditor.syncArenaProposalEditor(draft, incoming);

    expect(stale).toEqual(sharedEditor.syncArenaProposalEditor(draft, incoming));
    expect(stale).toMatchObject({ dirty: true, stale: true, baselineRevision: 1 });
    expect(webEditor.buildArenaProposalSubmitIntent(stale, 'proposal-1')).toEqual({
      proposalId: 'proposal-1',
      expectedRoomEpoch: 'epoch-1',
      baseRevision: 1,
      changes: [{
        changeId: 'change-1',
        type: 'setUserGuidance',
        value: '成员建议',
        expectedBase: { kind: 'value', value: '' },
      }],
    });

    const replacement = snapshot({ roomEpoch: 'epoch-2', revision: 0 });
    const fenced = webEditor.syncArenaProposalEditor(stale, replacement);
    expect(() => webEditor.buildArenaProposalSubmitIntent(fenced, 'proposal-1'))
      .toThrowError(expect.objectContaining({ code: 'replacement-required' }));
    expect(webEditor.resetArenaProposalEditor(replacement))
      .toEqual(sharedEditor.createArenaProposalEditor(replacement));
  });
});
