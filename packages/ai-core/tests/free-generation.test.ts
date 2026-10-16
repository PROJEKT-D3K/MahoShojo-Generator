import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';

import {
  FREE_GENERATION_SCHEMAS,
  FREE_GENERATION_SCHEMA_IDS,
  FREE_STREAM_SCHEMA_IDS,
  FREE_STREAM_TEMPERATURE,
  buildFreeStreamPrompt,
  buildFreeStructuredPrompt,
  createFreeGenerationConfig,
  isFreeStreamSchemaId,
  sanitizeFreeCard,
  validateFreeOutput,
  type FreeSchemaId,
  type FreeStreamSchemaId,
} from '@mahoshojo/ai-core/free-generation';
import {
  formatReferenceAttachmentsForPrompt,
  type AITextAttachment,
} from '@mahoshojo/ai-core/reference-attachments';

const legacy = JSON.parse(
  readFileSync(new URL('../fixtures/free-generation-legacy.json', import.meta.url), 'utf8'),
);
const describeSchema = (schema: z.ZodTypeAny): unknown => {
  let core = schema;
  let optional = false;
  for (let i = 0; i < 8; i++) {
    const def = (core as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    if (def?.typeName === 'ZodOptional' || def?.typeName === 'ZodNullable' || def?.typeName === 'ZodDefault') {
      optional = true;
      core = def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }
  const out: Record<string, unknown> = {
    type: (core as { _def?: { typeName?: string } })._def?.typeName,
    ...(optional ? { optional: true } : {}),
  };
  if (core instanceof z.ZodObject) {
    out.shape = Object.fromEntries(
      Object.entries(core.shape).map(([key, value]) => [
        key,
        describeSchema(value as z.ZodTypeAny),
      ]),
    );
  }
  if (core instanceof z.ZodArray) {
    out.element = describeSchema(core.element as z.ZodTypeAny);
  }
  return out;
};

describe('free shared generation', () => {
  it('schema 注册表与 wire 枚举/流式子集一致', () => {
    expect([...FREE_GENERATION_SCHEMA_IDS]).toEqual([
      'magical-girl', 'canshou', 'scenario', 'general', 'general-scenario',
    ]);
    expect([...FREE_STREAM_SCHEMA_IDS]).toEqual(['general', 'general-scenario']);
    expect(Object.keys(FREE_GENERATION_SCHEMAS).sort()).toEqual(
      [...FREE_GENERATION_SCHEMA_IDS].sort(),
    );
    for (const id of FREE_GENERATION_SCHEMA_IDS) {
      expect(isFreeStreamSchemaId(id)).toBe(
        (FREE_STREAM_SCHEMA_IDS as readonly string[]).includes(id),
      );
    }
  });

  it.each(legacy.cases as {
    schemaId: FreeSchemaId;
    input: { prompt: string; language: string; attachments: AITextAttachment[] };
    temperature: number;
    taskName: string;
    schema: unknown;
    output: unknown;
  }[])('保留 $schemaId 的 schema、用户输入与输出清洗行为', (fixture) => {
    const config = createFreeGenerationConfig(fixture.schemaId);
    expect(config.temperature).toBe(fixture.temperature);
    expect(config.taskName).toBe(fixture.taskName);
    expect(describeSchema(config.schema)).toEqual(fixture.schema);
    const prompt = config.promptBuilder(fixture.input);
    expect(prompt).toBe(buildFreeStructuredPrompt({
      schema: fixture.schemaId,
      ...fixture.input,
    }));
    expect(prompt).toContain(fixture.input.prompt);
    expect(prompt).toContain(fixture.input.language);
    for (const attachment of fixture.input.attachments) {
      expect(prompt).toContain(attachment.name);
      expect(prompt).toContain(attachment.content);
    }
    expect(
      validateFreeOutput({
        schemaId: fixture.schemaId,
        data: sanitizeFreeCard(fixture.schemaId, fixture.output, '2026-10-06T00:00:00.000Z'),
      }),
    ).toEqual(fixture.output);
  });

  it.each(legacy.streamCases as {
    schemaId: FreeStreamSchemaId;
    input: { prompt: string; language: string; attachments: AITextAttachment[] };
  }[])('向 $schemaId 流式生成传入提示词、语言与附件', (fixture) => {
    const prompt = buildFreeStreamPrompt({
      schema: fixture.schemaId,
      ...fixture.input,
    });
    expect(prompt).toContain(fixture.input.prompt);
    expect(prompt).toContain(fixture.input.language);
    for (const attachment of fixture.input.attachments) {
      expect(prompt).toContain(attachment.name);
      expect(prompt).toContain(attachment.content);
    }
    expect(FREE_STREAM_TEMPERATURE).toBe(0.75);
  });

  it('参考附件 formatter 忽略空输入，并保留附件内容与元数据', () => {
    expect(formatReferenceAttachmentsForPrompt([])).toBe('');
    expect(formatReferenceAttachmentsForPrompt([{ name: 'a', content: '   ' } as AITextAttachment])).toBe('');
    const formatted = formatReferenceAttachmentsForPrompt([
      { name: 'a.txt', type: 'text/plain', size: 5, content: 'abc' },
    ]);
    expect(formatted).toContain('提示攻击');
    expect(formatted).toContain('a.txt');
    expect(formatted).toContain('text/plain');
    expect(formatted).toContain('5 bytes');
    expect(formatted).toContain('abc');
  });

  it('参考附件 formatter 遵守单文件、总字符数与文件数量限制', () => {
    const attachments = [
      { name: 'first.txt', content: 'ABCD超出单文件限制' },
      { name: 'second.txt', content: 'EF超出总字符限制' },
      { name: 'third.txt', content: '超出文件数量限制' },
    ];
    const limits = {
      maxBytesPerFile: 100, maxBytesTotal: 300,
      maxCharsPerFile: 4, maxCharsTotal: 6, maxCount: 2,
    };
    const formatted = formatReferenceAttachmentsForPrompt(attachments, { limits });
    expect(formatted).toContain('ABCD');
    expect(formatted).toContain('EF');
    expect(formatted).not.toContain('超出');
    expect(formatted).not.toContain('third.txt');

    const oneFile = formatReferenceAttachmentsForPrompt(attachments, {
      limits: { ...limits, maxCharsTotal: 100, maxCount: 1 },
    });
    expect(oneFile).toContain('first.txt');
    expect(oneFile).not.toContain('second.txt');
  });
});
