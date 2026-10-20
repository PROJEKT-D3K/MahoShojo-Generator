export {
  MagicalGirlCard,
  type MagicalGirlCardProps,
} from './MagicalGirlCard';
export {
  GeneralCharacterCard,
  type GeneralCharacterCardProps,
} from './GeneralCharacterCard';
export {
  CanshouCard,
  type CanshouCardProps,
} from './CanshouCard';
export {
  InlineField,
  type InlineFieldProps,
} from './InlineField';
export {
  CurrentStatePanel,
  type CurrentStatePanelProps,
} from './CurrentStatePanel';
export {
  CharacterParameterSection,
} from './CharacterParameterSection';
export {
  useCardImageSave,
  type UseCardImageSaveParams,
  type UseCardImageSaveResult,
} from './internals';
export type {
  CardImageSaveMode,
  CharacterCardCommonProps,
  CharacterCardHostExtras,
  CharacterCardMarkdown,
  CharacterCardPortraitAsset,
  CharacterCardPortraitSource,
  CharacterParameterEntry,
  CharacterParameterRuleSection,
  CharacterParameterRuleView,
  CharacterParameterSourceKey,
  CharacterParameterSourceView,
  CharacterParameterView,
  CanshouDetails,
  GeneralCharacterCardData,
  GeneralCharacterDetails,
  MagicalGirlCardData,
} from './types';
export { MAGICAL_GIRL_CARD_GRADIENT, resolveMagicalGirlGradient } from './gradient';

/** 截图中的当前导出账号，不代表角色原作者或数字签名。 */
export const CHARACTER_CARD_EXPORTER_LABEL = '导出者：';
