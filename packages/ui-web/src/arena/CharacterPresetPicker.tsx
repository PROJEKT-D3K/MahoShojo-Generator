'use client';

import type { Preset } from '@mahoshojo/domain/presets';
import { PresetGridPicker, type PresetGridPickerProps } from './PresetGridPicker';

export interface CharacterPresetPickerProps extends Omit<PresetGridPickerProps<Preset>, 'title' | 'presets' | 'currentPage' | 'onPageChange'> {
  grouped: { magicalGirl: Preset[]; canshou: Preset[] };
  magicalGirlPage: number;
  onMagicalGirlPageChange: (page: number) => void;
  canshouPage: number;
  onCanshouPageChange: (page: number) => void;
}

/** Web 与 Desktop 共用的双分组预设区段；读取、选择和下载由宿主提供。 */
export function CharacterPresetPicker({ grouped, magicalGirlPage, onMagicalGirlPageChange, canshouPage, onCanshouPageChange, ...props }: CharacterPresetPickerProps) {
  return (
    <>
      <PresetGridPicker {...props} title="选择预设魔法少女" presets={grouped.magicalGirl} currentPage={magicalGirlPage} onPageChange={onMagicalGirlPageChange} />
      <PresetGridPicker {...props} title="选择预设残兽" presets={grouped.canshou} currentPage={canshouPage} onPageChange={onCanshouPageChange} />
    </>
  );
}
