export type ArenaCardLibraryPurpose = 'character' | 'scenario' | 'auxScenario' | 'material';

/** UI limits include already selected rows, while references share the remaining total budget. */
export function getArenaCardLibrarySelectionOptions(input: {
  purpose: ArenaCardLibraryPurpose;
  characterCount: number;
  characterMaxSelected?: number;
  auxiliaryScenarioCount: number;
  materialCount: number;
  referenceRemainingCapacity: number;
}) {
  if (input.purpose === 'scenario') return { selectionMode: 'single' as const };
  const selectedCountOverride = input.purpose === 'character' ? input.characterCount
    : input.purpose === 'auxScenario' ? input.auxiliaryScenarioCount : input.materialCount;
  return {
    selectionMode: 'multi' as const,
    selectedCountOverride,
    maxSelected: input.purpose === 'character' ? input.characterMaxSelected
      : selectedCountOverride + Math.max(0, input.referenceRemainingCapacity),
  };
}
