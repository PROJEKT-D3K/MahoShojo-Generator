import { isWantuDataCard, convertWantuDataCardToGeneralCharacter } from './wantu-card/wantu-data-card';
import {
  getCombatantDisplayName,
  inferCombatantType,
  isLegacyAdjudicatorFormat,
  validateCanshouData,
  validateGeneralCharacterData,
  validateMagicalGirlData,
} from './arena-character-validator';

export type CombatantType = 'magical-girl' | 'canshou' | 'general-character';
/** 面向用户的类型名称；传输仍使用稳定的 canonical type。 */
export const COMBATANT_TYPE_LABELS: Readonly<Record<CombatantType, string>> = {
  'magical-girl': '魔法少女', canshou: '残兽', 'general-character': '通用角色',
};
export function getCombatantTypeLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(COMBATANT_TYPE_LABELS, type) ? COMBATANT_TYPE_LABELS[type as CombatantType] : '未知角色';
}
export interface CombatantData {
  type: CombatantType;
  data: any;
  filename: string;
  isValid: boolean;
  isPreset: boolean;
  isNonStandard?: boolean;
  wasCorrected?: boolean;
  teamId?: number;
  /** 从多人 authority materialize 后保留原始 opaque resource key。 */
  arenaRoomKey?: string;
  adjudicationSourceKey?: string;
  /** Library row identity for selection UI only; never a server reference or card-body field. */
  cardLibrarySelectionId?: string;
  /** 用户对该角色的行动/想法引导（可选，最多 100 字）。 */
  characterGuidance?: string;
  sourceDataCardId?: string;
  sourceDataCardDescription?: string;
  sourceDataCardCreatedAt?: string;
  sourceDataCardUpdatedAt?: string;
  sourceDataCardName?: string;
  sourceIsPublic?: boolean;
  sourceAuthor?: string;
  sourceDataCardUsageCount?: number;
  sourceDataCardLikeCount?: number;
  sourceDataCardFavoriteCount?: number;
}

/** Legacy online inputs retain their cloud UI identity; names and card-body fields cannot supply it. */
export const getCombatantCardLibrarySelectionId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.cardLibrarySelectionId === 'string' && /^(cloud|local|cache):.+$/.test(item.cardLibrarySelectionId)) return item.cardLibrarySelectionId;
  return typeof item.sourceDataCardId === 'string' && item.sourceDataCardId.trim()
    ? `cloud:${item.sourceDataCardId.trim()}` : null;
};

export interface ParseOptions {
  existingCount: number;
  /** Host admission cap. Omitted/null keeps the existing Web uncapped import behavior. */
  maxCombatants?: number | null;
  onWarn?: (message: string) => void;
  onError?: (message: string) => void;
  onAdjudicationEvents?: (events: unknown, label: string) => void;
  verifyOrigin?: (payload: any) => Promise<boolean>;
}

const readJsonArray = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    const sanitized = `[${text.trim().replace(/}\s*{/g, '},{')}]`;
    return JSON.parse(sanitized);
  }
};

export const parseCombatantsFromText = async (text: string, options: ParseOptions): Promise<CombatantData[]> => {
  const parsed = readJsonArray(text);
  const dataArray = Array.isArray(parsed) ? parsed : [parsed];

  if (typeof options.maxCombatants === 'number' && dataArray.length + options.existingCount > options.maxCombatants) {
    throw new Error(`队伍将超出 ${options.maxCombatants} 位上限！`);
  }

  const combatants: CombatantData[] = [];

  for (let item of dataArray) {
    if (isWantuDataCard(item)) {
      const converted = convertWantuDataCardToGeneralCharacter(item);
      if (converted) {
        options.onWarn?.(`检测到万途AI数据卡格式，已自动转换为通用角色。`);
        item = converted;
      }
    }
    const type = inferCombatantType(item);
    const label = getCombatantDisplayName(item);
    let validationResult;

    try {
      if (type === 'magical-girl') {
        validationResult = validateMagicalGirlData(item);
      } else if (type === 'canshou') {
        validationResult = validateCanshouData(item);
      } else {
        validationResult = validateGeneralCharacterData(item);
      }

      if (!validationResult.success) {
        throw new Error(validationResult.errors?.[0] || '格式验证失败');
      }

      validationResult.warnings?.forEach((warning) => options.onWarn?.(`✔️ 文件 "${label}"：${warning}`));

      if (Array.isArray((item as Record<string, unknown>).adjudicationEvents)) {
        const events = (item as Record<string, unknown>).adjudicationEvents as unknown[];
        if (isLegacyAdjudicatorFormat(events as any[])) {
          options.onWarn?.(`⚠️ 文件 "${label}" 包含旧版随机事件，已忽略。`);
        } else {
          options.onAdjudicationEvents?.(events, label);
        }
      }

      const isValid = options.verifyOrigin ? await options.verifyOrigin(item) : false;
      const wasCorrected = Boolean(validationResult.warnings?.length);
      combatants.push({
        type,
        data: validationResult.data ?? item,
        filename: label,
        isValid,
        isPreset: false,
        isNonStandard: false,
        wasCorrected,
      });
    } catch (error) {
      if (item && (item.codename || item.name || item.content)) {
        options.onWarn?.(`✔️ 文件 "${label}" 格式不完全规范，已通过兼容模式加载。`);
        combatants.push({
          type,
          data: item,
          filename: label,
          isValid: false,
          isPreset: false,
          isNonStandard: true,
        });
      } else {
        options.onError?.(error instanceof Error ? error.message : '未知错误');
        throw error;
      }
    }
  }

  return combatants;
};
