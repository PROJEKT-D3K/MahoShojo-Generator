import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  buildArguments, ENDPOINTS, instancePaths, launchEnvironment, launcherFailureMessage, monitorMock, PATCH_FILES, ROOM_GENERATION_SCENARIOS,
  patchSources, preflight, prepare, runApplicationPair, runBuildCopies, validatePki, validatePrepared, verify,
} from '../scripts/desktop-room-acceptance.mjs';
import { safeLaunchEnvironment } from '../scripts/desktop-acceptance-common.mjs';
import { formatRoomMockDiagnostic } from '../scripts/desktop-room-acceptance-diagnostics.mjs';

const faults = vi.hoisted(() => ({ renameCountdown: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (faults.renameCountdown > 0 && --faults.renameCountdown === 0) throw new Error('synthetic rename failure');
    return actual.renameSync(...args);
  } };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  // These contracts may run Git and the CLI on tiny synthetic checkouts, never apps or builders.
  spawn: vi.fn(() => { throw new Error('real child processes are forbidden in launcher contracts'); }),
}));

const root = path.resolve(import.meta.dirname, '..');
const native = 'apps/desktop/src-tauri/src/';
const pkiFile = 'scripts/fixtures/desktop-room-acceptance-pki.json';
const pki = JSON.parse(readFileSync(path.join(root, pkiFile), 'utf8'));
const original: Record<string, string> = Object.fromEntries(PATCH_FILES.map((file: string) => [file, readFileSync(path.join(root, file), 'utf8')]));
const roots: string[] = [];
const productionId = 'me.colanns.mahoshojo.desktop';
const identifier = (role = 'host', character = '1') => `${productionId}.roomacceptance.${role}${character.repeat(32)}`;
const temporary = () => { const value = mkdtempSync(path.join(tmpdir(), 'room-acceptance-contract-')); roots.push(value); return value; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const read = (file: string) => readFileSync(file, 'utf8');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sourcesAt = (tree: string) => Object.fromEntries(PATCH_FILES.map((file: string) => [file, read(path.join(tree, file))]));
function fixture(parent: string, name: string, extra: Record<string, string> = {}) {
  const directory = path.join(parent, name); mkdirSync(directory);
  for (const [file, source] of Object.entries({ ...original, ...extra })) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), source);
  }
  mkdirSync(path.dirname(path.join(directory, pkiFile)), { recursive: true });
  writeJson(path.join(directory, pkiFile), pki);
  writeFileSync(path.join(directory, 'unrelated.txt'), 'untouched contract fixture\n');
  git(directory, 'init'); git(directory, 'config', 'core.autocrlf', 'false'); git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', 'commit', '-m', 'synthetic Room fixture');
  return directory;
}
function checkoutSet(extra: Record<string, string> = {}) {
  const parent = temporary();
  return { parent, source: fixture(parent, 'source', extra), hostTree: fixture(parent, 'host', extra), memberTree: fixture(parent, 'member', extra), stateRoot: path.join(parent, 'state') };
}
function isolated(role = 'host', character = '1') {
  const parent = temporary();
  return instancePaths(path.join(parent, 'tree'), path.join(parent, 'state'), identifier(role, character), role);
}
afterEach(() => {
  faults.renameCountdown = 0;
  vi.useRealTimers();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Source transforms and process supervision only; these are not Windows/Tauri passes.
describe('disposable Room acceptance source adapter', () => {
  it('changes only six disposable native files and preserves the production sources and command ACL slice', () => {
    const instance = isolated(), patched = patchSources(original, instance, pki);
    expect(PATCH_FILES).toEqual(['lib.rs', 'secret.rs', 'cloud.rs', 'arena_room_http.rs', 'arena_room_socket.rs', 'arena_hosted.rs'].map(file => native + file));
    expect(Object.keys(patched)).toEqual(PATCH_FILES);
    const lib = patched[native + 'lib.rs'], sourceLib = original[native + 'lib.rs'];
    expect(lib.slice(lib.indexOf('.invoke_handler('), lib.indexOf('.run(acceptance_context)')))
      .toBe(sourceLib.slice(sourceLib.indexOf('.invoke_handler('), sourceLib.indexOf('.run(tauri::generate_context!())')));
    expect(lib).toContain('.append_invoke_initialization_script(arena_room_tauri::DOCUMENT_SCRIPT)');
    expect(lib).toContain('.on_page_load(|webview, payload| arena_room_tauri::page_load(webview, payload.event()))');
    expect(lib).toContain('compile_error!("Disposable Room acceptance checkout cannot build release")');
    for (const marker of ['acceptance_context.config().identifier', 'secret::SECRET_STORE_SERVICE', 'MAHOSHOJO_ROOM_ACCEPTANCE', 'WEBVIEW2_USER_DATA_FOLDER']) {
      expect(lib.indexOf(marker)).toBeGreaterThan(-1);
      expect(lib.indexOf(marker)).toBeLessThan(lib.indexOf('tauri::Builder::default()'));
      expect(lib.indexOf(marker)).toBeLessThan(lib.indexOf('let secrets = default_secret_store();'));
    }
    expect(lib.indexOf('assert!(data_root.ends_with(')).toBeLessThan(lib.indexOf('maintenance::InstanceGuard::acquire(&data_root)'));
    expect(lib).toContain('arena_room::RoomState::new(secrets.clone())');
    expect(lib).toContain('.manage(secrets)');
    expect(lib).toContain(JSON.stringify(instance.webview));
    expect(sourcesAt(root)).toEqual(original);
  });

  it('changes the secret namespace but preserves the protected account-session slot and both Cloud branches', () => {
    const instance = isolated(), patched = patchSources(original, instance, pki);
    expect(patched[native + 'secret.rs']).toBe(original[native + 'secret.rs'].replace(
      `pub const SECRET_STORE_SERVICE: &str = "${productionId}";`,
      `pub const SECRET_STORE_SERVICE: &str = "${instance.identifier}";`,
    ));
    expect(patched[native + 'cloud.rs']).toBe(original[native + 'cloud.rs']
      .replace('const CLOUD_ORIGIN_PRODUCTION: &str = "https://mahoshojo.colanns.me";', `const CLOUD_ORIGIN_PRODUCTION: &str = "${ENDPOINTS.auth}";`)
      .replace('option_env!("MAHOSHOJO_CLOUD_ORIGIN")', `Some("${ENDPOINTS.auth}")`));
    expect(patched[native + 'cloud.rs']).toContain('const ACCOUNT_SESSION_REF: &str = "account-session:web-v1";');
    expect(patched[native + 'cloud.rs']).not.toContain('option_env!("MAHOSHOJO_CLOUD_ORIGIN")');
    expect(patched[native + 'lib.rs']).toContain(`with_story_loopback_origins(library.shared_stories(), "${ENDPOINTS.auth}", "${ENDPOINTS.auth}")`);
    expect(patched[native + 'arena_hosted.rs']).toBe(original[native + 'arena_hosted.rs'].replace(
      '    #[cfg(test)]\n    pub(crate) fn with_story_loopback_origins(',
      '    // Disposable Room acceptance checkout only.\n    pub(crate) fn with_story_loopback_origins(',
    ));
    expect(patched[native + 'arena_hosted.rs']).toContain('state.reconciliation_origin = reconciliation_origin.trim_end_matches');
  });

  it('pins HTTPS and WSS to loopback TCP while preserving SNI, certificate verification and transport guards', () => {
    const patched = patchSources(original, isolated(), pki);
    const http = patched[native + 'arena_room_http.rs'], socket = patched[native + 'arena_room_socket.rs'];
    expect(ENDPOINTS).toEqual({ room: 'https://room.acceptance.invalid:34443', auth: 'http://127.0.0.1:34080', hostname: 'room.acceptance.invalid', roomPort: 34443, authPort: 34080 });
    expect(http).toContain(`fixed_https_origin(Some("${ENDPOINTS.room}"))`);
    expect(http).toContain('Ok(service_origin()?.origin().ascii_serialization())');
    expect(http).toContain(`if raw != Some("${ENDPOINTS.room}")`);
    expect(http).toContain(`.resolve("${ENDPOINTS.hostname}", std::net::SocketAddr::from(([127, 0, 0, 1], ${ENDPOINTS.roomPort})))`);
    expect(http).toContain('.tls_certs_merge([reqwest::Certificate::from_der(&[');
    expect(http).not.toContain('config/hosted-routing.json');
    expect(http).not.toContain('config/arena-room-origins.json');
    for (const guard of ['.https_only(true)', '.no_proxy()', '.redirect(reqwest::redirect::Policy::none())', '.retry(reqwest::retry::never())', '.tls_sslkeylogfile(false)', '.tls_sni(true)', '.connection_verbose(false)', 'credential.set_sensitive(true)']) expect(http).toContain(guard);
    expect(socket).toContain('TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))');
    expect(socket).toContain('ServerName::try_from(host)');
    expect(socket).toContain('rustls_platform_verifier::Verifier::new_with_extra_roots(');
    expect(socket).toContain('.with_custom_certificate_verifier(Arc::new(verifier))');
    expect(socket).toContain('.connect(name, tcp)');
    expect(socket).toContain('tls.key_log = Arc::new(rustls::NoKeyLog {})');
    expect(socket).toContain('tls.enable_sni = true');
    expect(socket).toContain('tls.enable_early_data = false');
    expect(socket).toContain('tls.enable_secret_extraction = false');
    expect(socket.slice(socket.indexOf('fn ticket_deadline('))).toBe(original[native + 'arena_room_socket.rs'].slice(original[native + 'arena_room_socket.rs'].indexOf('fn ticket_deadline(')));
    expect(http.slice(http.indexOf('    pub(crate) async fn execute('))).toBe(original[native + 'arena_room_http.rs'].slice(original[native + 'arena_room_http.rs'].indexOf('    pub(crate) async fn execute(')));
    expect(http + socket).not.toMatch(/danger_accept_invalid|ServerCertVerified::assertion|impl\s+ServerCertVerifier|NoCertificateVerification|SSLKEYLOGFILE|KeyLogFile/);
    const production = (source: string) => {
      const boundary = '\n#[cfg(test)]\nmod tests {';
      expect(source.split(boundary)).toHaveLength(2);
      return source.slice(0, source.indexOf(boundary));
    };
    // Existing test-only log canaries are preserved by the exact suffix assertions above.
    expect(production(http) + production(socket)).not.toMatch(/(?:e?println!|dbg!|tracing::\w+!|log::\w+!)\(/);
  });

  it('gives host and member disjoint namespaces and rejects production, swapped and malformed identities', () => {
    const parent = temporary(), state = path.join(parent, 'state');
    const host = instancePaths(path.join(parent, 'host'), state, identifier('host'), 'host');
    const member = instancePaths(path.join(parent, 'member'), state, identifier('member', '2'), 'member');
    for (const key of ['identifier', 'config', 'webview', 'target']) expect(host[key]).not.toBe(member[key]);
    for (const value of [productionId, identifier('member'), identifier('host').toUpperCase(), identifier('host') + 'x']) {
      expect(() => instancePaths(host.testTree, state, value, 'host')).toThrow();
    }
    expect(() => instancePaths(host.testTree, state, host.identifier, 'other')).toThrow();
    expect(() => instancePaths('relative', state, host.identifier, 'host')).toThrow('absolute');
    expect(() => instancePaths(state, state, host.identifier, 'host')).toThrow('separate');
    expect(() => instancePaths(host.testTree, path.join(host.testTree, 'state'), host.identifier, 'host')).toThrow('separate');
  });

  it('supports CRLF checkouts without weakening missing or duplicate anchor failures', () => {
    const instance = isolated();
    const crlf = Object.fromEntries(Object.entries(original).map(([file, text]) => [file, text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]));
    const patched = patchSources(crlf, instance, pki), lf = patchSources(original, instance, pki);
    for (const file of PATCH_FILES) {
      expect(patched[file]).not.toMatch(/(?<!\r)\n/);
      expect(patched[file].replaceAll('\r\n', '\n')).toBe(lf[file].replaceAll('\r\n', '\n'));
    }
    const http = original[native + 'arena_room_http.rs'];
    const origins = http.slice(http.indexOf('// These are build-time repository inputs'), http.indexOf('\n/// Only the engine constructs these fixed operations'));
    for (const [file, anchor] of [
      ['lib.rs', 'arena_hosted::ArenaState::new(library.shared_stories())'],
      ['secret.rs', `pub const SECRET_STORE_SERVICE: &str = "${productionId}";`],
      ['cloud.rs', 'option_env!("MAHOSHOJO_CLOUD_ORIGIN")'],
      ['arena_room_http.rs', origins],
      ['arena_room_socket.rs', 'TcpStream::connect((host.as_str(), port))'],
      ['arena_hosted.rs', '    #[cfg(test)]\n    pub(crate) fn with_story_loopback_origins('],
    ]) {
      const key = native + file;
      expect(() => patchSources({ ...original, [key]: original[key].replace(anchor, 'changed-anchor') }, instance, pki)).toThrow();
      expect(() => patchSources({ ...original, [key]: original[key] + '\n' + anchor }, instance, pki)).toThrow();
    }
  });
});

describe('public synthetic Room PKI', () => {
  it('has one exact DNS SAN, a verifiable chain and a matching public test private key', () => {
    expect(validatePki(pki)).toBe(pki);
    const ca = new X509Certificate(pki.ca), cert = new X509Certificate(pki.cert);
    expect(ca.ca).toBe(true); expect(ca.verify(ca.publicKey)).toBe(true); expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toBe('DNS:room.acceptance.invalid');
    expect(cert.checkHost(ENDPOINTS.hostname)).toBe(ENDPOINTS.hostname);
    expect(cert.checkHost('wrong.acceptance.invalid')).toBeUndefined();
    expect(cert.checkIP('127.0.0.1')).toBeUndefined();
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(pki.key))).toBe(true);
  });
  it('rejects unknown/private fixtures, wrong key, CA/leaf reversal and a corrupt signature', () => {
    const otherKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const corrupt = Buffer.from(new X509Certificate(pki.cert).raw); corrupt[corrupt.length - 1] ^= 1;
    const corruptPem = `-----BEGIN CERTIFICATE-----\n${corrupt.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    for (const invalid of [null, {}, { ...pki, extra: true }, { ...pki, notice: 'private certificate' }, { ...pki, key: otherKey }, { ...pki, ca: pki.cert }, { ...pki, cert: pki.ca }, { ...pki, cert: corruptPem }]) {
      expect(() => validatePki(invalid)).toThrow();
    }
  });
  it('refuses not-yet-valid and expired certificates', () => {
    const cert = new X509Certificate(pki.cert);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(cert.validFrom) - 1); expect(() => validatePki(pki)).toThrow('expired or not yet valid');
    vi.setSystemTime(Date.parse(cert.validTo)); expect(() => validatePki(pki)).toThrow('expired or not yet valid');
  });
});

describe('Room acceptance checkout lifecycle', () => {
  it('preflights read-only, prepares only the copies and verifies without claiming Windows acceptance', async () => {
    const options = checkoutSet(), before = sourcesAt(options.source);
    const plan = await preflight(options);
    expect(readdirSync(options.parent).sort()).toEqual(['host', 'member', 'source']);
    for (const tree of [options.source, options.hostTree, options.memberTree]) expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(plan.instances.map((value: { role: string }) => value.role)).toEqual(['host', 'member']);
    const manifest = prepare(plan);
    expect(validatePrepared(options.stateRoot, options.source)).toEqual(manifest);
    for (const [index, instance] of plan.instances.entries()) {
      expect(JSON.parse(read(instance.config))).toEqual({ identifier: instance.identifier });
      expect(readdirSync(instance.webview)).toEqual([]);
      expect(existsSync(instance.target)).toBe(false);
      expect(sourcesAt(instance.testTree)).toEqual(plan.patches[index]);
      expect(git(instance.testTree, 'diff', '--name-only', 'HEAD').trim().split('\n').sort()).toEqual([...PATCH_FILES].sort());
      expect(read(path.join(options.stateRoot, instance.role, 'temporary.patch'))).toBe(git(instance.testTree, 'diff', '--', ...PATCH_FILES));
    }
    expect(sourcesAt(options.source)).toEqual(before);
    expect(git(options.source, 'status', '--porcelain')).toBe('');
    expect(verify(options.stateRoot, options.source)).toEqual({ sourceAndCopiesMatch: true, built: false, launched: false, observations: false, windowsAcceptancePassed: false });
    expect(() => prepare(plan)).toThrow();
  });

  it('rejects identical, nested, source-as-copy, relative and symlinked paths before writes', async () => {
    const options = checkoutSet();
    for (const change of [
      { hostTree: options.source }, { memberTree: options.source }, { memberTree: options.hostTree },
      { hostTree: path.join(options.source, 'nested') }, { memberTree: path.join(options.hostTree, 'nested') },
      { stateRoot: options.source }, { stateRoot: path.join(options.memberTree, 'state') },
      { source: options.parent }, { hostTree: 'relative' }, { stateRoot: 'relative' },
    ]) await expect(preflight({ ...options, ...change })).rejects.toThrow();
    const linked = path.join(options.parent, 'linked');
    symlinkSync(options.hostTree, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preflight({ ...options, hostTree: linked })).rejects.toThrow('symlinks');
    await expect(preflight({ ...options, stateRoot: path.join(linked, 'state') })).rejects.toThrow();
    expect(existsSync(options.stateRoot)).toBe(false);
    expect(git(options.source, 'status', '--porcelain')).toBe('');
  });

  it('rejects existing state, missing state parent, dirty copies and nonmatching immutable trees', async () => {
    const options = checkoutSet();
    mkdirSync(options.stateRoot); await expect(preflight(options)).rejects.toThrow('fresh'); rmSync(options.stateRoot, { recursive: true });
    await expect(preflight({ ...options, stateRoot: path.join(options.parent, 'missing/state') })).rejects.toThrow();
    for (const tree of [options.hostTree, options.memberTree, options.source]) {
      writeFileSync(path.join(tree, 'unrelated.txt'), 'changed\n');
      await expect(preflight(options)).rejects.toThrow('clean');
      git(tree, 'checkout', '--', 'unrelated.txt');
    }
    writeFileSync(path.join(options.memberTree, 'unexpected.txt'), 'synthetic\n');
    await expect(preflight(options)).rejects.toThrow('clean'); rmSync(path.join(options.memberTree, 'unexpected.txt'));
    writeFileSync(path.join(options.memberTree, 'unrelated.txt'), 'different immutable source\n');
    git(options.memberTree, 'add', '.');
    git(options.memberTree, '-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', 'commit', '-m', 'different fixture');
    await expect(preflight(options)).rejects.toThrow('source tree');
    expect(existsSync(options.stateRoot)).toBe(false);
  });

  it('rejects environment/platform overrides and linked patch files without exposing contents', async () => {
    const options = checkoutSet();
    for (const file of ['.env', 'apps/desktop/.ENV.LOCAL', 'apps/desktop/src-tauri/TAURI.WINDOWS.CONF.JSON', 'apps/desktop/src-tauri/tauri.conf.json5', 'apps/desktop/src-tauri/tauri.toml']) {
      const target = path.join(options.memberTree, file); writeFileSync(target, 'private-canary-never-log');
      await expect(preflight(options)).rejects.toThrow(/environment\/platform override/);
      rmSync(target);
    }
    const target = path.join(options.hostTree, PATCH_FILES[0]); rmSync(target);
    symlinkSync(path.join(options.source, PATCH_FILES[0]), target);
    await expect(preflight(options)).rejects.toThrow();
    expect(existsSync(options.stateRoot)).toBe(false);
    expect(git(options.source, 'status', '--porcelain')).toBe('');
  });

  it('revalidates dirty or redirected copies and source changes between preflight and prepare', async () => {
    const options = checkoutSet(), plan = await preflight(options);
    for (const tree of [options.source, options.hostTree, options.memberTree]) {
      writeFileSync(path.join(tree, 'unrelated.txt'), 'changed after preflight\n');
      expect(() => prepare(plan)).toThrow();
      expect(existsSync(options.stateRoot)).toBe(false);
      git(tree, 'checkout', '--', 'unrelated.txt');
    }
    const extra = path.join(options.hostTree, 'unexpected.txt'); writeFileSync(extra, 'synthetic');
    expect(() => prepare(plan)).toThrow(); expect(existsSync(options.stateRoot)).toBe(false); rmSync(extra);
    const file = path.join(options.memberTree, PATCH_FILES[0]); writeFileSync(file, read(file) + '\n// drift\n');
    expect(() => prepare(plan)).toThrow(); expect(existsSync(options.stateRoot)).toBe(false);
    expect(git(options.source, 'status', '--porcelain')).toBe('');
  });

  it('rejects tampered derived plans before any writes', async () => {
    const options = checkoutSet(), plan = await preflight(options);
    const modified = structuredClone(plan);
    modified.patches[0][PATCH_FILES[0]] += '\n// unreviewed transform\n';
    expect(() => prepare(modified)).toThrow();
    expect(existsSync(options.stateRoot)).toBe(false);
    const redirected = structuredClone(plan); redirected.instances[0].testTree = options.source;
    expect(() => prepare(redirected)).toThrow();
    expect(existsSync(options.stateRoot)).toBe(false);
    expect(sourcesAt(options.source)).toEqual(original);
  });

  it('uses rename replacement so linked source inodes stay untouched', async () => {
    const options = checkoutSet(), plan = await preflight(options);
    for (const tree of [options.hostTree, options.memberTree]) {
      const destination = path.join(tree, PATCH_FILES[0]); rmSync(destination);
      linkSync(path.join(options.source, PATCH_FILES[0]), destination);
    }
    prepare(plan);
    expect(sourcesAt(options.source)).toEqual(original);
    expect(git(options.source, 'status', '--porcelain')).toBe('');
    expect(validatePrepared(options.stateRoot, options.source)).toBeTruthy();
  });

  it('leaves partial preparation unusable and never writes a completion manifest after failure', async () => {
    const options = checkoutSet(), plan = await preflight(options);
    faults.renameCountdown = PATCH_FILES.length + 1;
    expect(() => prepare(plan)).toThrow('synthetic rename failure');
    expect(existsSync(options.stateRoot)).toBe(true);
    expect(existsSync(path.join(options.stateRoot, 'acceptance.json'))).toBe(false);
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow();
    expect(() => prepare(plan)).toThrow();
    await expect(preflight(options)).rejects.toThrow();
    expect(git(options.source, 'status', '--porcelain')).toBe('');
    expect(sourcesAt(options.source)).toEqual(original);
  });

  it('rejects manifest controls and recomputes patches from immutable HEAD instead of recorded hashes', async () => {
    const options = checkoutSet(), plan = await preflight(options), manifest = prepare(plan);
    const file = path.join(options.stateRoot, 'acceptance.json');
    for (const modified of [
      { ...manifest, version: 2 }, { ...manifest, tree: '0'.repeat(40) }, { ...manifest, pkiHash: '0'.repeat(64) },
      { ...manifest, source: options.hostTree }, { ...manifest, stateRoot: options.parent },
      { ...manifest, original }, { ...manifest, patches: plan.patches },
      { ...manifest, instances: [manifest.instances[0], manifest.instances[0]] },
      { ...manifest, instances: manifest.instances.toReversed() },
    ]) {
      writeJson(file, modified);
      expect(() => validatePrepared(options.stateRoot, options.source)).toThrow();
    }
    for (const change of [{ identifier: productionId }, { config: '/unexpected/config.json' }, { webview: '/unexpected/webview' }, { target: '/unexpected/target' }, { role: 'member' }, { testTree: options.source }, { extra: true }]) {
      writeJson(file, { ...manifest, instances: [{ ...manifest.instances[0], ...change }, manifest.instances[1]] });
      expect(() => validatePrepared(options.stateRoot, options.source)).toThrow();
    }
    writeJson(file, manifest);
    const target = path.join(options.hostTree, PATCH_FILES[0]); writeFileSync(target, read(target) + '\n// untrusted manifest cannot bless this change\n');
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('prepared source changed');
    writeFileSync(target, plan.patches[0][PATCH_FILES[0]]);
    git(options.hostTree, 'add', ...PATCH_FILES);
    expect(validatePrepared(options.stateRoot, options.source)).toBeTruthy();
    expect(git(options.source, 'status', '--porcelain')).toBe('');
  });

  it('rejects extra prepared files, missing patches, config overrides and config/WebView symlinks', async () => {
    const options = checkoutSet(), plan = await preflight(options); prepare(plan);
    const instance = plan.instances[0], extra = path.join(options.memberTree, 'untracked.txt');
    writeFileSync(extra, 'synthetic'); expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('untracked'); rmSync(extra);
    const unrelated = path.join(options.memberTree, 'unrelated.txt'); writeFileSync(unrelated, 'changed');
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('unexpected copy edits'); git(options.memberTree, 'checkout', '--', 'unrelated.txt');
    git(options.hostTree, 'checkout', 'HEAD', '--', PATCH_FILES[0]);
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('unexpected copy edits');
    writeFileSync(path.join(options.hostTree, PATCH_FILES[0]), plan.patches[0][PATCH_FILES[0]]);
    writeJson(instance.config, { identifier: instance.identifier, build: { devUrl: 'https://unexpected.invalid' }, app: { security: { csp: null } } });
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('only set isolated identifier');
    writeJson(instance.config, { identifier: instance.identifier });
    const outsideConfig = path.join(options.parent, 'config.json'); writeJson(outsideConfig, { identifier: instance.identifier });
    rmSync(instance.config); symlinkSync(outsideConfig, instance.config);
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('symlinks');
    rmSync(instance.config); writeJson(instance.config, { identifier: instance.identifier });
    rmSync(instance.webview, { recursive: true }); symlinkSync(options.source, instance.webview, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => validatePrepared(options.stateRoot, options.source)).toThrow('symlinks');
    expect(git(options.source, 'status', '--porcelain')).toBe('');
  });
});

describe('Room acceptance launch inputs', () => {
  it('builds debug bundled-assets applications without a dev server, bundler, installer or network fetch', () => {
    const instance = isolated();
    expect(buildArguments(instance)).toEqual(['build', '--debug', '--no-bundle', '--config', instance.config, '--', '--locked', '--offline']);
    expect(buildArguments(instance).join(' ')).not.toMatch(/\b(?:dev|vite|install|update|release)\b|--features|--runner/);
  });
  it('uses only the shared safe environment plus its own identity and bounded compiler settings', () => {
    const instance = isolated();
    const inherited = Object.freeze({
      Path: 'existing-tools', SystemRoot: 'Windows', CARGO_HOME: 'existing-cargo', RUSTUP_HOME: 'existing-rustup',
      OPENAI_API_KEY: 'private-canary', HTTP_PROXY: 'http://proxy.invalid', https_proxy: 'http://proxy.invalid', ALL_PROXY: 'http://proxy.invalid', NO_PROXY: '*',
      RUSTFLAGS: '--cfg unsafe', CARGO_ENCODED_RUSTFLAGS: 'unsafe', CARGO_TARGET_DIR: 'shared-target', CARGO_BUILD_RUSTC_WRAPPER: 'unsafe-wrapper',
      TAURI_CONFIG: '{}', NODE_OPTIONS: '--require unsafe.js', NODE_EXTRA_CA_CERTS: 'unexpected-ca.pem', SSL_CERT_FILE: 'unexpected-ca.pem',
      SSLKEYLOGFILE: 'tls-secrets.log', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--disable-web-security', WEBVIEW2_USER_DATA_FOLDER: 'shared-webview',
      MAHOSHOJO_CLOUD_ORIGIN: 'https://production.invalid', MAHOSHOJO_ROOM_ACCEPTANCE: 'other-room', MAHOSHOJO_STORY_ACCEPTANCE: 'other-story',
      CARGO_BUILD_JOBS: '999', CARGO_INCREMENTAL: '1', CI: 'false',
    });
    const env = launchEnvironment(instance, inherited);
    expect(env).toEqual({ ...safeLaunchEnvironment(instance, inherited), MAHOSHOJO_ROOM_ACCEPTANCE: instance.identifier, CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0' });
    expect(env.Path).toBe('existing-tools'); expect(env.SystemRoot).toBe('Windows');
    expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(instance.webview); expect(env.CARGO_TARGET_DIR).toBe(instance.target);
    expect(env.CARGO_NET_OFFLINE).toBe('true'); expect(env.RUSTUP_AUTO_INSTALL).toBe('0'); expect(env.COREPACK_ENABLE_NETWORK).toBe('0');
    for (const key of ['OPENAI_API_KEY', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTC_WRAPPER', 'TAURI_CONFIG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSLKEYLOGFILE', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'MAHOSHOJO_CLOUD_ORIGIN', 'MAHOSHOJO_STORY_ACCEPTANCE']) expect(env).not.toHaveProperty(key);
    expect(JSON.stringify(env)).not.toMatch(/private-canary|proxy.invalid|production.invalid|shared-target|shared-webview|unsafe|tls-secrets/);
  });
});

class SyntheticChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  commands: Array<Record<string, unknown>> = [];
  kill = vi.fn(() => { this.emit('exit', null, 'SIGTERM'); this.emit('close', null, 'SIGTERM'); return true; });
  constructor() {
    super();
    this.stdin.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) this.commands.push(JSON.parse(line)); });
  }
  line(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
  finish(code = 0) { this.exitCode = code; this.emit('exit', code, null); this.emit('close', code, null); }
}
const selfCheckSummary = { tlsTrusted: true, tlsNoRootRejected: true, tlsWrongSanRejected: true, authPkceOneUse: true, roomHttp: true, roomWss: true, roomProposals: true, proposalReceiptLoss: true, fixedPublicRefs: true, roomGenerationRead: true, roomGenerationRecovery: true, generationReadOnly: true };
const readyMessage = () => ({ event: 'ready', roomOrigin: ENDPOINTS.room, authOrigin: ENDPOINTS.auth, roomAddress: { host: '127.0.0.1', port: ENDPOINTS.roomPort }, selfCheck: { ...selfCheckSummary } });
const generationObservations = () => ({ fixture: 'none', readHeld: false, cancelEnabled: false, readRequests: 0, readDispatches: 0,
  startRequests: 0, cancelRequests: 0, modelRequests: 0, startDispatches: 0, cancelDispatches: 0,
  modelDispatches: 0, deltaFrames: 0, droppedFrames: 0, disconnections: 0 });
const observations = (id: unknown) => ({ id, event: 'observations', rooms: 1, receipts: 1, actors: 1, activeConnections: 0, authSessions: 2,
  generation: generationObservations(), trace: [{ kind: 'room-http', operation: 'create', status: 200, dropped: false }] });

describe('Room acceptance actual CLI entry with a synthetic mock child', () => {
  it.each(['failure', 'success'])('preserves safe %s output and exit status at the outermost catch', async outcome => {
    const ready = { event: 'self-check', roomOrigin: ENDPOINTS.room, authOrigin: ENDPOINTS.auth, selfCheck: selfCheckSummary };
    const extras = Object.fromEntries([
      'scripts/desktop-room-acceptance.mjs', 'scripts/desktop-acceptance-common.mjs', 'scripts/desktop-room-acceptance-diagnostics.mjs',
    ].map(file => [file, read(path.join(root, file))]));
    extras['apps/api/package.json'] = '{"type":"module"}\n';
    extras['apps/api/scripts/desktop-room-acceptance-mock.ts'] = outcome === 'failure'
      ? "process.stderr.write('PRIVATE-CLI-CANARY cookie=PRIVATE-CLI-CANARY\\nROOM_ACCEPTANCE_FAILURE stage=self-check code=ACCEPTANCE_PROBE_TIMEOUT\\n'); process.exitCode = 1;"
      : `process.stdout.write(${JSON.stringify(JSON.stringify(ready) + '\n')});`;
    const options = checkoutSet(extras); prepare(await preflight(options));
    symlinkSync(path.join(root, 'apps/api/node_modules'), path.join(options.source, 'apps/api/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = () => execFileSync(process.execPath, [path.join(options.source, 'scripts/desktop-room-acceptance.mjs'), 'self-check', '--state-root', options.stateRoot], {
      cwd: options.source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
    if (outcome === 'success') {
      expect(JSON.parse(run())).toEqual(ready);
      expect(JSON.parse(read(path.join(options.stateRoot, 'self-check.json')))).toEqual(ready);
    } else {
      let failure: unknown;
      try { run(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ status: 1, stdout: '' });
      expect((failure as { stderr: string }).stderr.trim()).toBe('mock stopped before ready (code=1, signal=null); stage=self-check, reason=ACCEPTANCE_PROBE_TIMEOUT; stderr=unrecognized');
      expect(existsSync(path.join(options.stateRoot, 'self-check.json'))).toBe(false);
    }
  });
});

describe('Room acceptance owned mock supervision without spawning processes', () => {
  it('permits synthetic starts only in the explicit start mode and never permits model dispatches', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child, false, { syntheticStart: true });
    child.line({ ...readyMessage(), selfCheck: { ...selfCheckSummary, generationReadOnly: false, generationCancel: true, generationStart: true, syntheticProducer: true } }); await mock.ready;
    const armed = mock.command('arm-fault', 'generationStart'); child.line({ id: 1, event: 'armed', operation: 'generationStart' }); await armed;
    const observed = mock.command('observe');
    const value = { ...observations(2), generation: { ...generationObservations(), cancelEnabled: true, startEnabled: true, startDispatches: 3, startPortCalls: 2, syntheticProducers: 1, startReservations: 1, byokStartPortCalls: 0 },
      trace: [{ kind: 'room-http', operation: 'generationStart', status: 202, dropped: true }] };
    child.line(value); await expect(observed).resolves.toEqual(value);
    const invalid = mock.command('observe'); child.line({ ...value, id: 3, generation: { ...value.generation, modelDispatches: 1 } });
    await expect(invalid).rejects.toThrow('invalid mock response'); await mock.exit; await mock.close();
    for (const syntheticCancel of [false, true]) {
      const other = new SyntheticChild(), closed = monitorMock(other, false, { syntheticCancel });
      other.line({ ...readyMessage(), selfCheck: { ...selfCheckSummary, ...(syntheticCancel ? { generationReadOnly: false, generationCancel: true } : {}) } }); await closed.ready;
      await expect(closed.command('arm-fault', 'generationStart')).rejects.toThrow(); await expect(closed.command('generation', 'start-large')).rejects.toThrow();
      other.finish(); await closed.exit; await closed.close();
    }
  });
  it('requires an explicit synthetic-cancel monitor and keeps the read-only zero-cancel guard', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child, false, { syntheticCancel: true });
    child.line({ ...readyMessage(), selfCheck: { ...selfCheckSummary, generationReadOnly: false, generationCancel: true } }); await mock.ready;
    const armed = mock.command('arm-fault', 'generationCancel'); child.line({ id: 1, event: 'armed', operation: 'generationCancel' }); await armed;
    const wait = mock.command('generation', 'cancel-wait'); child.line({ id: 2, event: 'generation', scenario: 'cancel-wait' }); await wait;
    const observe = mock.command('observe'); child.line({ ...observations(3), trace: [{ kind: 'room-http', operation: 'generationCancel', status: 200, dropped: false }], generation: { ...generationObservations(), cancelEnabled: true, fixture: 'cancelled', cancelDispatches: 1 } }); await observe;
    child.finish(); await mock.exit; await mock.close();
    const readChild = new SyntheticChild(), read = monitorMock(readChild); readChild.line(readyMessage()); await read.ready;
    await expect(read.command('generation', 'cancel-wait')).rejects.toThrow(); await expect(read.command('arm-fault', 'generationCancel')).rejects.toThrow();
    readChild.finish(); await read.exit; await read.close();
  });

  it.each(ROOM_GENERATION_SCENARIOS)('supervises only the fixed generation %s scenario', async scenario => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('generation', scenario);
    expect(child.commands).toEqual([{ id: 1, command: 'generation', scenario }]);
    child.line({ id: 1, event: 'generation', scenario });
    await expect(pending).resolves.toEqual({ id: 1, event: 'generation', scenario });
    expect(child.kill).not.toHaveBeenCalled();
    child.finish(); await mock.exit; await mock.close();
  });

  it.each([
    { id: 1, event: 'generation', scenario: 'complete' },
    { id: 1, event: 'generation', scenario: 'seed', roomId: 'private-canary' },
    { id: 1, event: 'generation', operation: 'seed' },
  ])('refuses mismatched or expanded generation acknowledgement %#', async reply => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('generation', 'seed'); child.line(reply);
    await expect(pending).rejects.toThrow('invalid mock response');
    expect(child.kill).toHaveBeenCalled(); await mock.exit; await mock.close();
  });

  it('keeps read and refused attempts separate from zero mutation/model dispatch counters', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('observe');
    const value = { ...observations(1), generation: { ...generationObservations(), fixture: 'running', readHeld: true,
      readRequests: 3, readDispatches: 2, startRequests: 1, cancelRequests: 1, modelRequests: 1,
      deltaFrames: 4, droppedFrames: 1, disconnections: 2 },
      trace: [{ kind: 'room-http', operation: 'generationRead', status: 200, dropped: false }] };
    child.line(value); await expect(pending).resolves.toEqual(value);
    child.finish(); await mock.exit; await mock.close();
  });

  it.each([
    { startDispatches: 1 }, { cancelDispatches: 1 }, { modelDispatches: 1 },
    { readDispatches: -1 }, { readRequests: 65_537 }, { deltaFrames: 1.5 },
    { fixture: 'other' }, { readHeld: 'true' }, { body: 'private-canary' },
  ])('refuses unsafe or expanded generation observations %#', async patch => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('observe');
    child.line({ ...observations(1), generation: { ...generationObservations(), ...patch } });
    await expect(pending).rejects.toThrow('invalid mock response');
    expect(child.kill).toHaveBeenCalled(); await mock.exit; await mock.close();
  });

  it('requires every new readiness proof and every generation observation field', async () => {
    for (const key of ['roomGenerationRead', 'roomGenerationRecovery', 'generationReadOnly']) {
      const child = new SyntheticChild(), mock = monitorMock(child);
      const reply = readyMessage(); delete (reply.selfCheck as Record<string, unknown>)[key];
      const rejected = expect(mock.ready).rejects.toThrow('invalid mock response'); child.line(reply);
      await rejected; await mock.exit; await mock.close();
    }
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('observe'), value = observations(1);
    delete (value.generation as Record<string, unknown>).modelDispatches; child.line(value);
    await expect(pending).rejects.toThrow('invalid mock response'); await mock.exit; await mock.close();
  });

  it.each(['config', 'config-unsupported'])('supervises bounded %s fault and config observations', async operation => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    try {
    const armed = mock.command('arm-fault', operation);
    child.line({ id: 1, event: 'armed', operation }); await armed;
    const reading = mock.command('observe'); const value = observations(2);
    value.trace = [{ kind: 'room-http', operation: 'config', status: operation === 'config' ? 200 : 400, dropped: operation === 'config' }];
    child.line(value); await expect(reading).resolves.toEqual(value);
    expect(child.kill).not.toHaveBeenCalled();
    } finally { child.finish(); await mock.exit; await mock.close(); }
  });

  it.each(['proposalSubmit', 'proposalWithdraw', 'proposalResolve', 'proposal-unsupported'])('supervises only the explicit %s proposal fault', async operation => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    try {
      const armed = mock.command('arm-fault', operation);
      child.line({ id: 1, event: 'armed', operation }); await armed;
      const reading = mock.command('observe');
      const value = { ...observations(2), trace: [{ kind: 'room-http', operation: operation === 'proposal-unsupported' ? 'proposalSubmit' : operation,
        status: operation === 'proposal-unsupported' ? 400 : 200, dropped: operation !== 'proposal-unsupported' }] };
      child.line(value); await expect(reading).resolves.toEqual(value);
      expect(child.kill).not.toHaveBeenCalled();
    } finally { child.finish(); await mock.exit; await mock.close(); }
  });

  it('accepts only bounded public random/read observations without identity or body data', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('observe');
    const value = { ...observations(1), trace: [{ kind: 'public-card', operation: 'random', status: 200 }, { kind: 'public-card', operation: 'read', status: 200 }] };
    child.line(value); await expect(pending).resolves.toEqual(value);
    child.finish(); await mock.exit; await mock.close();
  });

  it.each([
    { kind: 'room-http', operation: 'generationStart', status: 200, dropped: false },
    { kind: 'room-http', operation: 'kick', status: 200, dropped: false },
    { kind: 'public-card', operation: 'list', status: 200 },
    { kind: 'public-card', operation: 'read', status: 200, body: 'private-canary' },
    { kind: 'public-card', operation: 'read', status: 600 },
  ])('refuses an unapproved or expanded observation %#', async trace => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = mock.command('observe');
    child.line({ ...observations(1), trace: [trace] });
    await expect(pending).rejects.toThrow('invalid mock response');
    expect(child.kill).toHaveBeenCalled(); await mock.exit; await mock.close();
  });

  it('waits for validated readiness and correlates one bounded command at a time', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await expect(mock.ready).resolves.toMatchObject({ event: 'ready', roomOrigin: ENDPOINTS.room });
    const pending = mock.command('observe');
    expect(child.commands).toEqual([{ id: 1, command: 'observe' }]);
    await expect(mock.command('observe')).rejects.toThrow();
    child.line(observations(1)); await expect(pending).resolves.toMatchObject({ id: 1, event: 'observations' });
    const armed = mock.command('arm-fault', 'create');
    expect(child.commands[1]).toEqual({ id: 2, command: 'arm-fault', operation: 'create' });
    child.line({ id: 2, event: 'armed', operation: 'create' }); await expect(armed).resolves.toMatchObject({ event: 'armed', operation: 'create' });
    child.finish(); await expect(mock.exit).resolves.toMatchObject({ code: 0, signal: null }); await mock.close();
    await expect(mock.command('observe')).rejects.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('accepts the actual bounded self-check schema without the ready-only room address', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child, true);
    const message = { event: 'self-check', roomOrigin: ENDPOINTS.room, authOrigin: ENDPOINTS.auth, selfCheck: { ...selfCheckSummary } };
    child.line(message);
    await expect(mock.ready).resolves.toEqual(message);
    child.finish(); await mock.exit; await mock.close();
  });

  it.each([
    { event: 'exit', code: 1, signal: null },
    { event: 'exit', code: 0, signal: null },
    { event: 'exit', code: null, signal: 'SIGTERM' },
    { event: 'close', code: 1, signal: null },
  ])('reports premature $event code=$code signal=$signal and preserves the first terminal result', async ({ event, code, signal }) => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const rejected = expect(mock.ready).rejects.toMatchObject({ message: `mock stopped before ready (code=${code}, signal=${signal}); stderr=unrecognized` });
    child.stderr.write('private-canary cookie=private ticket=private\n');
    child.emit(event, code, signal);
    if (event === 'exit') child.emit('close', 99, 'SIGKILL');
    await rejected;
    await expect(mock.exit).resolves.toEqual({ code, signal });
    child.emit('close', 99, 'SIGKILL');
    await expect(mock.exit).resolves.toEqual({ code, signal });
    const closing = mock.close(); expect(mock.close()).toBe(closing); await closing;
    expect(child.commands).toEqual([]); expect(child.kill).not.toHaveBeenCalled();
  });

  it('settles spawn errors even when the child never emits exit and redacts diagnostics', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const failure = mock.ready.catch(error => error);
    child.emit('error', new Error('private-canary cookie=private ticket=private'));
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('mock stopped before ready (code=null, signal=spawn-error); stage=spawn, reason=UNKNOWN');
    expect(error.stack).not.toMatch(/private-canary|cookie=private|ticket=private/);
    expect(error.cause).toBeUndefined();
    await expect(mock.exit).resolves.toEqual({ code: null, signal: 'spawn-error' });
    child.emit('close', 1, null);
    await expect(mock.exit).resolves.toEqual({ code: null, signal: 'spawn-error' });
    await mock.close();
    expect(child.commands).toEqual([]); expect(child.kill).not.toHaveBeenCalled();
  });

  it('drains a chunked safe failure after exit and keeps only the first diagnostic', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    let settled = false;
    const failure = mock.ready.catch(error => { settled = true; return error; });
    child.emit('exit', 1, null); await Promise.resolve(); expect(settled).toBe(false);
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=load-');
    child.stderr.write('fixture code=ENOENT\n');
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=self-check code=UNKNOWN\n');
    child.emit('close', 99, 'SIGKILL');
    const error = await failure;
    expect(error.message).toBe('mock stopped before ready (code=1, signal=null); stage=load-fixture, reason=ENOENT');
    expect(launcherFailureMessage(error)).toBe(error.message);
    error.message = 'private-canary';
    expect(launcherFailureMessage(error)).toBe('mock stopped before ready (code=1, signal=null); stage=load-fixture, reason=ENOENT');
    await expect(mock.exit).resolves.toEqual({ code: 1, signal: null }); await mock.close();
  });

  it.each([
    'ROOM_ACCEPTANCE_FAILURE stage=private-canary code=ENOENT\n',
    'ROOM_ACCEPTANCE_FAILURE stage=listen code=PRIVATE_CANARY\n',
    'ROOM_ACCEPTANCE_FAILURE stage=listen code=ENOENT cookie=private-canary\n',
    'ROOM_ACCEPTANCE_FAILURE stage=listen code=ENOENT\r\n',
    'ROOM_ACCEPTANCE_FAILURE stage=listen code=ENOENT',
    'private-canary\u001b[2J\n',
  ])('discards incomplete, expanded or unapproved stderr line %#', async line => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const failure = mock.ready.catch(error => error);
    child.stderr.write(line); child.finish(1);
    const error = await failure;
    expect(error.message).toBe('mock stopped before ready (code=1, signal=null); stderr=unrecognized');
    expect(error.stack).not.toContain('private-canary'); expect(error.cause).toBeUndefined();
    await mock.exit; await mock.close();
  });

  it('bounds unterminated stderr by bytes and resumes parsing only at the next line', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const failure = mock.ready.catch(error => error);
    child.stderr.write('界'.repeat(85)); child.stderr.write('界');
    child.stderr.write('private-canary'.repeat(100_000));
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=listen code=ENOENT\n');
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=self-check code=ACCEPTANCE_PROBE_TIMEOUT\n');
    child.finish(1);
    const error = await failure;
    expect(error.message).toBe('mock stopped before ready (code=1, signal=null); stage=self-check, reason=ACCEPTANCE_PROBE_TIMEOUT; stderr=truncated');
    expect(error.stack).not.toContain('private-canary'); expect(error.cause).toBeUndefined();
    await mock.exit; await mock.close();
  });

  it.each(['readiness', 'stop'])('keeps the original %s deadline when exit leaves stderr open', async deadline => {
    vi.useFakeTimers();
    const child = new SyntheticChild(), mock = monitorMock(child, false, { readinessTimeoutMs: 25, stopTimeoutMs: 10 });
    const failure = mock.ready.catch(error => error);
    child.emit('exit', null, 'SIGTERM');
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=self-check code=ACCEPTANCE_SELFCHECK_WS\n');
    const closing = deadline === 'stop' ? mock.close() : undefined;
    await vi.advanceTimersByTimeAsync(deadline === 'stop' ? 10 : 25);
    expect((await failure).message).toBe('mock stopped before ready (code=null, signal=SIGTERM); stage=self-check, reason=ACCEPTANCE_SELFCHECK_WS');
    await expect(mock.exit).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    await closing; await mock.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('includes only safe diagnostics in readiness timeouts and spawn errors', async () => {
    vi.useFakeTimers();
    const child = new SyntheticChild(), mock = monitorMock(child, false, { readinessTimeoutMs: 25 });
    const failure = mock.ready.catch(error => error);
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=self-check code=ACCEPTANCE_PROBE_TIMEOUT\n');
    await vi.advanceTimersByTimeAsync(25);
    expect((await failure).message).toBe('mock readiness failed; stage=self-check, reason=ACCEPTANCE_PROBE_TIMEOUT');
    await mock.exit; await mock.close();
    const missing = new SyntheticChild(), missingMock = monitorMock(missing);
    const spawnFailure = missingMock.ready.catch(error => error);
    missing.emit('error', Object.assign(new Error('private-canary'), { code: 'ENOENT', path: 'private-canary' }));
    expect((await spawnFailure).message).toBe('mock stopped before ready (code=null, signal=spawn-error); stage=spawn, reason=ENOENT');
    await missingMock.exit; await missingMock.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('settles an exit after the stop deadline without waiting for inherited stderr to close', async () => {
    vi.useFakeTimers();
    const child = new SyntheticChild(); child.kill.mockImplementation(() => true);
    const mock = monitorMock(child, false, { readinessTimeoutMs: 200, stopTimeoutMs: 20 });
    const failure = mock.ready.catch(error => error);
    const closing = mock.close();
    await vi.advanceTimersByTimeAsync(20); expect(child.kill).toHaveBeenCalledOnce();
    child.stderr.write('ROOM_ACCEPTANCE_FAILURE stage=listen code=EADDRINUSE\n');
    child.emit('exit', null, 'SIGTERM');
    await closing;
    expect((await failure).message).toBe('mock stopped before ready (code=null, signal=SIGTERM); stage=listen, reason=EADDRINUSE');
    await expect(mock.exit).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats fixed failure codes without coercing private errors or evaluating getters', () => {
    const error = Object.assign(new Error('private-canary'), { code: 'EADDRINUSE', path: 'private-canary' });
    expect(formatRoomMockDiagnostic('listen', error)).toBe('ROOM_ACCEPTANCE_FAILURE stage=listen code=EADDRINUSE\n');
    expect(formatRoomMockDiagnostic('load-fixture', new SyntaxError('private-canary'))).toBe('ROOM_ACCEPTANCE_FAILURE stage=load-fixture code=INVALID_JSON\n');
    expect(formatRoomMockDiagnostic('self-check', new Error('ACCEPTANCE_SELFCHECK_WS'))).toBe('ROOM_ACCEPTANCE_FAILURE stage=self-check code=ACCEPTANCE_SELFCHECK_WS\n');
    const read = vi.fn(() => { throw new Error('private-canary'); });
    const opaque = { get code() { return read(); }, get message() { return read(); }, toString: read };
    expect(formatRoomMockDiagnostic('private-canary', opaque)).toBe('ROOM_ACCEPTANCE_FAILURE stage=unknown code=UNKNOWN\n');
    expect(read).not.toHaveBeenCalled();
  });

  it('never prints an unbranded dependency error through the CLI failure reporter', () => {
    const read = vi.fn(() => 'private-canary');
    for (const error of [new Error('private-canary'), { get message() { return read(); } }, 'private-canary', null]) {
      expect(launcherFailureMessage(error)).toBe('Room acceptance failed; keep the isolated directory and inspect the bounded stage results.');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('settles pending commands on unexpected backend exit and closes idempotently', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    child.line(readyMessage()); await mock.ready;
    const pending = expect(mock.command('observe')).rejects.toThrow('mock stopped'); child.finish(1);
    await expect(mock.exit).resolves.toMatchObject({ code: 1 });
    await pending;
    await Promise.all([mock.close(), mock.close()]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['{malformed', 'null', '[]', JSON.stringify({ ...readyMessage(), roomOrigin: 'https://foreign.invalid' }), JSON.stringify({ ...readyMessage(), authOrigin: 'http://0.0.0.0:34080' }), JSON.stringify({ ...readyMessage(), cookie: 'private-canary' })])('rejects malformed or unsafe readiness without forwarding raw output: %s', async line => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const rejected = expect(mock.ready).rejects.toThrow(/mock/);
    child.stdout.write(line + '\n');
    await rejected; await mock.exit; await mock.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('bounds readiness, kills only its owned child and does not leave live timers', async () => {
    vi.useFakeTimers();
    const child = new SyntheticChild(), unrelated = new SyntheticChild();
    const mock = monitorMock(child, false, { readinessTimeoutMs: 25, stopTimeoutMs: 10 });
    const rejected = expect(mock.ready).rejects.toThrow(/mock/);
    await vi.advanceTimersByTimeAsync(25); await rejected; await mock.exit; await mock.close();
    expect(child.kill).toHaveBeenCalledOnce(); expect(unrelated.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds UTF-8 bytes across unterminated stdout chunks before any newline arrives', async () => {
    const child = new SyntheticChild(), mock = monitorMock(child);
    const rejected = expect(mock.ready).rejects.toThrow('invalid mock response');
    child.stdout.write('x'.repeat(32 * 1024));
    child.stdout.write('界'.repeat(10922));
    expect(child.kill).not.toHaveBeenCalled();
    // 65,534 accumulated bytes plus three UTF-8 bytes; no chunk contains a newline.
    child.stdout.write('界');
    await rejected; await mock.exit; await mock.close();
    expect(child.kill).toHaveBeenCalledOnce();
    child.line(readyMessage());
    await expect(mock.command('observe')).rejects.toThrow('mock unavailable');
    expect(child.commands).toEqual([]);
  });

  it('rejects unknown commands, incorrect correlation IDs and secret-bearing control replies', async () => {
    for (const reply of [{ ...observations(1), cookie: 'private-canary' }, observations(99)]) {
      const child = new SyntheticChild(), mock = monitorMock(child);
      child.line(readyMessage()); await mock.ready;
      for (const [command, operation] of [['unknown', undefined], ['observe', 'create'], ['arm-fault', 'other'], ['generation', undefined],
        ['generation', 'start'], ['generation', 'seed https://example.invalid'], ['generation', { scenario: 'seed', roomId: 'other' }]]) await expect(mock.command(command, operation)).rejects.toThrow('invalid control command');
      expect(child.commands).toEqual([]);
      const refused = expect(mock.command('observe')).rejects.toThrow('invalid mock response');
      child.line(reply); await refused; await mock.exit; await mock.close();
      expect(child.kill).toHaveBeenCalledOnce();
    }
  });

  it('bounds command waits and preserves a fixed error instead of child diagnostics', async () => {
    vi.useFakeTimers();
    const child = new SyntheticChild(), mock = monitorMock(child, false, { readinessTimeoutMs: 25, stopTimeoutMs: 10 });
    child.line(readyMessage()); await mock.ready;
    const refused = expect(mock.command('observe')).rejects.toThrow('mock control refused');
    child.line({ id: 1, event: 'error', code: 'ACCEPTANCE_CONTROL_REFUSED' }); await refused;
    const timeout = expect(mock.command('observe')).rejects.toThrow('mock control timeout');
    await vi.advanceTimersByTimeAsync(10); await timeout; await mock.exit; await mock.close();
    expect(child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('sends one graceful stop then forcibly ends only the owned child after the stop deadline', async () => {
    vi.useFakeTimers();
    const child = new SyntheticChild(), unrelated = new SyntheticChild();
    const mock = monitorMock(child, false, { readinessTimeoutMs: 25, stopTimeoutMs: 10 });
    child.line(readyMessage()); await mock.ready;
    const closed = mock.close(), closedAgain = mock.close();
    expect(child.commands).toEqual([{ id: 1, command: 'stop' }]);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10); await Promise.all([closed, closedAgain]);
    expect(child.kill).toHaveBeenCalledOnce(); expect(unrelated.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
class SyntheticApplication extends EventEmitter {
  exitCode: number | null = null;
  private killed = false;
  private spawnFailed = false;
  kill = vi.fn(() => {
    if (this.killed || this.spawnFailed || this.exitCode !== null) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  });
  finish() { this.exitCode = 0; this.emit('exit', 0, null); }
  failSpawn() { this.spawnFailed = true; this.emit('error', new Error('private-canary native spawn diagnostic')); }
}
function applicationPairFixture() {
  const parent = temporary(), stateRoot = path.join(parent, 'state'); mkdirSync(stateRoot);
  const manifest = { tree: 'a'.repeat(40), stateRoot, instances: [
    instancePaths(path.join(parent, 'host'), stateRoot, identifier('host'), 'host'),
    instancePaths(path.join(parent, 'member'), stateRoot, identifier('member', '2'), 'member'),
  ] };
  const ready = gate<ReturnType<typeof readyMessage>>(), exit = gate<{ code: number | null; signal: string | null }>(), started = gate<void>();
  const mock = { ready: ready.promise, exit: exit.promise,
    command: vi.fn(async () => observations(1)), close: vi.fn(async () => { exit.resolve({ code: 0, signal: null }); }),
  };
  const apps = [new SyntheticApplication(), new SyntheticApplication()];
  const spawnApp = vi.fn((instance: { role: string }) => apps[instance.role === 'host' ? 0 : 1]);
  const inputStream = new PassThrough(), signals = new EventEmitter(), report = vi.fn(() => { started.resolve(); });
  return { manifest, ready, exit, started, mock, apps, spawnApp, inputStream, signals, report };
}

describe('Room acceptance two-application lifecycle without a GUI', () => {
  it('forwards fixed generation scenarios without accepting arbitrary destinations or payloads', async () => {
    const fixture = applicationPairFixture(); const running = runApplicationPair(fixture.manifest, fixture.mock, fixture);
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    fixture.inputStream.write(ROOM_GENERATION_SCENARIOS.map((scenario: string) => `generation ${scenario}\n`).join('')
      + 'generation start\ngeneration seed room-1\ngeneration https://example.invalid\n');
    await vi.waitFor(() => expect(fixture.report).toHaveBeenCalledWith('Unknown command'));
    expect(fixture.mock.command.mock.calls).toEqual(ROOM_GENERATION_SCENARIOS.map((scenario: string) => ['generation', scenario]));
    fixture.inputStream.write('stop\n'); await running;
  });

  it('forwards both config console fault modes through the bounded control channel', async () => {
    const fixture = applicationPairFixture(); const running = runApplicationPair(fixture.manifest, fixture.mock, fixture);
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    fixture.inputStream.write('fault config\nfault config-unsupported\n');
    await vi.waitFor(() => expect(fixture.mock.command).toHaveBeenCalledWith('arm-fault', 'config-unsupported'));
    expect(fixture.mock.command).toHaveBeenCalledWith('arm-fault', 'config');
    fixture.inputStream.write('stop\n'); await running;
  });

  it('forwards exactly the fixed proposal faults and rejects unapproved generation controls', async () => {
    const fixture = applicationPairFixture(); const running = runApplicationPair(fixture.manifest, fixture.mock, fixture as unknown as Parameters<typeof runApplicationPair>[2]);
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    fixture.inputStream.write('fault proposalSubmit\nfault proposalWithdraw\nfault proposalResolve\nfault proposal-unsupported\nfault generationStart\n');
    await vi.waitFor(() => expect(fixture.report).toHaveBeenCalledWith('Unknown command'));
    expect(fixture.mock.command.mock.calls).toEqual([
      ['arm-fault', 'proposalSubmit'], ['arm-fault', 'proposalWithdraw'], ['arm-fault', 'proposalResolve'], ['arm-fault', 'proposal-unsupported'],
    ]);
    fixture.inputStream.write('stop\n'); await running;
  });

  it('never starts an application if SIGINT precedes a late readiness result', async () => {
    const fixture = applicationPairFixture();
    const running = runApplicationPair(fixture.manifest, fixture.mock, fixture);
    fixture.signals.emit('SIGINT');
    fixture.ready.resolve(readyMessage());
    await running;
    expect(fixture.spawnApp).not.toHaveBeenCalled();
    expect(fixture.mock.close).toHaveBeenCalled();
    expect(fixture.mock.command).not.toHaveBeenCalled();
    expect(readdirSync(fixture.manifest.stateRoot)).toEqual([]);
    expect(fixture.signals.listenerCount('SIGINT')).toBe(0);
    expect(fixture.signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('stops the already-started peer on the first application spawn error and preserves failure evidence', async () => {
    const fixture = applicationPairFixture();
    const failed = expect(runApplicationPair(fixture.manifest, fixture.mock, fixture)).rejects.toThrow('an application or mock failed');
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    expect(fixture.spawnApp).toHaveBeenCalledTimes(2);
    fixture.apps[0].failSpawn(); await failed;
    expect(fixture.apps[1].kill).toHaveBeenCalled();
    expect(fixture.mock.close).toHaveBeenCalled();
    const recorded = read(path.join(fixture.manifest.stateRoot, 'application-exits.json'));
    expect(JSON.parse(recorded)).toEqual({ requestedStop: false, applications: [
      { role: 'host', code: null, signal: 'spawn-error' }, { role: 'member', code: null, signal: 'SIGTERM' },
    ] });
    expect(recorded + JSON.stringify(fixture.report.mock.calls)).not.toContain('private-canary');
    expect(fixture.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('stops both owned applications after unexpected backend exit and refuses success observations', async () => {
    const fixture = applicationPairFixture();
    const failed = expect(runApplicationPair(fixture.manifest, fixture.mock, fixture)).rejects.toThrow('an application or mock failed');
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    fixture.exit.resolve({ code: 1, signal: null }); await failed;
    for (const app of fixture.apps) expect(app.kill).toHaveBeenCalled();
    expect(fixture.mock.command).not.toHaveBeenCalled();
    expect(fixture.mock.close).toHaveBeenCalled();
    expect(existsSync(path.join(fixture.manifest.stateRoot, 'mock-observations.json'))).toBe(false);
    expect(JSON.parse(read(path.join(fixture.manifest.stateRoot, 'application-exits.json')))).toEqual({ requestedStop: false, applications: [
      { role: 'host', code: null, signal: 'SIGTERM' }, { role: 'member', code: null, signal: 'SIGTERM' },
    ] });
  });

  it.each([false, true])('archives observations and distinguishes requested stop (%s) from natural double exit', async requestedStop => {
    const fixture = applicationPairFixture();
    const running = runApplicationPair(fixture.manifest, fixture.mock, fixture);
    fixture.ready.resolve(readyMessage()); await fixture.started.promise;
    if (requestedStop) fixture.inputStream.write('stop\n');
    else for (const app of fixture.apps) app.finish();
    await running;
    expect(fixture.mock.command).toHaveBeenCalledExactlyOnceWith('observe');
    expect(fixture.mock.close).toHaveBeenCalled();
    expect(JSON.parse(read(path.join(fixture.manifest.stateRoot, 'mock-observations.json')))).toEqual(observations(1));
    expect(JSON.parse(read(path.join(fixture.manifest.stateRoot, 'application-exits.json')))).toEqual({ requestedStop, applications: ['host', 'member'].map(role => ({
      role, code: requestedStop ? null : 0, signal: requestedStop ? 'SIGTERM' : null,
    })) });
    for (const app of fixture.apps) {
      if (requestedStop) expect(app.kill).toHaveBeenCalled();
      else expect(app.kill).not.toHaveBeenCalled();
    }
    expect(fixture.signals.listenerCount('SIGINT')).toBe(0);
    expect(fixture.signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('Room acceptance build receipts without invoking a compiler', () => {
  it.each([
    { kind: 'nonzero exit', exitCode: 23, signal: null, startFailure: false },
    { kind: 'signal exit', exitCode: null, signal: 'SIGTERM', startFailure: false },
    { kind: 'spawn error', exitCode: null, signal: null, startFailure: true },
    { kind: 'spawn throw', exitCode: null, signal: null, startFailure: true },
  ])('preserves the first $kind and never starts the member or writes built.json', async outcome => {
    const { manifest } = applicationPairFixture(), child = new EventEmitter();
    const spawnBuild = vi.fn(() => {
      if (outcome.kind === 'spawn throw') throw new Error('private-canary spawn diagnostic');
      return child;
    });
    const verifyAfterBuild = vi.fn(), fingerprint = vi.fn(() => 'unexpected fingerprint');
    const failed = expect(runBuildCopies(manifest, { spawnBuild, verifyAfterBuild, fingerprint })).rejects.toThrow('build did not complete successfully');
    if (outcome.kind === 'spawn error') child.emit('error', new Error('private-canary spawn diagnostic'));
    else if (outcome.kind !== 'spawn throw') child.emit('exit', outcome.exitCode, outcome.signal);
    await failed;
    expect(spawnBuild).toHaveBeenCalledExactlyOnceWith(manifest.instances[0]);
    expect(verifyAfterBuild).not.toHaveBeenCalled(); expect(fingerprint).not.toHaveBeenCalled();
    expect(existsSync(path.join(manifest.stateRoot, 'built.json'))).toBe(false);
    const destination = path.join(manifest.stateRoot, 'build-results.json'), recorded = read(destination);
    expect(JSON.parse(recorded)).toEqual({ tree: manifest.tree, stages: [
      { role: 'host', exitCode: outcome.exitCode, signal: outcome.signal, startFailure: outcome.startFailure },
    ] });
    expect(recorded).not.toContain('private-canary');
    // A later exit must not turn a startup error or prior failure into a successful receipt.
    child.emit('exit', 0, null);
    expect(read(destination)).toBe(recorded);
  });

  it('builds roles serially and fingerprints only after both zero exits and fresh source checks', async () => {
    const { manifest } = applicationPairFixture(), children = [new EventEmitter(), new EventEmitter()];
    const memberStarted = gate<void>(), sequence: string[] = [];
    const spawnBuild = vi.fn((instance: { role: string }) => {
      sequence.push(`spawn:${instance.role}`);
      if (instance.role === 'member') memberStarted.resolve();
      return children[instance.role === 'host' ? 0 : 1];
    });
    const verifyAfterBuild = vi.fn(() => { sequence.push('verify'); });
    const fingerprint = vi.fn((instance: { role: string }) => { sequence.push(`fingerprint:${instance.role}`); return instance.role === 'host' ? '1'.repeat(64) : '2'.repeat(64); });
    const running = runBuildCopies(manifest, { spawnBuild, verifyAfterBuild, fingerprint });
    expect(sequence).toEqual(['spawn:host']);
    expect(JSON.parse(read(path.join(manifest.stateRoot, 'build-results.json')))).toEqual({ tree: manifest.tree, stages: [] });
    children[0].emit('exit', 0, null); await memberStarted.promise;
    expect(sequence).toEqual(['spawn:host', 'verify', 'spawn:member']);
    expect(JSON.parse(read(path.join(manifest.stateRoot, 'build-results.json')))).toEqual({ tree: manifest.tree, stages: [
      { role: 'host', exitCode: 0, signal: null, startFailure: false },
    ] });
    expect(existsSync(path.join(manifest.stateRoot, 'built.json'))).toBe(false);
    children[1].emit('exit', 0, null); await running;
    expect(sequence).toEqual(['spawn:host', 'verify', 'spawn:member', 'verify', 'fingerprint:host', 'fingerprint:member']);
    expect(JSON.parse(read(path.join(manifest.stateRoot, 'build-results.json')))).toEqual({ tree: manifest.tree, stages: ['host', 'member'].map(role => ({ role, exitCode: 0, signal: null, startFailure: false })) });
    expect(JSON.parse(read(path.join(manifest.stateRoot, 'built.json')))).toEqual({ tree: manifest.tree, executables: ['1'.repeat(64), '2'.repeat(64)] });
  });

  it.each([1, 2])('keeps original exit receipts but no built marker if source verification fails after role %i', async failedStage => {
    const { manifest } = applicationPairFixture(), children = [new EventEmitter(), new EventEmitter()];
    const memberStarted = gate<void>();
    const spawnBuild = vi.fn((instance: { role: string }) => {
      if (instance.role === 'member') memberStarted.resolve();
      return children[instance.role === 'host' ? 0 : 1];
    });
    let checked = 0;
    const verifyAfterBuild = vi.fn(() => { if (++checked === failedStage) throw new Error('synthetic source drift'); });
    const fingerprint = vi.fn(() => 'unexpected fingerprint');
    const failed = expect(runBuildCopies(manifest, { spawnBuild, verifyAfterBuild, fingerprint })).rejects.toThrow('synthetic source drift');
    children[0].emit('exit', 0, null);
    if (failedStage === 2) { await memberStarted.promise; children[1].emit('exit', 0, null); }
    await failed;
    expect(spawnBuild).toHaveBeenCalledTimes(failedStage);
    expect(verifyAfterBuild).toHaveBeenCalledTimes(failedStage);
    expect(fingerprint).not.toHaveBeenCalled();
    expect(existsSync(path.join(manifest.stateRoot, 'built.json'))).toBe(false);
    expect(JSON.parse(read(path.join(manifest.stateRoot, 'build-results.json')))).toEqual({ tree: manifest.tree, stages: ['host', 'member'].slice(0, failedStage).map(role => ({ role, exitCode: 0, signal: null, startFailure: false })) });
  });
});
