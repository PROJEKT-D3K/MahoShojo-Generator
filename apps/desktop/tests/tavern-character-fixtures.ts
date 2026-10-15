import { createBlankDataCard } from '@mahoshojo/domain/sublimation';
import type { TavernAiTemplate } from '../src/features/tavern/generation';

export const tavernModelResult = (template: TavernAiTemplate) => template === 'magical-girl'
  ? { ...createBlankDataCard('magical-girl'), codename: '星花', appearance: { outfit: '裙装', accessories: '花饰', colorScheme: '粉色', overallLook: 'AI 整理正文' }, userAnswers: [{ question: '信念', answer: '守护朋友', questionId: 'MG-1' }] }
  : template === 'canshou'
  ? { ...createBlankDataCard('canshou'), name: '雾兽', appearance: 'AI 整理正文', userAnswers: [{ question: '欲望', answer: '迷雾', questionId: 'CS-1' }] }
  : template === 'scenario'
  ? { title: '情景', scenario_type: '互动', description: '简介', elements: { scene: {}, events: '事件', atmosphere: '轻松', development: [] } }
  : { name: '角色', title: '情景', content: '正文' };
