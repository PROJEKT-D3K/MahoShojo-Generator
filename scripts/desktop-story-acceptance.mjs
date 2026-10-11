/** DESK-103 W01: explicit, disposable Windows test-checkout adapter. No installs. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStoryMockFaults, startStoryMocks, validateStoryMockFaults } from './desktop-story-acceptance-mock.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const native = 'apps/desktop/src-tauri/src/';
export const PATCH_FILES = ['lib.rs', 'arena_hosted.rs', 'cloud.rs', 'secret.rs'].map(name => native + name);
const PRODUCTION_ID = 'me.colanns.mahoshojo.desktop';
const PREFIX = PRODUCTION_ID + '.hostedstoryacceptance.h';
export const SYNTHETIC_CARDS = ['甲', '乙'].map(name => ({ templateId: '通用角色', name: `合成角色${name}`, content: '仅用于本机 W01 验收的虚构角色，无账号、密钥或真实人物信息。' }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => readFileSync(file, 'utf8');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const fail = message => { throw new Error(message); };

export function loopbackOrigin(input) {
  // Reject URL canonicalization tricks, implicit ports, credentials and non-origin paths.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(input ?? '');
  if (!match || Number(match[1]) > 65535 || Number(match[1]) === 1420) fail('origin must be explicit http://127.0.0.1:<1..65535>, excluding Vite 1420');
  return { origin: input, port: Number(match[1]) };
}

export function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) fail(`patch anchor changed or duplicated: ${label}`);
  return source.replace(before, after);
}

export function acceptancePaths(testTree, stateRoot, identifier) {
  if (!new RegExp(`^${PREFIX.replaceAll('.', '\\.')}[a-f0-9]{32}$`).test(identifier)) fail('invalid isolated identifier');
  for (const candidate of [testTree, stateRoot]) if (!path.isAbsolute(candidate)) fail('paths must be absolute');
  testTree = path.resolve(testTree); stateRoot = path.resolve(stateRoot);
  if (contains(testTree, stateRoot) || contains(stateRoot, testTree)) fail('state root and test checkout must be separate');
  return {
    testTree, stateRoot, identifier,
    config: path.join(stateRoot, 'tauri-acceptance.json'),
    webview: path.join(stateRoot, 'webview'),
    target: path.join(stateRoot, 'cargo-target'),
  };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectLinks(candidate) {
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)) fail('isolated path must not contain symlinks/junctions');
    if (path.dirname(current) === current) break;
  }
}

export function patchSources(original, paths, honoOrigin, nextOrigin, mockFaults = {}) {
  const faultDigest = hash(JSON.stringify(validateStoryMockFaults(mockFaults)));
  const hono = loopbackOrigin(honoOrigin), next = loopbackOrigin(nextOrigin);
  if (hono.port === next.port) fail('Hono and Next ports must differ');
  acceptancePaths(paths.testTree, paths.stateRoot, paths.identifier);
  const result = Object.fromEntries(Object.entries(original).map(([file, value]) => [file, value.replaceAll('\r\n', '\n')]));
  const patch = (file, before, after) => { result[native + file] = replaceOnce(result[native + file], before, after, file); };
  patch('arena_hosted.rs', '    #[cfg(test)]\n    pub(crate) fn with_story_loopback_origins(', '    // Disposable acceptance checkout only.\n    pub(crate) fn with_story_loopback_origins(');
  patch('lib.rs', 'arena_hosted::ArenaState::new(library.shared_stories())',
    `arena_hosted::ArenaState::with_story_loopback_origins(library.shared_stories(), ${JSON.stringify(hono.origin)}, ${JSON.stringify(next.origin)})`);
  patch('secret.rs', `pub const SECRET_STORE_SERVICE: &str = "${PRODUCTION_ID}";`,
    `pub const SECRET_STORE_SERVICE: &str = "${paths.identifier}";`);
  // Pin both branches: missing env/debug flags can never fall back to production.
  patch('cloud.rs', 'const CLOUD_ORIGIN_PRODUCTION: &str = "https://mahoshojo.colanns.me";',
    `const CLOUD_ORIGIN_PRODUCTION: &str = ${JSON.stringify(next.origin)};`);
  patch('cloud.rs', 'option_env!("MAHOSHOJO_CLOUD_ORIGIN")', `Some(${JSON.stringify(next.origin)})`);
  const guard = `// Synthetic HTTP fault configuration SHA-256: ${faultDigest}\n#[cfg(not(debug_assertions))]\ncompile_error!("Disposable story acceptance checkout cannot build release");\n\n#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {\n    // Before Builder, WebView creation, or SecretStore access.\n    let acceptance_context = tauri::generate_context!();\n    assert_eq!(acceptance_context.config().identifier, ${JSON.stringify(paths.identifier)}, "isolated Tauri config required");\n    assert_eq!(secret::SECRET_STORE_SERVICE, ${JSON.stringify(paths.identifier)});\n    assert_eq!(std::env::var("MAHOSHOJO_STORY_ACCEPTANCE").ok().as_deref(), Some(${JSON.stringify(paths.identifier)}), "use the acceptance launcher");\n    let acceptance_webview = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").expect("isolated WebView folder required");\n    assert_eq!(std::fs::canonicalize(acceptance_webview).expect("WebView folder missing"), std::fs::canonicalize(${JSON.stringify(paths.webview)}).expect("expected WebView folder missing"));`;
  patch('lib.rs', '#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {', guard);
  patch('lib.rs', '.run(tauri::generate_context!())', '.run(acceptance_context)');
  patch('lib.rs', '            // 单实例先于一切本地库访问', `            assert!(data_root.ends_with(${JSON.stringify(paths.identifier)}), "unexpected app data namespace");\n\n            // 单实例先于一切本地库访问`);
  return Object.fromEntries(Object.entries(result).map(([file, value]) => [file, original[file].includes('\r\n') ? value.replaceAll('\n', '\r\n') : value]));
}

export async function checkPorts(ports) {
  const reservations = [];
  try {
    for (const binding of ports) {
      const { port, host } = typeof binding === 'number' ? { port: binding, host: '127.0.0.1' } : binding;
      if (!['127.0.0.1', '::1'].includes(host)) fail('only loopback port probes are permitted');
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port, exclusive: true }, resolve); });
      reservations.push(server);
    }
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

function verifyCheckout(root, expectedTree) {
  rejectLinks(root);
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== realpathSync(root)) fail('test-tree must be the checkout root');
  if (expectedTree && git(root, 'rev-parse', 'HEAD^{tree}') !== expectedTree) fail('test checkout differs from source tree');
  // Refuse ignored environment/config overrides too, without reading their values.
  for (const directory of [root, path.join(root, 'apps/desktop'), path.join(root, 'apps/desktop/src-tauri')]) {
    for (const entry of readdirSync(directory)) {
      if ((/^\.env(?:\.|$)/i.test(entry) && !/\.(example|sample)$/i.test(entry)) || /^tauri\.(windows|linux|macos)(?:\.conf\.|\.toml$)/i.test(entry) || /^(?:tauri\.conf\.json5|tauri\.toml)$/i.test(entry)) fail('test checkout contains an environment/platform override');
    }
  }
}

export async function preflight({ testTree, stateRoot, honoOrigin, nextOrigin, source = sourceRoot, mockFaults = {} }) {
  mockFaults = validateStoryMockFaults(mockFaults);
  if (!path.isAbsolute(testTree) || !path.isAbsolute(stateRoot)) fail('paths must be absolute');
  source = realpathSync(source); testTree = path.resolve(testTree); stateRoot = path.resolve(stateRoot);
  if (contains(source, testTree) || contains(testTree, source)) fail('use a separate disposable checkout; source tree is never patched');
  if (contains(source, stateRoot) || contains(stateRoot, source)) fail('state root must be outside the source checkout');
  rejectLinks(stateRoot);
  if (existsSync(stateRoot)) fail('state root must not exist; never reuse a WebView/credential identity');
  if (!existsSync(path.dirname(stateRoot))) fail('state root parent must already exist');
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  if (git(source, 'status', '--porcelain', '--untracked-files=no')) fail('source tracked files must be clean');
  verifyCheckout(testTree, tree);
  if (git(testTree, 'status', '--porcelain', '--untracked-files=all')) fail('test checkout must be clean');
  const paths = acceptancePaths(testTree, stateRoot, PREFIX + randomUUID().replaceAll('-', ''));
  const original = Object.fromEntries(PATCH_FILES.map(file => [file, read(path.join(testTree, file))]));
  const patched = patchSources(original, paths, honoOrigin, nextOrigin, mockFaults);
  await checkPorts([loopbackOrigin(honoOrigin).port, loopbackOrigin(nextOrigin).port, 1420, { host: '::1', port: 1420 }]);
  return { version: 1, ...paths, tree, honoOrigin, nextOrigin, mockFaults, original, patched };
}

export function prepare(plan) {
  // Exclusive directory + exact source hashes before any modification. Partial failures stay blocked.
  rejectLinks(plan.stateRoot); rejectLinks(plan.testTree);
  for (const file of PATCH_FILES) {
    rejectLinks(path.join(plan.testTree, file));
    if (read(path.join(plan.testTree, file)) !== plan.original[file]) fail('test source changed after preflight');
  }
  mkdirSync(plan.stateRoot);
  mkdirSync(plan.webview);
  for (const [index, card] of SYNTHETIC_CARDS.entries()) writeFileSync(path.join(plan.stateRoot, `synthetic-card-${index + 1}.json`), JSON.stringify(card, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(plan.config, JSON.stringify({ identifier: plan.identifier }, null, 2) + '\n', { flag: 'wx' });
  const hashes = {};
  for (const file of PATCH_FILES) {
    const destination = path.join(plan.testTree, file);
    const temporary = destination + '.acceptance-' + randomUUID();
    writeFileSync(temporary, plan.patched[file], { flag: 'wx' });
    // Replace the test-tree directory entry; do not mutate a potentially shared hardlink inode.
    renameSync(temporary, destination);
    hashes[file] = hash(plan.patched[file]);
  }
  const { original, patched, ...manifest } = plan;
  writeFileSync(path.join(plan.stateRoot, 'temporary.patch'), execFileSync('git', ['-C', plan.testTree, 'diff', '--', ...PATCH_FILES]));
  writeFileSync(path.join(plan.stateRoot, 'acceptance.json'), JSON.stringify({ ...manifest, hashes }, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export function validatePrepared(stateRoot) {
  if (!path.isAbsolute(stateRoot)) fail('state root must be absolute');
  stateRoot = path.resolve(stateRoot); rejectLinks(stateRoot);
  const manifest = JSON.parse(read(path.join(stateRoot, 'acceptance.json')));
  validateStoryMockFaults(manifest.mockFaults === undefined ? {} : manifest.mockFaults);
  const paths = acceptancePaths(manifest.testTree, stateRoot, manifest.identifier);
  for (const [key, value] of Object.entries(paths)) if (manifest[key] !== value) fail(`isolation manifest mismatch: ${key}`);
  if (manifest.version !== 1 || !/^[a-f0-9]{40,64}$/.test(manifest.tree)) fail('invalid acceptance manifest');
  const hono = loopbackOrigin(manifest.honoOrigin), next = loopbackOrigin(manifest.nextOrigin);
  if (hono.port === next.port) fail('Hono and Next ports must differ');
  verifyCheckout(paths.testTree, manifest.tree);
  if (git(paths.testTree, 'ls-files', '--others', '--exclude-standard')) fail('unexpected untracked test checkout files');
  const changed = git(paths.testTree, 'diff', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...PATCH_FILES].sort())) fail('unexpected test checkout edits');
  // Recompute the allowed patch from immutable HEAD, not just a mutable manifest hash.
  const originals = Object.fromEntries(PATCH_FILES.map(file => [file, execFileSync('git', ['-C', paths.testTree, 'show', `HEAD:${file}`], { encoding: 'utf8' })]));
  const patched = patchSources(originals, paths, hono.origin, next.origin, manifest.mockFaults);
  for (const file of PATCH_FILES) {
    rejectLinks(path.join(paths.testTree, file));
    const actual = read(path.join(paths.testTree, file));
    if (actual.replaceAll('\r\n', '\n') !== patched[file].replaceAll('\r\n', '\n') || hash(actual) !== manifest.hashes?.[file]) fail(`prepared source changed: ${file}`);
  }
  rejectLinks(paths.config); rejectLinks(paths.webview); rejectLinks(paths.target);
  if (read(paths.config) !== JSON.stringify({ identifier: paths.identifier }, null, 2) + '\n') fail('Tauri config must only set isolated identifier');
  if (existsSync(paths.target)) fail('isolated Cargo target must not already exist');
  if (readdirSync(paths.webview).length !== 0 || existsSync(path.join(stateRoot, 'launched.json'))) fail('W01 launcher is single-use; prepare a new isolated checkout/state root');
  return manifest;
}

/** @returns {Record<string, string | undefined>} */
export function launchEnvironment(manifest, inherited = process.env) {
  const env = {};
  // Do not inherit app tokens, proxy, TAURI_CONFIG, WebView browser args, RUSTFLAGS or Cargo overrides.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|CARGO_HOME|RUSTUP_HOME)$/i;
  for (const [key, value] of Object.entries(inherited)) if (allowed.test(key)) env[key] = value;
  return { ...env, WEBVIEW2_USER_DATA_FOLDER: manifest.webview, MAHOSHOJO_STORY_ACCEPTANCE: manifest.identifier, CARGO_TARGET_DIR: manifest.target, CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', COREPACK_ENABLE_NETWORK: '0', CI: 'true',
    pnpm_config_pm_on_fail: 'error', pnpm_config_runtime_on_fail: 'error',
    pnpm_config_verify_deps_before_run: 'error', pnpm_config_offline: 'true',
    npm_config_manage_package_manager_versions: 'false', npm_config_package_manager_strict_version: 'true' };
}

export function assertToolVersions({ pnpm, cargo, rustc, expectedPnpm, minimumRust }) {
  if (pnpm.trim() !== expectedPnpm) fail(`existing pnpm ${expectedPnpm} is required; automatic installation is disabled`);
  const minimum = minimumRust.split('.').map(Number);
  for (const [name, output] of Object.entries({ cargo, rustc })) {
    const match = new RegExp(`^${name} (\\d+)\\.(\\d+)\\.(\\d+)(?: |$)`).exec(output.trim());
    if (!match || Number(match[1]) !== minimum[0] || Number(match[2]) < minimum[1]) fail(`existing ${name} >= ${minimumRust} stable is required; automatic installation is disabled`);
  }
}

function verifyExistingTools(manifest, env) {
  const expectedPnpm = JSON.parse(read(path.join(manifest.testTree, 'package.json'))).packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  const minimumRust = read(path.join(manifest.testTree, 'apps/desktop/src-tauri/Cargo.toml')).match(/^rust-version = "(\d+\.\d+)"$/m)?.[1];
  if (!expectedPnpm || !minimumRust) fail('toolchain declarations changed; review the harness before launching');
  const options = { cwd: manifest.testTree, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] };
  let pnpm, cargo, rustc;
  try {
    // Static command only. Corepack/pnpm/rustup have no-install guards before even these probes.
    pnpm = execFileSync(path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32/cmd.exe'), ['/d', '/s', '/c', 'pnpm --version'], options);
    cargo = execFileSync('cargo', ['--version'], options);
    rustc = execFileSync('rustc', ['--version'], options);
  } catch { fail('existing pnpm/Cargo/Rust tools are missing or unavailable; no tools were requested for installation'); }
  assertToolVersions({ pnpm, cargo, rustc, expectedPnpm, minimumRust });
}

async function launch(stateRoot) {
  if (process.platform !== 'win32') fail('launch is Windows-only; headless tests do not replace Tauri/Windows acceptance');
  const manifest = validatePrepared(stateRoot);
  if (git(sourceRoot, 'rev-parse', 'HEAD^{tree}') !== manifest.tree || git(sourceRoot, 'status', '--porcelain', '--untracked-files=no')) fail('launcher source must remain clean and match prepared tree');
  const app = path.join(manifest.testTree, 'apps/desktop');
  const cli = path.join(app, 'node_modules/@tauri-apps/cli/tauri.js');
  if (!existsSync(cli) || !existsSync(path.join(app, 'node_modules/vite'))) fail('existing test-checkout dependencies are required; this script never installs them');
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) fail('Windows app data directory is unavailable');
    if (existsSync(path.join(base, manifest.identifier))) fail('isolated application namespace already exists');
  }
  const env = launchEnvironment(manifest);
  verifyExistingTools(manifest, env);
  await checkPorts([1420, { host: '::1', port: 1420 }]);
  // Bind both mocks before spawning any app. Bind failure closes the first service.
  const mocks = await startStoryMocks({ honoPort: loopbackOrigin(manifest.honoOrigin).port, nextPort: loopbackOrigin(manifest.nextOrigin).port, faults: manifest.mockFaults });
  try {
    writeFileSync(path.join(stateRoot, 'launched.json'), JSON.stringify({ pid: process.pid, honoOrigin: manifest.honoOrigin, nextOrigin: manifest.nextOrigin }) + '\n', { flag: 'wx' });
    const child = spawn(process.execPath, [cli, 'dev', '--no-watch', '--config', manifest.config, '--', '--locked', '--offline'], { cwd: app, env, stdio: 'inherit', shell: false });
    // Ctrl+C is delivered to the foreground process group; never kill unrelated ports/processes.
    const signal = () => {};
    process.on('SIGINT', signal);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
      process.exitCode = code;
    } finally { process.off('SIGINT', signal); }
  } finally {
    await mocks.close();
    writeFileSync(path.join(stateRoot, 'mock-trace.json'), JSON.stringify(mocks.trace(), null, 2) + '\n', { flag: 'wx' });
  }
}

async function main(args) {
  const mode = ['preflight', 'prepare', 'launch'].includes(args[0]) ? args.shift() : 'preflight';
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--test-tree', '--state-root', '--hono-origin', '--next-origin', '--fault-config'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  if (!options['--state-root']) fail('required: --state-root <absolute new directory>');
  if (mode === 'launch') {
    if (Object.keys(options).length !== 1) fail('launch accepts only --state-root');
    return launch(options['--state-root']);
  }
  if (!options['--test-tree'] || !options['--hono-origin'] || !options['--next-origin']) fail('required: --test-tree, --state-root, --hono-origin and --next-origin');
  const plan = await preflight({ testTree: options['--test-tree'], stateRoot: options['--state-root'], honoOrigin: options['--hono-origin'], nextOrigin: options['--next-origin'], mockFaults: options['--fault-config'] ? await readStoryMockFaults(options['--fault-config']) : {} });
  if (mode === 'prepare') prepare(plan);
  console.log(JSON.stringify({ mode, testTree: plan.testTree, stateRoot: plan.stateRoot, identifier: plan.identifier, honoOrigin: plan.honoOrigin, nextOrigin: plan.nextOrigin, mockFaults: plan.mockFaults, prepared: mode === 'prepare', applicationStarted: false }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
