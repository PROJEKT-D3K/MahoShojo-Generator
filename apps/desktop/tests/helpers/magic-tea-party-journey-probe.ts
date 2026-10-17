import { withFixtureStreamReceipt } from './stream-receipt-fixture';
/** Test-only transport. It runs real Rust/SQLite/Direct HTTP with an owned synthetic library.
 * Missing MAHO_TEA_JOURNEY_BINARY may be an explicit named skip in the caller; a configured
 * invalid binary or failed ready handshake is always a failure, never an automatic skip. */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import type { DesktopAiExecutionOptions } from '../../src/platform/desktop-ai-execution';
import type { DirectAiChannel } from '../../src/platform/direct-ai-bridge';

export const TEA_JOURNEY_BINARY_ENV = 'MAHO_TEA_JOURNEY_BINARY';
export const TEA_JOURNEY_TEST = 'magic_tea_party::tests::journey::real_tea_journey_pipe';
const ROOT_MARKER = '.tea-journey-test-root';
const ROOT_CONTENT = 'synthetic-tea-journey-v1\n';
const MAX_FRAME_BYTES = 70 * 1024 * 1024;
const CONTROLS = new Set(['checkpoint', 'requestCount', 'drop-next-write-reply', 'reopen', 'snapshot', 'close']);
const COMMANDS = new Set(['read_magic_tea_party', 'mutate_magic_tea_party', 'stream_direct_ai', 'cancel_direct_ai']);

type Pending = { resolve: (_value: unknown) => void; reject: (_cause: unknown) => void; timer: ReturnType<typeof setTimeout>; channel?: DirectAiChannel };
export type MagicTeaPartyJourneyProbe = {
  root: string;
  invoke: DesktopAiExecutionOptions['invoke'];
  aiOptions: DesktopAiExecutionOptions;
  control: (_command: string, _args?: Record<string, unknown>) => Promise<unknown>;
  events: AiStreamEvent[];
  trace: Array<{ id: number; command: string }>;
  close: () => Promise<void>;
};
export type MagicTeaPartyJourneyProbeOptions = {
  binary?: string;
  root?: string;
  timeoutMs?: number;
  keepRoot?: boolean;
};

export async function startMagicTeaPartyJourneyProbe(options: MagicTeaPartyJourneyProbeOptions = {}): Promise<MagicTeaPartyJourneyProbe> {
  const configured = options.binary ?? process.env[TEA_JOURNEY_BINARY_ENV];
  if (!configured) throw new Error('MAHO_TEA_JOURNEY_BINARY is required for the real Native Tea journey');
  const binary = resolve(configured);
  if (!existsSync(binary) || !lstatSync(binary).isFile()) throw new Error('Configured Native Tea journey binary is unavailable');
  const root = options.root ? resolve(options.root) : mkdtempSync(join(tmpdir(), 'maho-tea-journey-'));
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Native Tea journey needs a private test directory');
  const marker = join(root, ROOT_MARKER);
  if (!existsSync(marker)) {
    if (readdirSync(root).length) throw new Error('Native Tea journey refuses an existing non-test library');
    writeFileSync(marker, ROOT_CONTENT, { flag: 'wx', mode: 0o600 });
  } else if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== ROOT_CONTENT) {
    throw new Error('Native Tea journey refuses an unowned test directory');
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Native Tea journey timeout must be within 1..300000 ms');
  const child = spawn(binary, ['--ignored', '--exact', TEA_JOURNEY_TEST, '--nocapture', '--quiet', '--test-threads=1'], {
    env: { ...process.env, MAHO_TEA_JOURNEY_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, Pending>();
  const events: AiStreamEvent[] = [];
  const trace: Array<{ id: number; command: string }> = [];
  let serial = 0, terminal = false, closing = false, readySeen = false, outputBytes = 0, stderrBytes = 0;
  let fatal: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let readyResolve!: () => void;
  let readyReject!: (_error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const kill = (error: Error) => {
    fatal ??= error;
    readyReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    if (!terminal) {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => { if (!terminal) child.kill('SIGKILL'); }, 1_000);
    }
  };
  const lifetime = setTimeout(() => kill(new Error('Native Tea journey exceeded its bounded process lifetime')), timeoutMs);
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 256 * 1024) kill(new Error('Native Tea journey exceeded the diagnostic budget'));
  });
  child.stdin.on('error', () => kill(new Error('Native Tea journey input pipe failed')));
  lines.on('line', line => {
    outputBytes += Buffer.byteLength(line);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES || outputBytes > 256 * 1024 * 1024) { kill(new Error('Native Tea journey exceeded its output budget')); return; }
    // libtest owns its small harness banner/result lines; application frames have no prefix.
    if (!line.startsWith('{')) return;
    try {
      const frame: unknown = JSON.parse(line);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid frame');
      const value = frame as Record<string, unknown>;
      if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) throw new Error('invalid identity');
      if (value.id === 0) {
        const marker = value.value;
        if (readySeen || Object.keys(value).sort().join() !== 'id,ok,value' || value.ok !== true || !marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error('invalid ready frame');
        const data = marker as Record<string, unknown>;
        if (Object.keys(data).sort().join() !== 'marker,profileId,version' || data.marker !== 'magic-tea-party-journey-ready'
          || data.profileId !== 'tea-loopback' || data.version !== 1) throw new Error('invalid ready marker');
        readySeen = true; readyResolve(); return;
      }
      const entry = pending.get(value.id as number);
      if (!entry) throw new Error('unexpected response identity');
      if ('event' in value) {
        if (Object.keys(value).sort().join() !== 'event,id' || !entry.channel || !value.event || typeof value.event !== 'object') throw new Error('invalid event frame');
        const event = value.event as AiStreamEvent; events.push(event); entry.channel.onmessage?.(event); return;
      }
      if (typeof value.ok !== 'boolean' || Object.keys(value).sort().join() !== (value.ok ? 'id,ok,value' : 'error,id,ok')) throw new Error('invalid result frame');
      clearTimeout(entry.timer); pending.delete(value.id as number);
      if (value.ok) entry.resolve(value.value); else entry.reject(value.error);
    } catch { kill(new Error('Native Tea journey emitted an invalid closed frame')); }
  });
  const closed = new Promise<void>((resolveClosed, rejectClosed) => {
    child.once('error', () => kill(new Error('Native Tea journey process failed to start')));
    child.once('close', code => {
      terminal = true; clearTimeout(lifetime); if (killTimer) clearTimeout(killTimer); lines.close();
      const error = fatal ?? new Error(`Native Tea journey exited unexpectedly (${String(code)})`);
      if (!readySeen) readyReject(error);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
      if (!options.root && !options.keepRoot) rmSync(root, { recursive: true, force: true });
      if (fatal || code !== 0 || !closing) rejectClosed(error); else resolveClosed();
    });
  });
  void closed.catch(() => {});
  const call = (command: string, args: Record<string, unknown> = {}, channel?: DirectAiChannel): Promise<unknown> => {
    if (terminal || fatal || (closing && command !== 'close')) return Promise.reject(fatal ?? new Error('Native Tea journey is closed'));
    const id = ++serial;
    let frame: string;
    try { frame = JSON.stringify({ id, command, args }); }
    catch { return Promise.reject(new Error('Native Tea journey needs JSON arguments')); }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error('Native Tea journey input exceeds its frame budget'));
    trace.push({ id, command });
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => kill(new Error('Native Tea journey request timed out')), timeoutMs);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer, channel });
      child.stdin.write(frame + '\n');
    });
  };
  // The pipe calls Rust directly and bypasses the Tauri command receipt layer.
  const invoke: DesktopAiExecutionOptions['invoke'] = withFixtureStreamReceipt((command: string, args: Record<string, unknown> = {}) => {
    if (!COMMANDS.has(command)) return Promise.reject(new Error('Native Tea journey command is outside the closed test allowlist'));
    if (command !== 'stream_direct_ai') return call(command, args);
    const channel = args.onEvent;
    if (!channel || typeof channel !== 'object') return Promise.reject(new Error('Native Tea journey stream requires a Channel'));
    const wire = { ...args }; delete wire.onEvent;
    return call(command, wire, channel as DirectAiChannel);
  });
  try { await ready; } catch (error) { kill(new Error('Native Tea journey did not establish its ready handshake')); await closed.catch(() => {}); throw error; }
  return {
    root, invoke, aiOptions: { invoke, profileId: 'tea-loopback', createChannel: () => ({}) }, events, trace,
    control: (command, args = {}) => CONTROLS.has(command) && command !== 'close' ? call(command, args) : Promise.reject(new Error('Unsupported Native Tea journey control')),
    close: async () => {
      if (!closing && !terminal) {
        closing = true;
        try { await call('close'); child.stdin.end(); }
        catch { kill(new Error('Native Tea journey close failed')); }
      }
      await closed;
    },
  };
}
