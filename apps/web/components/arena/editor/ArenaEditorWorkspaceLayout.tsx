'use client';
import { ArenaEditorWorkspaceLayout as SharedArenaEditorWorkspaceLayout, buildArenaEditorSections, type ArenaEditorSemanticSection } from '@mahoshojo/ui-web/arena';

export type { ArenaEditorSectionKind } from '@mahoshojo/ui-web/arena';
export type ArenaEditorWorkspaceSection = ArenaEditorSemanticSection;

export function ArenaEditorWorkspaceLayout({ sections, disabled = false }: { readonly sections: readonly ArenaEditorWorkspaceSection[]; readonly disabled?: boolean }) {
  return <SharedArenaEditorWorkspaceLayout disabled={disabled} sections={buildArenaEditorSections(sections)} />;
}
