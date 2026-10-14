import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import type { DesktopHostedJsonResponse } from '@mahoshojo/contracts/desktop-cloud';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } from '@mahoshojo/domain/tavern-card';
import { executeTavernGeneration } from '../src/features/tavern/generation';

type Reply = { response?: DesktopHostedJsonResponse; error?: unknown; observed: { method: string; path: string; body: Record<string, unknown> } };
const TEST = 'cloud::tests::tavern_conversion::real_tavern_hosted_pipe';

describe('Tavern renderer through real Native Hosted HTTP', () => {
  it.skipIf(!process.env.MAHO_TAVERN_HOSTED_BINARY)('uses the fixed path and trusted system/preset config for both unsigned templates', async () => {
    const child = spawn(process.env.MAHO_TAVERN_HOSTED_BINARY!, ['--ignored', '--exact', TEST, '--nocapture', '--quiet', '--test-threads=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
    let outputBytes = 0, stderr = '', failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; rejectReady(error); pending?.reject(error); pending = undefined; child.kill(); };
    const timer = setTimeout(() => fail(new Error('Native Tavern pipe timed out')), 15_000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 64 * 1024) fail(new Error('Native Tavern diagnostic budget exceeded')); });
    lines.on('line', line => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > 2 * 1024 * 1024) { fail(new Error('Native Tavern test output budget exceeded')); return; }
      if (line === 'TAVERN_HOSTED_READY') { resolveReady(); return; }
      if (!line.startsWith('TAVERN_HOSTED_RESULT ')) return;
      try {
        if (!pending) throw new Error('Unexpected Native Tavern reply');
        const reply = JSON.parse(line.slice('TAVERN_HOSTED_RESULT '.length)) as Reply;
        const owner = pending; pending = undefined; owner.resolve(reply);
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid pipe reply')); }
    });
    const closed = new Promise<number | null>(resolve => child.once('close', code => {
      if (pending || code !== 0) fail(new Error(`Native Tavern pipe exited ${code}: ${stderr.slice(-2000)}`));
      resolve(code);
    }));
    try {
      await ready;
      for (const template of ['general', 'general-scenario'] as const) {
        for (const kind of ['system', 'preset'] as const) {
          let observed: Reply['observed'] | undefined;
          const raw = { name: 'Alice', description: '{{user}} 对 {{char}} 说话', extensions: { keep: true } };
          const outcome = await executeTavernGeneration({ profileId: '', providerTarget: kind === 'system' ? { kind } : { kind, providerId: 'deepseek' }, invoke: async (command, args) => {
            expect(command).toBe('hosted_ai_request');
            if (failure) throw failure;
            const promise = new Promise<Reply>((resolve, reject) => { pending = { resolve, reject }; });
            child.stdin.write(`${JSON.stringify({ request: args?.request, responseBody: { aiMeta: null, data: { name: '角色', title: '情景', content: '正文', signature: 'synthetic-forged', _tavern: { raw: { name: 'untrusted' } } } } })}\n`);
            const reply = await promise; observed = reply.observed;
            if (reply.error) throw reply.error;
            return reply.response;
          } }, { raw, template, language: 'zh-CN', preference: DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE }, {
            requestId: `native-${template}-${kind}`, mode: 'hosted-json', generationMode: 'non-stream', modelId: kind === 'system' ? 'default' : 'deepseek-chat',
          }, new AbortController().signal);
          expect(outcome).toMatchObject({ status: 'completed', cardKind: template, card: { content: '正文', _tavern: { raw } } });
          if (outcome.status !== 'completed') throw new Error('Expected real Native completion');
          expect(outcome.card).not.toHaveProperty('signature');
          expect(observed).toMatchObject({ method: 'POST', path: '/api/tavern/convert', body: { template, language: 'zh-CN' } });
          expect(observed!.body).not.toHaveProperty('raw'); expect(observed!.body).not.toHaveProperty('preference');
          if (kind === 'preset') expect(observed!.body.customProvider).toMatchObject({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'fake-tavern-key' });
          else expect(observed!.body).not.toHaveProperty('customProvider');
        }
      }
      child.stdin.end(); expect(await closed).toBe(0); if (failure) throw failure;
    } finally { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); }
  }, 20_000);
});
