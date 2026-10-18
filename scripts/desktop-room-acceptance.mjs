/** Disposable two-instance Room acceptance. Never patches the source checkout or installs tools. */
import { createHash, randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { assertToolVersions, checkPorts, contains, rejectLinks, replaceOnce, safeLaunchEnvironment } from './desktop-acceptance-common.mjs';
import { createRoomMockDiagnostics, formatRoomMockDiagnostic } from './desktop-room-acceptance-diagnostics.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const native = 'apps/desktop/src-tauri/src/';
export const PATCH_FILES = ['lib.rs', 'secret.rs', 'cloud.rs', 'arena_room_http.rs', 'arena_room_socket.rs', 'arena_hosted.rs'].map(name => native + name);
export const ENDPOINTS = Object.freeze({ room: 'https://room.acceptance.invalid:34443', auth: 'http://127.0.0.1:34080', hostname: 'room.acceptance.invalid', roomPort: 34443, authPort: 34080 });
const PKI_FILE = 'scripts/fixtures/desktop-room-acceptance-pki.json';
const PRODUCTION_ID = 'me.colanns.mahoshojo.desktop';
const PREFIX = PRODUCTION_ID + '.roomacceptance.';
// Deliberate harness capabilities, never every operation added to the production registry.
export const ROOM_ACCEPTANCE_FAULTS = Object.freeze(['create', 'join', 'leave', 'close', 'config', 'config-unsupported', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve', 'proposal-unsupported']);
export const ROOM_GENERATION_SCENARIOS = Object.freeze(['seed', 'seed-large', 'delta', 'gap', 'disconnect', 'complete', 'hold-read', 'release-read']);
export const ROOM_START_SCENARIOS = Object.freeze(['start-reserve-only', 'start-unavailable', 'start-available', 'start-large', 'start-delta', 'start-complete', 'start-cancel-wait', 'start-cancel-complete']);
export const ROOM_CANCEL_SCENARIOS = Object.freeze([...ROOM_GENERATION_SCENARIOS, 'cancel-wait', 'cancel-complete']);
const ROOM_OBSERVATION_OPERATIONS = Object.freeze(['discover', 'create', 'join', 'session', 'generationRead', 'ticket', 'leave', 'close', 'config', 'proposalSubmit', 'proposalWithdraw', 'proposalResolve']);
const read = file => readFileSync(file, 'utf8');
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
const mockFailures = new WeakMap();
export const launcherFailureMessage = error => mockFailures.get(error)
  ?? 'Room acceptance failed; keep the isolated directory and inspect the bounded stage results.';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const gitPaths = (root, ...args) => execFileSync('git', ['-C', root, ...args, '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const json = value => JSON.stringify(value, null, 2) + '\n';
const writeNew = (file, value) => writeFileSync(file, json(value), { flag: 'wx' });

export function validatePki(pki) {
  if (!pki || Object.keys(pki).sort().join(',') !== 'ca,cert,key,notice' || !pki.notice?.startsWith('PUBLIC SYNTHETIC TEST MATERIAL.')) fail('only the public synthetic PKI fixture is accepted');
  const ca = new X509Certificate(pki.ca), cert = new X509Certificate(pki.cert);
  if (!ca.ca || cert.ca || cert.subjectAltName !== 'DNS:room.acceptance.invalid' || !cert.verify(ca.publicKey) || !cert.checkPrivateKey(createPrivateKey(pki.key))) fail('invalid synthetic certificate chain or hostname');
  const now = Date.now();
  for (const item of [ca, cert]) if (Date.parse(item.validFrom) > now || Date.parse(item.validTo) <= now) fail('synthetic certificate fixture expired or not yet valid');
  return pki;
}

export function instancePaths(testTree, stateRoot, identifier, role) {
  if (!['host', 'member'].includes(role) || !new RegExp(`^${PREFIX.replaceAll('.', '\\.')}${role}[a-f0-9]{32}$`).test(identifier)) fail('invalid isolated role/identifier');
  if (![testTree, stateRoot].every(path.isAbsolute)) fail('paths must be absolute');
  testTree = path.resolve(testTree); stateRoot = path.resolve(stateRoot);
  if (contains(testTree, stateRoot) || contains(stateRoot, testTree)) fail('state and checkout must be separate');
  const root = path.join(stateRoot, role);
  return { role, testTree, identifier, config: path.join(root, 'tauri-acceptance.json'), webview: path.join(root, 'webview'), target: path.join(root, 'cargo-target') };
}

export function patchSources(original, instance, pki) {
  validatePki(pki);
  const output = Object.fromEntries(PATCH_FILES.map(file => [file, original[file].replaceAll('\r\n', '\n')]));
  const patch = (file, before, after) => { const key = native + file; output[key] = replaceOnce(output[key], before, after, file); };
  const caDer = [...new X509Certificate(pki.ca).raw].join(',');
  patch('secret.rs', `pub const SECRET_STORE_SERVICE: &str = "${PRODUCTION_ID}";`, `pub const SECRET_STORE_SERVICE: &str = ${JSON.stringify(instance.identifier)};`);
  patch('cloud.rs', 'const CLOUD_ORIGIN_PRODUCTION: &str = "https://mahoshojo.colanns.me";', `const CLOUD_ORIGIN_PRODUCTION: &str = ${JSON.stringify(ENDPOINTS.auth)};`);
  patch('cloud.rs', 'option_env!("MAHOSHOJO_CLOUD_ORIGIN")', `Some(${JSON.stringify(ENDPOINTS.auth)})`);
  patch('arena_hosted.rs', '    #[cfg(test)]\n    pub(crate) fn with_story_loopback_origins(', '    // Disposable Room acceptance checkout only.\n    pub(crate) fn with_story_loopback_origins(');
  patch('lib.rs', 'arena_hosted::ArenaState::new(library.shared_stories())', `arena_hosted::ArenaState::with_story_loopback_origins(library.shared_stories(), ${JSON.stringify(ENDPOINTS.auth)}, ${JSON.stringify(ENDPOINTS.auth)})`);
  const guard = `#[cfg(not(debug_assertions))]\ncompile_error!("Disposable Room acceptance checkout cannot build release");\n\n#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {\n    // Before Builder, WebView creation, or SecretStore access.\n    let acceptance_context = tauri::generate_context!();\n    assert_eq!(acceptance_context.config().identifier, ${JSON.stringify(instance.identifier)}, "isolated Tauri config required");\n    assert_eq!(secret::SECRET_STORE_SERVICE, ${JSON.stringify(instance.identifier)});\n    assert_eq!(std::env::var("MAHOSHOJO_ROOM_ACCEPTANCE").ok().as_deref(), Some(${JSON.stringify(instance.identifier)}), "use the Room acceptance launcher");\n    let acceptance_webview = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").expect("isolated WebView folder required");\n    assert_eq!(std::fs::canonicalize(acceptance_webview).expect("WebView folder missing"), std::fs::canonicalize(${JSON.stringify(instance.webview)}).expect("expected WebView folder missing"));`;
  patch('lib.rs', '#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {', guard);
  patch('lib.rs', '.run(tauri::generate_context!())', '.run(acceptance_context)');
  patch('lib.rs', '            // 单实例先于一切本地库访问', `            assert!(data_root.ends_with(${JSON.stringify(instance.identifier)}), "unexpected app data namespace");\n\n            // 单实例先于一切本地库访问`);
  const originStart = '// These are build-time repository inputs, never renderer or environment overrides.\n';
  const originalOrigins = "// These are build-time repository inputs, never renderer or environment overrides.\npub(crate) fn service_origin() -> Result<Url, RoomError> {\n    let config: Value =\n        serde_json::from_str(include_str!(\"../../../../config/hosted-routing.json\"))\n            .map_err(|_| RoomError::new(\"internal-error\", \"not-applicable\"))?;\n    fixed_https_origin(config.pointer(\"/origins/primary\").and_then(Value::as_str))\n}\npub(crate) fn caller_origin() -> Result<String, RoomError> {\n    let config: Value =\n        serde_json::from_str(include_str!(\"../../../../config/arena-room-origins.json\"))\n            .map_err(|_| RoomError::new(\"internal-error\", \"not-applicable\"))?;\n    let origin = fixed_https_origin(\n        config\n            .pointer(\"/targets/production/allowedWebOrigins/0\")\n            .and_then(Value::as_str),\n    )?;\n    Ok(origin.origin().ascii_serialization())\n}\nfn fixed_https_origin(raw: Option<&str>) -> Result<Url, RoomError> {\n    let invalid = || RoomError::new(\"internal-error\", \"not-applicable\");\n    let url = Url::parse(raw.ok_or_else(invalid)?).map_err(|_| invalid())?;\n    if url.scheme() != \"https\"\n        || url.host_str().is_none()\n        || !url.username().is_empty()\n        || url.password().is_some()\n        || url.path() != \"/\"\n        || url.query().is_some()\n        || url.fragment().is_some()\n        || url.port_or_known_default() != Some(443)\n    {\n        return Err(invalid());\n    }\n    Ok(url)\n}\n";
  patch('arena_room_http.rs', originalOrigins, `${originStart}pub(crate) fn service_origin() -> Result<Url, RoomError> {\n    fixed_https_origin(Some(${JSON.stringify(ENDPOINTS.room)}))\n}\npub(crate) fn caller_origin() -> Result<String, RoomError> {\n    Ok(service_origin()?.origin().ascii_serialization())\n}\nfn fixed_https_origin(raw: Option<&str>) -> Result<Url, RoomError> {\n    if raw != Some(${JSON.stringify(ENDPOINTS.room)}) {\n        return Err(RoomError::new("internal-error", "not-applicable"));\n    }\n    Url::parse(${JSON.stringify(ENDPOINTS.room)}).map_err(|_| RoomError::new("internal-error", "not-applicable"))\n}\n`);
  patch('arena_room_http.rs', '                .https_only(true)\n                .build()', `                .https_only(true)\n                .resolve(${JSON.stringify(ENDPOINTS.hostname)}, std::net::SocketAddr::from(([127, 0, 0, 1], ${ENDPOINTS.roomPort})))\n                .tls_certs_merge([reqwest::Certificate::from_der(&[${caDer}]).map_err(|_| RoomError::new("internal-error", "not-applicable"))?])\n                .build()`);
  patch('arena_room_socket.rs', 'use rustls_platform_verifier::BuilderVerifierExt;\n', '');
  patch('arena_room_socket.rs', 'TcpStream::connect((host.as_str(), port))', 'TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))');
  patch('arena_room_socket.rs', '    let mut tls = rustls::ClientConfig::builder_with_provider(provider)', `    let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(\n        [rustls::pki_types::CertificateDer::from(vec![${caDer}])], provider.clone(),\n    ).map_err(|_| internal())?;\n    let mut tls = rustls::ClientConfig::builder_with_provider(provider)`);
  patch('arena_room_socket.rs', '        .with_platform_verifier()\n        .map_err(|_| internal())?', '        .dangerous()\n        .with_custom_certificate_verifier(Arc::new(verifier))');
  return Object.fromEntries(PATCH_FILES.map(file => [file, original[file].includes('\r\n') ? output[file].replaceAll('\n', '\r\n') : output[file]]));
}

function verifyCheckout(root, expectedTree) {
  rejectLinks(root);
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== realpathSync(root)) fail('copy must be a checkout root');
  if (git(root, 'rev-parse', 'HEAD^{tree}') !== expectedTree) fail('checkout differs from source tree');
  for (const directory of [root, path.join(root, 'apps/desktop'), path.join(root, 'apps/desktop/src-tauri')]) {
    for (const entry of readdirSync(directory)) if ((/^\.env(?:\.|$)/i.test(entry) && !/\.(example|sample)$/i.test(entry)) || /^tauri\.(windows|linux|macos)(?:\.conf\.|\.toml$)/i.test(entry) || /^(?:tauri\.conf\.json5|tauri\.toml)$/i.test(entry)) fail('checkout contains environment/platform override');
  }
}

export async function preflight({ hostTree, memberTree, stateRoot, source = sourceRoot }) {
  if (![source, hostTree, memberTree, stateRoot].every(path.isAbsolute)) fail('paths must be absolute');
  const paths = [source, hostTree, memberTree, stateRoot].map(p => path.resolve(p));
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (contains(paths[i], paths[j]) || contains(paths[j], paths[i])) fail('source, both copies and state must be separate');
  for (const item of paths) rejectLinks(item);
  if (existsSync(stateRoot) || !existsSync(path.dirname(stateRoot))) fail('state root must be fresh with an existing parent');
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  if (git(source, 'status', '--porcelain', '--untracked-files=no')) fail('source tracked files must be clean');
  const pki = validatePki(JSON.parse(read(path.join(source, PKI_FILE))));
  const instances = [['host', hostTree], ['member', memberTree]].map(([role, testTree]) => {
    verifyCheckout(testTree, tree);
    if (git(testTree, 'status', '--porcelain', '--untracked-files=all')) fail('disposable copies must be clean');
    return instancePaths(testTree, stateRoot, PREFIX + role + randomUUID().replaceAll('-', ''), role);
  });
  const original = Object.fromEntries(PATCH_FILES.map(file => [file, read(path.join(source, file))]));
  const patches = instances.map(instance => patchSources(original, instance, pki));
  await checkPorts([ENDPOINTS.roomPort, ENDPOINTS.authPort]);
  return { version: 1, source: path.resolve(source), stateRoot: path.resolve(stateRoot), tree, pkiHash: hash(json(pki)), instances, original, patches };
}

export function prepare(plan) {
  rejectLinks(plan.stateRoot);
  if (existsSync(plan.stateRoot)) fail('state root already exists');
  if (plan.version !== 1 || plan.instances?.length !== 2) fail('invalid preparation plan');
  verifyCheckout(plan.source, plan.tree);
  if (git(plan.source, 'status', '--porcelain', '--untracked-files=no')) fail('source changed after preflight');
  const pki = validatePki(JSON.parse(read(path.join(plan.source, PKI_FILE))));
  if (plan.pkiHash !== hash(json(pki))) fail('fixture changed after preflight');
  const roots = [plan.source, ...plan.instances.map(instance => instance.testTree), plan.stateRoot];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) fail('isolation paths overlap');
  for (const [index, instance] of plan.instances.entries()) {
    if (json(instance) !== json(instancePaths(instance.testTree, plan.stateRoot, instance.identifier, index === 0 ? 'host' : 'member'))) fail('preparation paths changed');
    verifyCheckout(instance.testTree, plan.tree);
    if (git(instance.testTree, 'status', '--porcelain', '--untracked-files=all')) fail('copy changed after preflight');
    for (const file of PATCH_FILES) if (read(path.join(plan.source, file)) !== plan.original[file]) fail('source changed after preflight');
    if (json(patchSources(plan.original, instance, pki)) !== json(plan.patches[index])) fail('preparation patch changed');
  }
  for (const instance of plan.instances) for (const file of PATCH_FILES) {
    rejectLinks(path.join(instance.testTree, file));
    if (read(path.join(instance.testTree, file)).replaceAll('\r\n', '\n') !== plan.original[file].replaceAll('\r\n', '\n')) fail('copy changed after preflight');
  }
  mkdirSync(plan.stateRoot);
  for (const [index, instance] of plan.instances.entries()) {
    mkdirSync(path.dirname(instance.config)); mkdirSync(instance.webview);
    writeNew(instance.config, { identifier: instance.identifier });
    for (const file of PATCH_FILES) {
      const destination = path.join(instance.testTree, file), temp = destination + '.' + randomUUID();
      writeFileSync(temp, plan.patches[index][file], { flag: 'wx' }); renameSync(temp, destination);
    }
    writeFileSync(path.join(plan.stateRoot, instance.role, 'temporary.patch'), execFileSync('git', ['-C', instance.testTree, 'diff', '--', ...PATCH_FILES]), { flag: 'wx' });
  }
  const { original, patches, ...manifest } = plan;
  writeNew(path.join(plan.stateRoot, 'acceptance.json'), manifest);
  return manifest;
}

export function validatePrepared(stateRoot, source = sourceRoot) {
  if (!path.isAbsolute(stateRoot)) fail('state root must be absolute');
  stateRoot = path.resolve(stateRoot); rejectLinks(stateRoot);
  const manifest = JSON.parse(read(path.join(stateRoot, 'acceptance.json')));
  if (Object.keys(manifest).sort().join(',') !== 'instances,pkiHash,source,stateRoot,tree,version' || manifest.version !== 1 || manifest.stateRoot !== stateRoot || manifest.source !== path.resolve(source) || !/^[a-f0-9]{40}$/.test(manifest.tree)) fail('invalid acceptance manifest');
  verifyCheckout(source, manifest.tree);
  if (git(source, 'status', '--porcelain', '--untracked-files=no')) fail('launcher source changed');
  const pki = validatePki(JSON.parse(read(path.join(source, PKI_FILE))));
  if (hash(json(pki)) !== manifest.pkiHash || manifest.instances?.length !== 2) fail('fixture or instance manifest changed');
  const roots = [source, ...manifest.instances.map(instance => instance.testTree), stateRoot];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) fail('isolation paths overlap');
  const identifiers = new Set();
  for (const [index, instance] of manifest.instances.entries()) {
    const expected = instancePaths(instance.testTree, stateRoot, instance.identifier, index === 0 ? 'host' : 'member');
    if (json(instance) !== json(expected) || identifiers.has(instance.identifier)) fail('instance manifest changed');
    identifiers.add(instance.identifier); verifyCheckout(instance.testTree, manifest.tree);
    if (gitPaths(instance.testTree, 'ls-files', '--others', '--exclude-standard').length) fail('unexpected untracked copy files');
    if (json(gitPaths(instance.testTree, 'diff', '--name-only', 'HEAD')) !== json([...PATCH_FILES].sort())) fail('unexpected copy edits');
    const originals = Object.fromEntries(PATCH_FILES.map(file => [file, execFileSync('git', ['-C', instance.testTree, 'show', `HEAD:${file}`], { encoding: 'utf8' })]));
    const patched = patchSources(originals, instance, pki);
    for (const file of PATCH_FILES) {
      rejectLinks(path.join(instance.testTree, file));
      if (read(path.join(instance.testTree, file)).replaceAll('\r\n', '\n') !== patched[file].replaceAll('\r\n', '\n')) fail(`prepared source changed: ${file}`);
    }
    for (const file of [instance.config, instance.webview, instance.target]) rejectLinks(file);
    if (read(instance.config) !== json({ identifier: instance.identifier })) fail('config must only set isolated identifier');
  }
  return manifest;
}

export function launchEnvironment(instance, inherited = process.env) {
  return { ...safeLaunchEnvironment(instance, inherited), MAHOSHOJO_ROOM_ACCEPTANCE: instance.identifier, CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0' };
}

export function buildArguments(instance) {
  return ['build', '--debug', '--no-bundle', '--config', instance.config, '--', '--locked', '--offline'];
}

function binaryPath(instance) { return path.join(instance.target, 'debug', 'mahoshojo-desktop.exe'); }
function verifyBinary(manifest) {
  const built = JSON.parse(read(path.join(manifest.stateRoot, 'built.json')));
  if (built.tree !== manifest.tree || built.executables?.length !== 2) fail('missing matching builds');
  for (const [index, instance] of manifest.instances.entries()) if (built.executables[index] !== hash(readFileSync(binaryPath(instance)))) fail('built executable changed');
}
function verifyWindowsTools(instance, env) {
  if (process.platform !== 'win32') fail('build/launch require Windows; Node checks do not replace Windows acceptance');
  const expectedPnpm = JSON.parse(read(path.join(instance.testTree, 'package.json'))).packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  const minimumRust = read(path.join(instance.testTree, 'apps/desktop/src-tauri/Cargo.toml')).match(/^rust-version = "(\d+\.\d+)"$/m)?.[1];
  const options = { cwd: instance.testTree, env, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] };
  if (!expectedPnpm || !minimumRust) fail('tool declarations changed');
  assertToolVersions({ expectedPnpm, minimumRust,
    pnpm: execFileSync(path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32/cmd.exe'), ['/d', '/s', '/c', 'pnpm --version'], options),
    cargo: execFileSync('cargo', ['--version'], options), rustc: execFileSync('rustc', ['--version'], options) });
}
/** Each started build has one small, honest exit receipt; failures never start the next role. */
export async function runBuildCopies(manifest, {
  spawnBuild = instance => {
    const app = path.join(instance.testTree, 'apps/desktop');
    return spawn(process.execPath, [path.join(app, 'node_modules/@tauri-apps/cli/tauri.js'), ...buildArguments(instance)], { cwd: app, env: launchEnvironment(instance), stdio: 'inherit', shell: false });
  },
  verifyAfterBuild = () => validatePrepared(manifest.stateRoot),
  fingerprint = instance => hash(readFileSync(binaryPath(instance))),
} = {}) {
  const receipt = { tree: manifest.tree, stages: [] };
  const destination = path.join(manifest.stateRoot, 'build-results.json');
  writeNew(destination, receipt);
  for (const instance of manifest.instances) {
    const result = await new Promise(resolve => {
      let settled = false;
      const finish = (exitCode, signal, startFailure = false) => {
        if (settled) return;
        settled = true; resolve({ role: instance.role, exitCode, signal, startFailure });
      };
      try {
        const child = spawnBuild(instance);
        child.once('error', () => finish(null, null, true));
        child.once('exit', (code, signal) => finish(code, signal));
      } catch { finish(null, null, true); }
    });
    receipt.stages.push(result);
    const temporary = destination + '.' + randomUUID();
    writeNew(temporary, receipt); renameSync(temporary, destination);
    if (result.startFailure || result.exitCode !== 0 || result.signal) fail('build did not complete successfully');
    verifyAfterBuild();
  }
  writeNew(path.join(manifest.stateRoot, 'built.json'), { tree: manifest.tree, executables: manifest.instances.map(fingerprint) });
}

async function build(stateRoot) {
  const manifest = validatePrepared(stateRoot);
  if (existsSync(path.join(stateRoot, 'build-results.json'))) fail('build is single-use; use fresh copies after failure');
  for (const instance of manifest.instances) {
    const env = launchEnvironment(instance); verifyWindowsTools(instance, env);
    if (existsSync(instance.target)) fail('target must be fresh');
    if (!existsSync(path.join(instance.testTree, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js'))) fail('existing dependencies required; no installation is performed');
  }
  await runBuildCopies(manifest);
}

/** Start only the trusted, fixed mock entry; stdout contains closed, redacted control messages. */
export function startMock(manifest, selfCheck = false, syntheticCancel = false, syntheticStart = false) {
  const api = path.join(manifest.source, 'apps/api');
  const require = createRequire(path.join(api, 'package.json'));
  const loader = require.resolve('tsx');
  const child = spawn(process.execPath, ['--import', loader, path.join(api, 'scripts/desktop-room-acceptance-mock.ts'), ...(selfCheck ? ['--self-check'] : []), ...(syntheticStart ? ['--synthetic-start'] : syntheticCancel ? ['--synthetic-cancel'] : []), '--state-root', manifest.stateRoot], {
    cwd: api, env: safeLaunchEnvironment(manifest.instances[0]), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  return monitorMock(child, selfCheck, { syntheticCancel, syntheticStart });
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function checkedSummary(value, syntheticCancel = false, syntheticStart = false) {
  const keys = ['tlsTrusted', 'tlsNoRootRejected', 'tlsWrongSanRejected', 'authPkceOneUse', 'roomHttp', 'roomWss', 'roomProposals', 'proposalReceiptLoss', 'fixedPublicRefs', 'roomGenerationRead', 'roomGenerationRecovery', 'generationReadOnly'];
  if (syntheticCancel || syntheticStart) keys.push('generationCancel');
  if (syntheticStart) keys.push('generationStart', 'syntheticProducer');
  if (!exactKeys(value, keys) || keys.some(key => value[key] !== (key === 'generationReadOnly' ? !syntheticCancel && !syntheticStart : true))) fail('invalid self-check result');
  return value;
}
function checkedObservations(value, syntheticCancel = false, syntheticStart = false) {
  const keys = ['id', 'event', 'rooms', 'receipts', 'actors', 'activeConnections', 'authSessions', 'trace', 'generation'];
  if (value.event !== 'observations' || !exactKeys(value, keys) || !['rooms', 'receipts', 'actors', 'activeConnections', 'authSessions'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 256) || !Array.isArray(value.trace) || value.trace.length > 256) fail('invalid observations');
  const counts = ['readRequests', 'readDispatches', 'startRequests', 'cancelRequests', 'modelRequests', 'startDispatches', 'cancelDispatches', 'modelDispatches', 'deltaFrames', 'droppedFrames', 'disconnections'];
  if (syntheticStart) counts.push('startPortCalls', 'syntheticProducers', 'startReservations');
  const generation = value.generation;
  if (!exactKeys(generation, ['fixture', 'readHeld', 'cancelEnabled', ...(syntheticStart ? ['startEnabled'] : []), ...counts])
    || !['none', 'running', 'completed', ...((syntheticCancel || syntheticStart) ? ['cancelled'] : [])].includes(generation.fixture) || typeof generation.readHeld !== 'boolean'
    || counts.some(key => !Number.isSafeInteger(generation[key]) || generation[key] < 0 || generation[key] > 65_536)
    || generation.cancelEnabled !== (syntheticCancel || syntheticStart) || (syntheticStart && generation.startEnabled !== true)
    || ['modelDispatches', ...(!syntheticStart ? ['startDispatches'] : []), ...(!syntheticCancel && !syntheticStart ? ['cancelDispatches'] : [])].some(key => generation[key] !== 0)) fail('invalid generation observations');
  for (const event of value.trace) {
    if (event.kind === 'refused' && exactKeys(event, ['kind'])) continue;
    if (event.kind === 'public-card' && exactKeys(event, ['kind', 'operation', 'status']) && ['random', 'read'].includes(event.operation) && Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599) continue;
    if (event.kind === 'ws' && exactKeys(event, ['kind', 'outcome']) && ['accepted', 'rejected'].includes(event.outcome)) continue;
    if (event.kind === 'room-http' && exactKeys(event, ['kind', 'operation', 'status', 'dropped']) && [...ROOM_OBSERVATION_OPERATIONS, ...((syntheticCancel || syntheticStart) ? ['generationCancel'] : []), ...(syntheticStart ? ['generationStart'] : [])].includes(event.operation) && Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599 && typeof event.dropped === 'boolean') continue;
    fail('invalid observation event');
  }
  return value;
}

export function monitorMock(child, selfCheck = false, { readinessTimeoutMs = 30_000, stopTimeoutMs = 3000, syntheticCancel = false, syntheticStart = false } = {}) {
  let nextId = 0, stopped = false, closing, readySeen = false, aborted = false, pendingLineBytes = 0;
  let terminal, finishExit, drainExpired = false;
  const diagnostics = createRoomMockDiagnostics();
  const failure = message => {
    const text = message + (terminal ? ` (code=${terminal.code}, signal=${terminal.signal})` : '') + diagnostics.summary();
    const error = new Error(text); mockFailures.set(error, text); return error;
  };
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const abort = () => {
    if (aborted) return;
    aborted = true; lines.close(); readyReject(new Error('invalid mock response'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('invalid mock response')); }
    pending.clear(); child.kill();
  };
  child.stdout.on('data', chunk => {
    if (aborted) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      if (pendingLineBytes + end - start > 64 * 1024) { abort(); return; }
      pendingLineBytes = 0; start = end + 1;
    }
    pendingLineBytes += bytes.length - start;
    if (pendingLineBytes > 64 * 1024) abort();
  });
  const timer = setTimeout(() => {
    drainExpired = true;
    if (terminal) finishExit();
    else { readyReject(failure('mock readiness failed')); child.kill(); }
  }, readinessTimeoutMs);
  lines.on('line', line => {
    if (aborted) return;
    try {
      if (Buffer.byteLength(line) > 64 * 1024) fail('mock response too large');
      const value = JSON.parse(line);
      if (value.event === (selfCheck ? 'self-check' : 'ready')) {
        const keys = ['event', 'roomOrigin', 'authOrigin', 'selfCheck', ...(selfCheck ? [] : ['roomAddress'])];
        if (readySeen || !exactKeys(value, keys) || value.roomOrigin !== ENDPOINTS.room || value.authOrigin !== ENDPOINTS.auth || (!selfCheck && (!exactKeys(value.roomAddress, ['host', 'port']) || value.roomAddress.host !== '127.0.0.1' || value.roomAddress.port !== ENDPOINTS.roomPort))) fail('invalid readiness');
        value.selfCheck = checkedSummary(value.selfCheck, syntheticCancel, syntheticStart);
        readySeen = true; clearTimeout(timer); readyResolve(value); if (terminal) finishExit(); return;
      }
      const entry = pending.get(value.id);
      if (!readySeen || !Number.isSafeInteger(value.id) || !entry) fail('unknown control response');
      if (value.event === 'error' && exactKeys(value, ['id', 'event', 'code']) && value.code === 'ACCEPTANCE_CONTROL_REFUSED') {
        pending.delete(value.id); clearTimeout(entry.timer); entry.reject(new Error('mock control refused')); return;
      }
      if (entry.command === 'observe') checkedObservations(value, syntheticCancel, syntheticStart);
      else if (entry.command === 'stop' && !(value.event === 'stopped' && exactKeys(value, ['id', 'event']))) fail('invalid stop response');
      else if (entry.command === 'arm-fault' && !(value.event === 'armed' && value.operation === entry.operation && exactKeys(value, ['id', 'event', 'operation']))) fail('invalid fault response');
      else if (entry.command === 'generation' && !(value.event === 'generation' && value.scenario === entry.operation && exactKeys(value, ['id', 'event', 'scenario']))) fail('invalid generation response');
      pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value);
    } catch { abort(); }
  });
  child.stderr.on('data', chunk => { if (!stopped) diagnostics.append(chunk); });
  const exit = new Promise(resolve => {
    const finish = (code, signal) => {
      if (stopped) return;
      terminal ??= { code, signal };
      stopped = true; clearTimeout(timer); lines.close(); readyReject(failure('mock stopped before ready'));
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure('mock stopped')); }
      pending.clear(); resolve(terminal);
    };
    finishExit = () => finish(terminal.code, terminal.signal);
    child.once('error', error => {
      diagnostics.append(formatRoomMockDiagnostic('spawn', error)); finish(null, 'spawn-error');
    });
    child.once('exit', (code, signal) => {
      terminal ??= { code, signal };
      // Before readiness, close drains the final stderr line. The original
      // readiness/stop deadline still settles inherited pipes that never close.
      if (readySeen || drainExpired || child.stderr.readableEnded) finishExit();
    });
    child.once('close', finish);
  });
  const command = async (command, operation) => {
    if (stopped || terminal || aborted || !readySeen || pending.size) fail('mock unavailable or control already pending');
    if (!['observe', 'stop', 'arm-fault', 'generation'].includes(command)
      || (command === 'arm-fault' ? ![...ROOM_ACCEPTANCE_FAULTS, ...((syntheticCancel || syntheticStart) ? ['generationCancel'] : []), ...(syntheticStart ? ['generationStart'] : [])].includes(operation)
        : command === 'generation' ? !(syntheticStart ? ROOM_START_SCENARIOS : syntheticCancel ? ROOM_CANCEL_SCENARIOS : ROOM_GENERATION_SCENARIOS).includes(operation) : operation !== undefined)) fail('invalid control command');
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const entry = { command, operation, resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(failure('mock control timeout')); child.kill(); }, stopTimeoutMs) };
      pending.set(id, entry);
      child.stdin.write(JSON.stringify({ id, command, ...(operation ? command === 'generation' ? { scenario: operation } : { operation } : {}) }) + '\n', error => {
        if (error && pending.delete(id)) { clearTimeout(entry.timer); reject(new Error('mock control write failed')); child.kill(); }
      });
    });
  };
  // A broken pipe can emit both callback error and stream error.
  child.stdin.on('error', () => { child.kill(); });
  return { ready, exit, command, close() {
    if (closing) return closing;
    closing = (async () => {
      if (stopped) return;
      const timeout = setTimeout(() => { drainExpired = true; if (terminal) finishExit(); else child.kill(); }, stopTimeoutMs);
      try { await command('stop').catch(() => {}); await exit; }
      finally { clearTimeout(timeout); }
    })();
    return closing;
  } };
}

async function selfCheck(stateRoot, syntheticCancel = false, syntheticStart = false) {
  const manifest = validatePrepared(stateRoot), mock = startMock(manifest, true, syntheticCancel, syntheticStart);
  try { const result = await mock.ready; const end = await mock.exit; if (end.code !== 0 || end.signal) fail('mock self-check failed'); writeNew(path.join(stateRoot, syntheticStart ? 'self-check-start.json' : syntheticCancel ? 'self-check-cancel.json' : 'self-check.json'), result); return result; }
  finally { await mock.close(); }
}

async function launch(stateRoot, syntheticCancel = false, syntheticStart = false) {
  const manifest = validatePrepared(stateRoot); verifyBinary(manifest);
  if (process.platform !== 'win32') fail('launch requires Windows');
  if (existsSync(path.join(stateRoot, 'launched.json'))) fail('launch is single-use; preserve evidence and prepare fresh copies');
  for (const instance of manifest.instances) {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) if (!base || existsSync(path.join(base, instance.identifier))) fail('isolated application namespace must be fresh');
    if (readdirSync(instance.webview).length) fail('isolated WebView must be fresh');
  }
  await runApplicationPair(manifest, startMock(manifest, false, syntheticCancel, syntheticStart), { syntheticCancel, syntheticStart });
}

/** Local two-window lifecycle; injectable process ports let tests prove cancellation without a GUI. */
export async function runApplicationPair(manifest, mock, {
  spawnApp = instance => spawn(binaryPath(instance), [], { cwd: path.join(instance.testTree, 'apps/desktop'), env: launchEnvironment(instance), stdio: 'ignore', shell: false }),
  inputStream = process.stdin, signals = process, report = value => console.log(value), syntheticCancel = false, syntheticStart = false,
} = {}) {
  const children = [], exits = [];
  let requestedStop = false, readyReceived = false, backendEnded = false;
  const input = readline.createInterface({ input: inputStream });
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill(); if (!readyReceived) void mock.close(); };
  const requested = () => { requestedStop = true; stop(); };
  signals.on('SIGINT', requested); signals.on('SIGTERM', requested);
  try {
    const ready = await mock.ready; readyReceived = true;
    if (requestedStop) return;
    writeNew(path.join(manifest.stateRoot, 'launched.json'), { tree: manifest.tree, selfCheck: ready.selfCheck });
    for (const instance of manifest.instances) {
      const child = spawnApp(instance);
      children.push(child);
      exits.push(new Promise(resolve => { child.once('error', () => { stop(); resolve({ role: instance.role, code: null, signal: 'spawn-error' }); }); child.once('exit', (code, signal) => { if (code !== 0 || signal) stop(); resolve({ role: instance.role, code, signal }); }); }));
    }
    report(`Two isolated apps started. Commands: fault ${[...ROOM_ACCEPTANCE_FAULTS, ...((syntheticCancel || syntheticStart) ? ['generationCancel'] : []), ...(syntheticStart ? ['generationStart'] : [])].join('|')}, generation ${(syntheticStart ? ROOM_START_SCENARIOS : syntheticCancel ? ROOM_CANCEL_SCENARIOS : ROOM_GENERATION_SCENARIOS).join('|')}, observe, stop. Use synthetic accounts 101 and 202.`);
    let control = Promise.resolve();
    input.on('line', line => { control = control.then(async () => {
      if (line === 'stop') { requested(); return; }
      if (line === 'observe') { report(JSON.stringify(await mock.command('observe'))); return; }
      const operation = line.startsWith('fault ') ? line.slice('fault '.length) : null;
      const scenario = line.startsWith('generation ') ? line.slice('generation '.length) : null;
      if ([...ROOM_ACCEPTANCE_FAULTS, ...((syntheticCancel || syntheticStart) ? ['generationCancel'] : []), ...(syntheticStart ? ['generationStart'] : [])].includes(operation)) report(JSON.stringify(await mock.command('arm-fault', operation)));
      else if ((syntheticStart ? ROOM_START_SCENARIOS : syntheticCancel ? ROOM_CANCEL_SCENARIOS : ROOM_GENERATION_SCENARIOS).includes(scenario)) report(JSON.stringify(await mock.command('generation', scenario)));
      else report('Unknown command');
    }).catch(() => report('Mock control failed')); });
    const unexpectedMock = mock.exit.then(() => { backendEnded = true; for (const child of children) if (child.exitCode === null) child.kill(); });
    void unexpectedMock;
    const ended = await Promise.all(exits); await control;
    writeNew(path.join(manifest.stateRoot, 'application-exits.json'), { requestedStop, applications: ended });
    if (!backendEnded) { const observations = await mock.command('observe'); writeNew(path.join(manifest.stateRoot, 'mock-observations.json'), observations); }
    if ((!requestedStop && ended.some(item => item.code !== 0 || item.signal)) || backendEnded) fail('an application or mock failed');
  } finally {
    signals.off('SIGINT', requested); signals.off('SIGTERM', requested);
    input.close(); for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(exits); await mock.close();
  }
}

export function verify(stateRoot, source = sourceRoot) {
  const manifest = validatePrepared(stateRoot, source);
  if (existsSync(path.join(stateRoot, 'built.json'))) verifyBinary(manifest);
  return { sourceAndCopiesMatch: true, built: existsSync(path.join(stateRoot, 'built.json')), launched: existsSync(path.join(stateRoot, 'launched.json')), observations: existsSync(path.join(stateRoot, 'mock-observations.json')), windowsAcceptancePassed: false };
}

export async function main(args) {
  const mode = args.shift();
  if (!['preflight', 'prepare', 'self-check', 'self-check-cancel', 'self-check-start', 'build', 'launch', 'launch-cancel', 'launch-start', 'verify'].includes(mode)) fail('expected preflight, prepare, self-check, build, launch or verify');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host-tree', '--member-tree', '--state-root'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  if (!options['--state-root']) fail('--state-root is required');
  if (['preflight', 'prepare'].includes(mode)) {
    if (!options['--host-tree'] || !options['--member-tree']) fail('--host-tree and --member-tree are required');
    const plan = await preflight({ hostTree: options['--host-tree'], memberTree: options['--member-tree'], stateRoot: options['--state-root'] });
    if (mode === 'prepare') prepare(plan);
    console.log(JSON.stringify({ mode, stateRoot: plan.stateRoot, instances: plan.instances, endpoints: ENDPOINTS, applicationStarted: false }));
  } else {
    if (Object.keys(options).length !== 1) fail('this command accepts only --state-root');
    const stateRoot = options['--state-root'];
    if (mode === 'self-check-cancel') console.log(JSON.stringify(await selfCheck(stateRoot, true)));
    if (mode === 'self-check-start') console.log(JSON.stringify(await selfCheck(stateRoot, false, true)));
    if (mode === 'launch-start') await launch(stateRoot, false, true);
    if (mode === 'launch-cancel') await launch(stateRoot, true);
    if (mode === 'self-check') console.log(JSON.stringify(await selfCheck(stateRoot)));
    if (mode === 'build') await build(stateRoot);
    if (mode === 'launch') await launch(stateRoot);
    if (mode === 'verify') console.log(JSON.stringify(verify(stateRoot)));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(launcherFailureMessage(error)); process.exitCode = 1; });
