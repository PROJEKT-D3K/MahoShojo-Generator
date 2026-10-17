import {
  DETAILS_FIELD_GUIDE_THEME,
  DETAILS_SAVE_PREFERENCES_THEME,
  DetailsFieldGuidePanel,
  DetailsSavePreferencesPanel,
  type DetailsSavePreferencesPanelProps,
} from '../details-controls';
import type { CreatorResultKind } from './result-follow-up';

const savePreferencesTheme = {
  ...DETAILS_SAVE_PREFERENCES_THEME,
  groupTitle: 'font-medium text-blue-900',
};
const fieldGuideTheme = {
  ...DETAILS_FIELD_GUIDE_THEME,
  toggleButton: 'text-lg font-medium text-blue-900 hover:text-blue-700 transition-colors duration-200',
  sectionTitle: 'font-medium text-blue-800 mb-2',
};

export interface CreatorResultPreferencesProps extends Omit<DetailsSavePreferencesPanelProps, 'theme'> {
  /** 已生成结果的种类，不是当前编辑中的模板。 */
  resultKind: CreatorResultKind | null;
  showDetails: boolean;
  onToggleDetails: () => void;
}

export function CreatorResultPreferences({
  resultKind,
  showDetails,
  onToggleDetails,
  ...savePreferences
}: CreatorResultPreferencesProps) {
  if (resultKind !== 'magical-girl' && resultKind !== 'canshou') return null;
  return (
    <>
      <DetailsSavePreferencesPanel {...savePreferences} theme={savePreferencesTheme} />
      {resultKind === 'magical-girl' && (
        <DetailsFieldGuidePanel theme={fieldGuideTheme} expanded={showDetails} onToggle={onToggleDetails} />
      )}
    </>
  );
}
