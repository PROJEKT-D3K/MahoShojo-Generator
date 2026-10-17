import { expect, test } from 'vitest';
import { getArenaCardLibrarySelectionOptions } from '../src/arena/card-library-selection';
const counts = { characterCount: 2, characterMaxSelected: 32, auxiliaryScenarioCount: 3, materialCount: 5, referenceRemainingCapacity: 7 };
test('main scenario remains single; multi pickers count owned selections and the remaining shared budget', () => {
  expect(getArenaCardLibrarySelectionOptions({ ...counts, purpose: 'scenario' })).toEqual({ selectionMode: 'single' });
  expect(getArenaCardLibrarySelectionOptions({ ...counts, purpose: 'character' })).toEqual({ selectionMode: 'multi', selectedCountOverride: 2, maxSelected: 32 });
  expect(getArenaCardLibrarySelectionOptions({ ...counts, purpose: 'auxScenario' })).toEqual({ selectionMode: 'multi', selectedCountOverride: 3, maxSelected: 10 });
  expect(getArenaCardLibrarySelectionOptions({ ...counts, purpose: 'material' })).toEqual({ selectionMode: 'multi', selectedCountOverride: 5, maxSelected: 12 });
  expect(getArenaCardLibrarySelectionOptions({ ...counts, purpose: 'material', referenceRemainingCapacity: -1 }).maxSelected).toBe(5);
});
