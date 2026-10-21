import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMBATANT_TYPE_LABELS, getCombatantTypeLabel } from '@mahoshojo/domain/arena-file-parser';
import { computeTechIndex } from '@mahoshojo/domain/metrics/tech-index';
import { computeTechIndex as legacyComputeTechIndex } from '@mahoshojo/hosted-runtime/metrics/tech-index';
import { buildDesktopRosterExtras, snapshotDesktopRosterDetails, readDesktopRosterMetadata } from '../src/features/arena/roster-presentation';
import type { ArenaDraft } from '../src/features/arena/session';
const card = (): ArenaDraft['combatants'][number] => ({ type: 'general-character', filename: '角色.json', isPreset: false, isValid: false, data: { name: '测试角色', content: '原文', signature: 'not-verified' } });
const render = (node: unknown) => renderToStaticMarkup(<>{node as import('react').ReactNode}</>);
describe('已选角色展示', () => {
  it('使用共源中文类型和技术算法，无元数据也可离线展示', () => {
    expect(Object.values(COMBATANT_TYPE_LABELS)).toEqual(['魔法少女', '残兽', '通用角色']);
    expect(getCombatantTypeLabel('magical-girl')).toBe('魔法少女');
    expect(getCombatantTypeLabel('future-type')).toBe('未知角色');
    expect(getCombatantTypeLabel('__proto__')).toBe('未知角色');
    expect(legacyComputeTechIndex).toBe(computeTechIndex);
    const value = card(); const extras = buildDesktopRosterExtras(value, vi.fn());
    expect(render(extras.ranking)).toContain(`技术值：${computeTechIndex(value.data).techScore}`);
    expect(render(extras.rankingBadge)).toContain(computeTechIndex(value.data).techLevel);
    expect(render(extras.tags)).not.toContain('原生');
    expect(render(extras.rankingBadge)).not.toContain('无牌');
  });
  it('保留真实展示快照，不把线上指标转换为原生或修改正文', () => {
    const value = { ...card(), isPreset: true, isNonStandard: true, wasCorrected: true }; const before = structuredClone(value);
    const open = vi.fn(); const extras = buildDesktopRosterExtras(value, open, { techScore: 0, techLevel: 'L0', strictTier: '无牌' });
    expect(render(extras.ranking)).toContain('技术值：0');
    expect(render(extras.rankingBadge)).toContain('无牌');
    expect(render(extras.tags)).toContain('预设'); expect(render(extras.tags)).toContain('格式已修正'); expect(render(extras.tags)).not.toContain('原生');
    extras.onShowDetails?.(); expect(open).toHaveBeenCalledOnce(); expect(value).toEqual(before);
  });
  it('展示快照穿过草稿克隆，身份或正文改变后失效且不串卡', () => {
    const value = { ...card(), cardLibrarySelectionId: 'cloud:one' };
    const metadata = { techScore: 77, techLevel: 'L4', strictTier: '无牌' };
    const snapshots = new Map([['cloud:one', { body: JSON.stringify(value.data), metadata }]]);
    expect(readDesktopRosterMetadata(structuredClone(value), snapshots)).toEqual(metadata);
    expect(readDesktopRosterMetadata({ ...value, cardLibrarySelectionId: 'cloud:two' }, snapshots)).toBeUndefined();
    expect(readDesktopRosterMetadata({ ...value, data: { ...value.data, content: '编辑后' } }, snapshots)).toBeUndefined();
    snapshots.clear(); expect(readDesktopRosterMetadata(value, snapshots)).toBeUndefined();
  });
  it('详情冻结选中正文，后续改动或删除不能改为另一行', () => {
    const value = card(); const details = snapshotDesktopRosterDetails(value);
    value.data.content = '已变化';
    expect(JSON.parse(details.card.data).content).toBe('原文');
    expect(details.source.kind).toBe('local'); expect(details.card.isPublic).toBe(false);
    expect(snapshotDesktopRosterDetails({ ...value, isPreset: true, desktopSource: 'preset' }).source.kind).toBe('preset');
    expect(snapshotDesktopRosterDetails({ ...value, isPreset: true }).source.kind).toBe('local');
  });
});
