import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { acceptancePaths, buildArguments, launchEnvironment, main, PATCH_FILES, patchSources, preflight, prepare, runAcceptance, runBuild, validatePrepared } from '../scripts/desktop-tavern-acceptance.mjs';
import { SYNTHETIC_CARD } from '../scripts/desktop-tavern-acceptance-mock.mjs';
import * as common from '../scripts/desktop-acceptance-common.mjs';
import * as story from '../scripts/desktop-story-acceptance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const original = Object.fromEntries(PATCH_FILES.map((file: string) => [file, readFileSync(path.join(root, file), 'utf8')]));
const id = 'me.colanns.mahoshojo.desktop.tavernacceptance.h' + '1'.repeat(32);
const origin = 'http://127.0.0.1:24185';
const roots: string[] = [];
function temporary() { const value = mkdtempSync(path.join(tmpdir(), 'tavern-acceptance-')); roots.push(value); return value; }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fixture(parent: string, name: string) {
  const directory = path.join(parent, name); mkdirSync(path.join(directory, 'apps/desktop/src-tauri/src'), { recursive: true });
  for (const [file, source] of Object.entries(original)) writeFileSync(path.join(directory, file), source);
  git(directory, 'init'); git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', 'commit', '-m', 'synthetic fixture');
  return directory;
}
async function prepared() {
  const parent = temporary(), source = fixture(parent, 'source'), testTree = fixture(parent, 'test');
  const plan = await preflight({ source, testTree, stateRoot: path.join(parent, 'state'), origin });
  prepare(plan); return { plan, source, testTree };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// These exercise isolation and process contracts, never a real Windows/Tauri pass.
describe('disposable Tavern Hosted stream acceptance', () => {
  it('preserves Story exports and uses the existing shared origin and port checks', () => {
    expect(story.loopbackOrigin).toBe(common.loopbackOrigin);
    expect(story.checkPorts).toBe(common.checkPorts);
    expect(story.assertToolVersions).toBe(common.assertToolVersions);
  });
  it('pins Cloud and Arena to the local mock, namespaces credentials, and leaves commands unchanged', () => {
    const parent = temporary(), paths = acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), id);
    const patched = patchSources(original, paths, origin), lib = patched[PATCH_FILES[0]];
    expect(lib).toContain(`with_story_loopback_origins(library.shared_stories(), "${origin}", "${origin}")`);
    expect(lib.indexOf('acceptance_context.config().identifier')).toBeLessThan(lib.indexOf('tauri::Builder::default()'));
    expect(lib).toContain('compile_error!("Disposable Tavern acceptance checkout cannot build release")');
    expect(lib).toContain('MAHOSHOJO_TAVERN_ACCEPTANCE');
    expect(lib).toContain('unexpected app data namespace');
    expect(lib.slice(lib.indexOf('.invoke_handler('), lib.indexOf('.run(acceptance_context)'))).toEqual(original[PATCH_FILES[0]].slice(original[PATCH_FILES[0]].indexOf('.invoke_handler('), original[PATCH_FILES[0]].indexOf('.run(tauri::generate_context!())')));
    expect(patched[PATCH_FILES[2]]).not.toContain('option_env!("MAHOSHOJO_CLOUD_ORIGIN")');
    expect(patched[PATCH_FILES[2]]).toContain(`const CLOUD_ORIGIN_PRODUCTION: &str = "${origin}"`);
    expect(patched[PATCH_FILES[3]]).toContain(`pub const SECRET_STORE_SERVICE: &str = "${id}"`);
    expect(() => patchSources({ ...original, [PATCH_FILES[0]]: original[PATCH_FILES[0]].replace('ArenaState::new', 'ArenaState::changed') }, paths, origin)).toThrow();
    const crlf = Object.fromEntries(Object.entries(original).map(([file, text]) => [file, text.replaceAll('\n', '\r\n')]));
    expect(patchSources(crlf, paths, origin)[PATCH_FILES[0]]).toContain('\r\n    let acceptance_context');
  });
  it('preflights read-only, prepares fresh isolated files, and detects content/config/origin drift', async () => {
    const parent = temporary(), source = fixture(parent, 'source'), testTree = fixture(parent, 'test');
    const plan = await preflight({ source, testTree, stateRoot: path.join(parent, 'state'), origin });
    expect(readdirSync(parent).sort()).toEqual(['source', 'test']);
    prepare(plan);
    expect(validatePrepared(plan.stateRoot).identifier).toBe(plan.identifier);
    expect(JSON.parse(readFileSync(path.join(plan.stateRoot, 'synthetic-tavern.json'), 'utf8'))).toEqual(SYNTHETIC_CARD);
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(() => prepare(plan)).toThrow();
    const manifestPath = path.join(plan.stateRoot, 'acceptance.json'), manifest = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), origin: 'http://127.0.0.1:24186' }));
    expect(() => validatePrepared(plan.stateRoot)).toThrow('prepared source changed');
    writeFileSync(manifestPath, manifest); writeFileSync(plan.config, '{}');
    expect(() => validatePrepared(plan.stateRoot)).toThrow('config must only');
  });
  it('rejects reused paths, ordinary identity, symlink, dirty copy and hidden overrides', async () => {
    const { plan, source, testTree } = await prepared();
    expect(() => acceptancePaths(source, path.join(source, 'state'), id)).toThrow();
    expect(() => acceptancePaths(source, testTree, 'me.colanns.mahoshojo.desktop')).toThrow();
    await expect(preflight({ source, testTree, stateRoot: plan.stateRoot, origin })).rejects.toThrow('must not exist');
    const manifest = path.join(plan.stateRoot, 'acceptance.json');
    writeFileSync(path.join(testTree, 'apps/desktop/.env.local'), 'CANARY=do-not-read');
    expect(() => validatePrepared(plan.stateRoot)).toThrow('override');
    rmSync(path.join(testTree, 'apps/desktop/.env.local'));
    const linked = path.join(path.dirname(plan.stateRoot), 'linked'); symlinkSync(plan.stateRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => validatePrepared(linked)).toThrow('symlinks/junctions');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), webview: source }));
    expect(() => validatePrepared(plan.stateRoot)).toThrow('manifest mismatch');
  });
  it('requires a single-use launcher and only offline existing-tool debug builds', async () => {
    const { plan } = await prepared();
    expect(buildArguments(plan)).toEqual(['build', '--debug', '--no-bundle', '--config', plan.config, '--', '--locked', '--offline']);
    const env = launchEnvironment(plan, { PATH: 'existing-tools', SECRET: 'canary', TAURI_CONFIG: 'canary', HTTP_PROXY: 'canary', RUSTFLAGS: 'canary', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: 'canary' });
    expect(JSON.stringify(env)).not.toContain('canary');
    expect(env.CARGO_TARGET_DIR).toBe(plan.target); expect(env.CARGO_NET_OFFLINE).toBe('true');
    expect(env.COREPACK_ENABLE_NETWORK).toBe('0'); expect(env.RUSTUP_AUTO_INSTALL).toBe('0');
    writeFileSync(path.join(plan.stateRoot, 'launched.json'), '{}');
    expect(() => validatePrepared(plan.stateRoot)).toThrow('single-use');
    if (process.platform !== 'win32') {
      await expect(main(['build', '--state-root', plan.stateRoot])).rejects.toThrow('Windows-only');
      await expect(main(['launch', '--state-root', plan.stateRoot])).rejects.toThrow('Windows-only');
    }
  });
  it('retains a bounded build-failure receipt without certifying an executable', async () => {
    const { plan } = await prepared();
    await expect(runBuild(plan, () => { throw new Error('private-canary'); })).rejects.toThrow('build failed');
    expect(JSON.parse(readFileSync(path.join(plan.stateRoot, 'build-result.json'), 'utf8'))).toEqual({ code: null, signal: 'spawn-error' });
    expect(readdirSync(plan.stateRoot)).not.toContain('built.json');
    await expect(runBuild(plan, () => { throw new Error('not reached'); })).rejects.toThrow();
  });
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  kills = 0;
  kill() { this.kills++; this.exitCode = 1; queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true; }
  finish() { this.exitCode = 0; this.emit('exit', 0, null); }
}
function lifecycle() {
  const stateRoot = temporary(), inputStream = new PassThrough(), signals = new EventEmitter(), child = new FakeChild();
  let closes = 0; const selected: string[] = [], messages: string[] = [];
  const mock = { setScenario: (value: string) => { if (value !== 'length') throw new Error('closed enum'); selected.push(value); }, trace: () => ({ scope: 'synthetic', requests: [] }), close: async () => { closes++; } };
  const running = runAcceptance({ stateRoot, origin }, mock, () => child, { inputStream, signals, report: (value: string) => messages.push(value) });
  return { stateRoot, inputStream, signals, child, running, selected, messages, closes: () => closes };
}
describe('Tavern local terminal lifecycle', () => {
  it('switches only via closed local commands and records a normal app exit', async () => {
    const x = lifecycle(); x.inputStream.write('scenario length\nscenario arbitrary\nobserve\nunknown\n');
    x.child.finish(); await x.running;
    expect(x.selected).toEqual(['length']); expect(x.closes()).toBe(1);
    expect(x.messages.some(value => value.includes('Scenario refused'))).toBe(true);
    expect(x.child.kills).toBe(0); expect(x.signals.listenerCount('SIGINT')).toBe(0);
    expect(JSON.parse(readFileSync(path.join(x.stateRoot, 'application-exit.json'), 'utf8'))).toEqual({ code: 0, signal: null, requestedStop: false });
  });
  it.each(['stop', 'SIGINT', 'SIGTERM'])('closes only its own app and mock on %s', async action => {
    const x = lifecycle();
    if (action === 'stop') x.inputStream.write('stop\n'); else x.signals.emit(action);
    await x.running;
    expect(x.child.kills).toBe(1); expect(x.closes()).toBe(1);
    expect(JSON.parse(readFileSync(path.join(x.stateRoot, 'application-exit.json'), 'utf8')).requestedStop).toBe(true);
    expect(readdirSync(x.stateRoot)).toContain('mock-trace.json');
  });
  it('closes the mock and preserves observations when spawn throws', async () => {
    const stateRoot = temporary(); let closed = false;
    await expect(runAcceptance({ stateRoot, origin }, { close: async () => { closed = true; }, trace: () => ({ requests: [] }) }, () => { throw new Error('spawn failed'); }, { inputStream: new PassThrough(), signals: new EventEmitter(), report: () => {} })).rejects.toThrow('spawn failed');
    expect(closed).toBe(true); expect(readdirSync(stateRoot)).toContain('mock-trace.json');
  });
});
