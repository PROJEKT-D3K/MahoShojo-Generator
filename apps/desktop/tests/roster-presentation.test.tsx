import { rankingParticipant, rankingQueue } from './helpers/generation-ranking-fixture';
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
  it.each([
    ['女王', '花牌', '女王', '严格'],
    ['无牌', '女王', '无牌', '严格'],
    [null, '女王', '女王', '自由'],
  ] as const)('当前段位严格优先仅一枚徽章：%s / %s', (strict, free, expected, label) => {
    const extras = buildDesktopRosterExtras(card(), vi.fn(), { techScore: 0, techLevel: null, strictTier: '白牌' }, {
      hasSource: true, rating: { strict: 1600, free: 1600, tiers: { strict, free } }, prediction: null,
    });
    const markup = render(extras.rankingBadge);
    expect(markup).toContain(`>${expected}</span>`);
    expect(markup).toContain(`(${label})`);
    expect(markup.match(/>(?:无牌|白牌|字牌|花牌|权杖|女王)<\/span>/g)).toHaveLength(1);
    expect(markup).not.toContain('选卡时快照');
    expect(markup).toContain('当前实体段位观察值');
  });
  it('旧服务缺段位只回退明确标注的选卡快照，不从分数推断完整段位', () => {
    const observation = { hasSource: true, rating: { strict: 1700, free: 1600 }, prediction: null };
    const metadata = { techScore: 0, techLevel: null, strictTier: '花牌' };
    const withSnapshot = render(buildDesktopRosterExtras(card(), vi.fn(), metadata, observation).rankingBadge);
    expect(withSnapshot).toContain('花牌'); expect(withSnapshot).toContain('严格·选卡时快照');
    const absent = render(buildDesktopRosterExtras(card(), vi.fn(), undefined, observation).rankingBadge);
    expect(absent).not.toMatch(/无牌|白牌|字牌|花牌|权杖|女王/);
    const disabled = render(buildDesktopRosterExtras(card(), vi.fn(), metadata, {
      ...observation, hasSource: false, rating: { ...observation.rating, tiers: { strict: '女王', free: '女王' } },
    }).rankingBadge);
    expect(disabled).toContain('严格·选卡时快照'); expect(disabled).not.toContain('女王');
  });
  it('当前徽章与本局历史分开，历史段位不冒充当前观察值', () => {
    const participant = rankingParticipant('data_card:a', { queues: {
      strict: rankingQueue({ rating: 1600, tier: '女王', delta: 10 }), free: rankingQueue(),
    } });
    const observation = { hasSource: true, rating: { strict: 1100, free: 1000, tiers: { strict: '字牌' as const, free: '白牌' as const } }, prediction: null };
    const extras = buildDesktopRosterExtras(card(), vi.fn(), undefined, observation, participant);
    expect(render(extras.rankingBadge)).toContain('字牌'); expect(render(extras.rankingBadge)).not.toContain('女王');
    expect(render(extras.ranking)).toContain('严格：1100'); expect(render(extras.ranking)).toContain('严格：1600');
    expect(render(extras.ranking)).toContain('本局排位结算（生成时）'); expect(render(extras.ranking)).toContain('本局变化：Δ+10');
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

// 真实共享反馈组件，不替换队列语义；历史与当前观察/预测各自保留。
it.each(['applied', 'pending', 'skipped', 'failed', 'missing'] as const)('本局历史双队列 %s 不冒充当前正文资格，也不改当前预测', eventStatus => {
  const participant = rankingParticipant('data_card:a', { queues: {
    strict: rankingQueue({ eventStatus, skipReason: 'winner-empty' }),
    free: rankingQueue({ eventStatus, skipReason: 'winner-empty' }),
  } });
  const prediction = { queue: 'strict' as const, selfRating: 1200, opponentRating: 1000, expectedScore: 0.76, expectedPct: 76 };
  const observation = { hasSource: true, rating: { strict: 1200, free: 1000 }, prediction };
  const baseline = render(buildDesktopRosterExtras(card(), vi.fn(), undefined, observation).ranking);
  const markup = render(buildDesktopRosterExtras(card(), vi.fn(), undefined, observation, participant).ranking);
  expect(markup).toContain(baseline);
  expect(markup).toContain('本局排位结算（生成时）');
  expect(markup).toContain('不代表更新后的正文获计分或具有严格排位资格');
  expect(markup).toContain('严格：0'); expect(markup).toContain('自由：0');
  expect(markup).not.toContain('无牌');
  const labels = { applied: '本局变化：Δ+0', pending: '结算中', skipped: '未计分', failed: '结算失败', missing: '暂无结算记录，状态待确认' };
  expect(markup).toContain(labels[eventStatus]);
});
