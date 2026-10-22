// Lightweight controls stay eager while Markdown report cards load on demand.
export { ArenaWebDisplayModeSelectorView, ArenaWebImmersiveButton, ArenaWebViewer, ARENA_WEB_FRAME_CLASS_NAME, type ArenaWebDisplayMode, type ArenaWebViewerProps } from './ArenaWebViewer';
export { useArenaWebImmersive } from './useArenaWebImmersive';
export { WebPackageRiskSummary } from './WebPackageRiskSummary';
export {
  ArenaReportFormatSelectorView, ArenaWebNotes, ArenaWebSourceView, ArenaWebReportActions, ArenaWebResultView,
  type ArenaReportFormatSelectorViewProps, type ArenaWebNotesProps, type ArenaWebReportAction,
  type ArenaWebExecutionCapability, type ArenaWebResultViewProps,
} from './ArenaWebResultView';
export { ArenaWebReplayControlsView, type ArenaWebReplayControlsViewProps } from './ArenaWebReplayControlsView';
export { WebReportConsentDialogView, type WebReportConsentDialogViewProps } from './WebReportConsentDialogView';

export { CombatantUpdatesPresentation, type CombatantUpdatesPresentationProps, type CombatantUpdatePresentationItem } from './CombatantUpdatesPresentation';
export { CombatantRepairPanel } from './CombatantRepairPanel';
