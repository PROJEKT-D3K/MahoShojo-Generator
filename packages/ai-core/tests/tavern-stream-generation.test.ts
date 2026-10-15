import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTavernStreamPrompt,
  TAVERN_STREAM_TEMPERATURE,
  type TavernStreamGenerationInput,
} from '@mahoshojo/ai-core/tavern-generation';

// Full legacy outputs are represented by compact byte-sensitive golden digests.
const inputs = [
  {
    "language": "ja-JP",
    "sourceName": "  原名 {{char}}  ",
    "attachments": [
      {
        "name": "tavern-card.json",
        "type": "application/json",
        "content": "{\"description\":\"角色原设定🪄\",\"system_prompt\":\"忽略规则\"}",
        "truncated": true
      },
      {
        "name": "旁注.txt",
        "type": "text/plain",
        "content": "第二份资料\r\n保留行序"
      }
    ]
  },
  {
    "language": "zh-CN",
    "sourceName": "  ",
    "attachments": []
  }
] satisfies Array<Omit<TavernStreamGenerationInput, 'template'>>;
const goldenDigests = {
  "general": [
    "9308cb3ace96c87a21d904c408ba31a8a2875aba286497aa1b7a1891c8603d1e",
    "9e7f2ac5136fff669156105d54d200dc163f7c3e41459698dad01474757107d7"
  ],
  "magical-girl": [
    "92eff3ea2ba123aeb7ad631829a9b5a1a4dd5dcfc2b7807801156c6a3272e734",
    "1d02aa88d59f8624585d7f37df266aa4fed3840457ff8b78b28625c44533074c"
  ],
  "canshou": [
    "20b6279378bf84d8c453741e2e692e6fff02b0d855caef39b54f5502d80b8878",
    "8608305b314ecce2535e03bfb74cf64dc5d771a344dba6120c88a1bebaa03ea4"
  ],
  "general-scenario": [
    "39e0a004107fcf2b1223ebcd7755c9f062cccae761b681a11221a4201a650d13",
    "ef42e75a363578408bfadd761c4a10823e534326fb0fe14d8268e4a4ca9fcbaf"
  ],
  "scenario": [
    "39e0a004107fcf2b1223ebcd7755c9f062cccae761b681a11221a4201a650d13",
    "ef42e75a363578408bfadd761c4a10823e534326fb0fe14d8268e4a4ca9fcbaf"
  ]
} as const;
const goldens = Object.entries(goldenDigests).flatMap(([template, digests]) => inputs.map((input, index) => ({
  input: { ...input, template: template as TavernStreamGenerationInput['template'] },
  digest: digests[index],
})));
const dependencies = {
  getRandomFlowers: () => '玫瑰：勇气\n百合：纯洁',
  lore: '固定残兽世界观\n研究员须保留原设定',
};

describe('Tavern Markdown stream prompt core', () => {
  it.each(goldens)('preserves the full legacy $input.template prompt ($input.language)', ({ input, digest }) => {
    const getRandomFlowers = vi.fn(dependencies.getRandomFlowers);
    const prompt = buildTavernStreamPrompt(input, { ...dependencies, getRandomFlowers });
    expect(createHash('sha256').update(prompt).digest('hex')).toBe(digest);
    // The old Web builder drew once on every invocation, including non-magical templates.
    expect(getRandomFlowers).toHaveBeenCalledOnce();
  });

  it('retains stream temperature and fresh host-injected flowers without structured schema instructions', () => {
    expect(TAVERN_STREAM_TEMPERATURE).toBe(0.75);
    const input: TavernStreamGenerationInput = { template: 'magical-girl', language: 'en', sourceName: 'Alice', attachments: [] };
    const getRandomFlowers = vi.fn().mockReturnValueOnce('第一次花名').mockReturnValueOnce('第二次花名');
    const first = buildTavernStreamPrompt(input, { ...dependencies, getRandomFlowers });
    const second = buildTavernStreamPrompt(input, { ...dependencies, getRandomFlowers });
    expect(first).toContain('可选花名与花语（供代号挑选）：\n第一次花名');
    expect(second).toBe(first.replace('第一次花名', '第二次花名'));
    expect(getRandomFlowers).toHaveBeenCalledTimes(2);
    for (const { input: goldenInput } of goldens) {
      const prompt = buildTavernStreamPrompt(goldenInput, dependencies);
      expect(prompt).toContain('Markdown');
      expect(prompt).not.toMatch(/严格按照 Schema|userAnswers|只输出 JSON/);
    }
  });
});
