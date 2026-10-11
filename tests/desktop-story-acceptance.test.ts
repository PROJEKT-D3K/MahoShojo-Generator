import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { assertToolVersions, acceptancePaths, checkPorts, launchEnvironment, loopbackOrigin, PATCH_FILES, patchSources, preflight, prepare, replaceOnce, validatePrepared } from '../scripts/desktop-story-acceptance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const original = Object.fromEntries(PATCH_FILES.map((file: string) => [file, readFileSync(path.join(root, file), 'utf8')]));
const id = 'me.colanns.mahoshojo.desktop.hostedstoryacceptance.h' + '1'.repeat(32);
const roots: string[] = [];
const temporary = () => { const value = mkdtempSync(path.join(tmpdir(), 'story-acceptance-contract-')); roots.push(value); return value; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fixture(parent: string, name: string) {
  const directory = path.join(parent, name); mkdirSync(directory);
  mkdirSync(path.join(directory, 'apps/desktop/src-tauri/src'), { recursive: true });
  for (const [file, source] of Object.entries(original)) writeFileSync(path.join(directory, file), source);
  git(directory, 'init'); git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', 'commit', '-m', 'synthetic patch fixture');
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// These are script/transform and real loopback contracts, never Tauri/Windows passes.
describe('disposable Hosted story acceptance adapter', () => {
  it.each(['https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.1:1234', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:1420', 'http://127.0.0.1:65536', 'http://127.0.0.1:0123', 'http://u@127.0.0.1:1234', 'http://127.0.0.1:1234/', 'http://127.0.0.1:1234?q', 'http://127.0.0.1:1234#x'])('rejects noncanonical/unusable origin %s', (origin) => {
    expect(() => loopbackOrigin(origin)).toThrow();
  });
  it('pins both Arena origins and Cloud branches, preserves actual commands and applies pre-Builder guards', () => {
    const parent = temporary();
    const paths = acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), id);
    const patched = patchSources(original, paths, 'http://127.0.0.1:24181', 'http://127.0.0.1:24182');
    const lib = patched[PATCH_FILES[0]];
    expect(lib).toContain('with_story_loopback_origins(library.shared_stories(), "http://127.0.0.1:24181", "http://127.0.0.1:24182")');
    expect(lib.indexOf('acceptance_context.config().identifier')).toBeLessThan(lib.indexOf('tauri::Builder::default()'));
    expect(lib).toContain('compile_error!("Disposable story acceptance checkout cannot build release")');
    expect(lib).toContain('.run(acceptance_context)');
    expect(lib.slice(lib.indexOf('.invoke_handler('), lib.indexOf('.run(acceptance_context)'))).toEqual(original[PATCH_FILES[0]].slice(original[PATCH_FILES[0]].indexOf('.invoke_handler('), original[PATCH_FILES[0]].indexOf('.run(tauri::generate_context!())')));
    expect(patched[PATCH_FILES[2]]).not.toContain('option_env!("MAHOSHOJO_CLOUD_ORIGIN")');
    expect(patched[PATCH_FILES[2]]).toContain('const CLOUD_ORIGIN_PRODUCTION: &str = "http://127.0.0.1:24182"');
    expect(patched[PATCH_FILES[3]]).toContain(`pub const SECRET_STORE_SERVICE: &str = "${id}"`);
    for (const file of PATCH_FILES) expect(readFileSync(path.join(root, file), 'utf8')).toEqual(original[file]);
  });
  it('fails on stale or duplicate patch anchors and supports CRLF Windows checkouts', () => {
    expect(() => replaceOnce('xx', 'x', 'y', 'fixture')).toThrow();
    expect(() => replaceOnce('z', 'x', 'y', 'fixture')).toThrow();
    const parent = temporary(), paths = acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), id);
    expect(() => patchSources({ ...original, [PATCH_FILES[0]]: original[PATCH_FILES[0]].replace('ArenaState::new', 'ArenaState::changed') }, paths, 'http://127.0.0.1:24181', 'http://127.0.0.1:24182')).toThrow();
    const crlf = Object.fromEntries(Object.entries(original).map(([file, text]) => [file, text.replaceAll('\n', '\r\n')]));
    expect(patchSources(crlf, paths, 'http://127.0.0.1:24181', 'http://127.0.0.1:24182')[PATCH_FILES[0]]).toContain('\r\n    let acceptance_context');
  });
  it('rejects shared directories, ordinary identifiers and duplicate mock ports', () => {
    const parent = temporary();
    expect(() => acceptancePaths(parent, path.join(parent, 'state'), id)).toThrow();
    expect(() => acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), 'me.colanns.mahoshojo.desktop')).toThrow();
    expect(() => patchSources(original, acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), id), 'http://127.0.0.1:24181', 'http://127.0.0.1:24181')).toThrow();
  });
  it('releases earlier port reservations when a later port conflicts', async () => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try { await expect(checkPorts([0, port])).rejects.toThrow(); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('preflights without writes, prepares only the independent minimal fixture, and catches drift', async () => {
    const parent = temporary(), source = fixture(parent, 'source'), testTree = fixture(parent, 'test');
    const stateRoot = path.join(parent, 'state');
    const plan = await preflight({ source, testTree, stateRoot, honoOrigin: 'http://127.0.0.1:24181', nextOrigin: 'http://127.0.0.1:24182' });
    expect(readdirSync(parent).sort()).toEqual(['source', 'test']);
    expect(git(source, 'status', '--porcelain')).toBe('');
    prepare(plan);
    expect(validatePrepared(stateRoot).identifier).toEqual(plan.identifier);
    expect(JSON.parse(readFileSync(plan.config, 'utf8'))).toEqual({ identifier: plan.identifier });
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(() => prepare(plan)).toThrow();
    writeFileSync(path.join(testTree, PATCH_FILES[0]), plan.patched[PATCH_FILES[0]] + '\n// drift\n');
    expect(() => validatePrepared(stateRoot)).toThrow('prepared source changed');
  });
  it('never mutates shared hardlink source inodes, and rejects used/altered isolation', async () => {
    const parent = temporary(), source = fixture(parent, 'source'), testTree = fixture(parent, 'test');
    const stateRoot = path.join(parent, 'state');
    const plan = await preflight({ source, testTree, stateRoot, honoOrigin: 'http://127.0.0.1:24181', nextOrigin: 'http://127.0.0.1:24182' });
    const target = path.join(testTree, PATCH_FILES[0]);
    rmSync(target); linkSync(path.join(source, PATCH_FILES[0]), target);
    prepare(plan);
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(validatePrepared(stateRoot)).toBeTruthy();
    writeFileSync(path.join(testTree, 'apps/desktop/src-tauri/TAURI.WINDOWS.CONF.JSON'), '{}');
    expect(() => validatePrepared(stateRoot)).toThrow('environment/platform override');
    rmSync(path.join(testTree, 'apps/desktop/src-tauri/TAURI.WINDOWS.CONF.JSON'));
    writeFileSync(path.join(testTree, 'unexpected-untracked-file'), 'synthetic');
    expect(() => validatePrepared(stateRoot)).toThrow('untracked');
    rmSync(path.join(testTree, 'unexpected-untracked-file'));
    const config = readFileSync(plan.config, 'utf8');
    writeFileSync(plan.config, JSON.stringify({ identifier: plan.identifier, app: { security: { csp: null } } }));
    expect(() => validatePrepared(stateRoot)).toThrow('only set isolated identifier');
    writeFileSync(plan.config, config);
    writeFileSync(path.join(plan.webview, 'synthetic-used-marker'), 'synthetic');
    expect(() => validatePrepared(stateRoot)).toThrow('single-use');
    rmSync(path.join(plan.webview, 'synthetic-used-marker'));
    mkdirSync(plan.target);
    expect(() => validatePrepared(stateRoot)).toThrow('Cargo target must not already exist');
  });
  it('refuses source-as-target, dirty test trees, existing state and symlinked state parents', async () => {
    const parent = temporary(), source = fixture(parent, 'source'), testTree = fixture(parent, 'test');
    const options = { source, testTree, stateRoot: path.join(parent, 'state'), honoOrigin: 'http://127.0.0.1:24181', nextOrigin: 'http://127.0.0.1:24182' };
    await expect(preflight({ ...options, testTree: source })).rejects.toThrow('separate');
    mkdirSync(options.stateRoot);
    await expect(preflight(options)).rejects.toThrow('must not exist');
    rmSync(options.stateRoot, { recursive: true });
    symlinkSync(parent, path.join(parent, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preflight({ ...options, stateRoot: path.join(parent, 'linked/state') })).rejects.toThrow('symlinks');
    writeFileSync(path.join(testTree, '.env.local'), 'DO_NOT_READ=this-is-synthetic');
    await expect(preflight(options)).rejects.toThrow('environment/platform override');
  });
  it('rejects missing/mismatched package managers or unsupported toolchains instead of installing', () => {
    const versions = { pnpm: '11.3.0', cargo: 'cargo 1.90.0 (synthetic)', rustc: 'rustc 1.90.0 (synthetic)', expectedPnpm: '11.3.0', minimumRust: '1.90' };
    expect(() => assertToolVersions(versions)).not.toThrow();
    for (const patch of [{ pnpm: '' }, { pnpm: '11.2.0' }, { cargo: 'cargo 1.89.0' }, { rustc: 'rustc 1.90.0-nightly' }]) expect(() => assertToolVersions({ ...versions, ...patch })).toThrow();
  });
  it('does not inherit credential, endpoint, proxy or browser/compiler override environments', () => {
    const parent = temporary(), paths = acceptancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), id);
    const env = launchEnvironment(paths, { PATH: 'existing-tools', SystemRoot: 'Windows', OPENAI_API_KEY: 'synthetic-secret', TAURI_CONFIG: '{}', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--disable-web-security', MAHOSHOJO_CLOUD_ORIGIN: 'https://example.invalid', HTTPS_PROXY: 'https://example.invalid', RUSTFLAGS: 'bad', CARGO_TARGET_DIR: 'shared-target' });
    expect(env.PATH).toBe('existing-tools');
    expect(env.SystemRoot).toBe('Windows');
    expect(env.CARGO_TARGET_DIR).toBe(paths.target);
    expect(env.CARGO_NET_OFFLINE).toBe('true');
    expect(env.RUSTUP_AUTO_INSTALL).toBe('0');
    expect(env.pnpm_config_pm_on_fail).toBe('error');
    expect(env.pnpm_config_runtime_on_fail).toBe('error');
    expect(env.pnpm_config_verify_deps_before_run).toBe('error');
    expect(env.pnpm_config_offline).toBe('true');
    expect(env.npm_config_manage_package_manager_versions).toBe('false');
    expect(env.npm_config_package_manager_strict_version).toBe('true');
    expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(paths.webview);
    expect(JSON.stringify(env)).not.toMatch(/synthetic-secret|disable-web-security|example.invalid|shared-target/);
  });
});
