'use client';
import { CombatantUpdatesPresentation as SharedPresentation, type CombatantUpdatesPresentationProps as SharedProps } from '@mahoshojo/ui-web/arena-report-views';
import { MarkdownBlock } from './DeferredArenaRenderers';
export type { CombatantUpdatePresentationItem } from '@mahoshojo/ui-web/arena-report-views';
export type CombatantUpdatesPresentationProps = Omit<SharedProps, 'renderMarkdown'>;
export function CombatantUpdatesPresentation(props: CombatantUpdatesPresentationProps) {
  return <SharedPresentation {...props} renderMarkdown={(content) => <MarkdownBlock content={content} variant="light" />} />;
}
