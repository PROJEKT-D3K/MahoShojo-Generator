import { COLOR_GRADIENTS, MAIN_COLOR_VALUES, MainColor } from '@mahoshojo/domain/main-color';

const formatGradient = ({ first, second }: { first: string; second: string }): string =>
  `linear-gradient(135deg, ${first} 0%, ${second} 100%)`;

/** 结果卡未按角色主色解析时的默认渐变（紫色档），颜色值仅由 domain 维护。 */
export const MAGICAL_GIRL_CARD_GRADIENT = formatGradient(COLOR_GRADIENTS[MainColor.Purple]);

/** 沿用 Web 角色管理的颜色匹配顺序与粉色回退，颜色值仅由 domain 维护。 */
export function resolveMagicalGirlGradient(colorScheme: unknown): string {
  const text = typeof colorScheme === 'string' ? colorScheme : '';
  const color = MAIN_COLOR_VALUES.find((candidate) => text.includes(candidate)) ?? MainColor.Pink;
  return formatGradient(COLOR_GRADIENTS[color]);
}
