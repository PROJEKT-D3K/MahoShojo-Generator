#!/usr/bin/env python3
"""Compile real Desktop Rust modules headlessly, with reproducible source/lock evidence.

This does not validate Tauri IPC/ACL/UI, Windows, OS keyring, or a deployed service.
The synthetic loopback tests never use user credentials or a configurable production origin.
Usage: CARGO_TARGET_DIR=... python3 scripts/verify-desktop-arena-native.py --work-dir /tmp/arena-native
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = ROOT / "apps/desktop/src-tauri"
MODULES = ["local_ai_discovery", "local_ai_launch", "ai", "ai_responses", "ai_anthropic", "ai_google", "blob", "cloud", "library", "local_card", "maintenance", "provider_profile",
           "provider_target", "public_cache", "secret", "sse", "store", "web_package",
           "package_path", "arena_hosted", "arena_story", "backup", "restore", "export", "external_link", "arena_room_protocol", "arena_room_state", "arena_room_http",
           "arena_room_socket", "arena_room", "magic_tea_party", "image_asset", "audit", "gc", "hosted_preset", "arena_room_generation"]
TEST_MODULES = ["ai_contract_tests", "ai_e2e_tests", "test_fixture"]


def run(command, work, log):
    with log.open("w") as output:
        result = subprocess.run(command, cwd=work, stdout=output, stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed ({result.returncode}); inspect {log}")


def write_if_changed(path, content):
    if not path.exists() or path.read_text() != content:
        path.write_text(content)


def lock_packages(text):
    result = set()
    for block in text.split("[[package]]")[1:]:
        fields = dict(re.findall(r'^(name|version|source|checksum) = "([^"\n]+)"$', block, re.MULTILINE))
        if fields.get("source"):
            result.add(tuple(fields.get(k) for k in ("name", "version", "source", "checksum")))
    return result


def source_hashes():
    paths = [PRODUCT / "src" / f"{name}.rs" for name in MODULES + TEST_MODULES + ["arena_hosted_tests", "arena_hosted_json", "arena_hosted_json_tests"]]
    paths += [PRODUCT / "src/local_ai_discovery_tests.rs", ROOT / "fixtures/local-ai-discovery.json"]
    paths += sorted((PRODUCT / "src").glob("arena_hosted_*.rs"))
    paths += sorted((PRODUCT / "src").glob("arena_story_*.rs"))
    paths += [PRODUCT / "src/magic_tea_party_tests.rs", PRODUCT / "src/magic_tea_party_journey_tests.rs", ROOT / "packages/contracts/fixtures/desktop-magic-tea-party.json"]
    paths += sorted((PRODUCT / "src/cloud").glob("*.rs"))
    paths += [PRODUCT / "src/cloud_tavern_tests.rs", PRODUCT / "src/cloud_tavern_stream_tests.rs",
              ROOT / "packages/contracts/fixtures/desktop-hosted-tavern.json",
              ROOT / "packages/contracts/fixtures/desktop-hosted-tavern-stream.json"]
    paths += [ROOT / "packages/contracts/fixtures/battle-report-history.json",
              ROOT / "packages/contracts/fixtures/public-ranking.json",
              ROOT / "packages/contracts/fixtures/arena-strict-preflight.json",
              ROOT / "packages/contracts/fixtures/desktop-room-session.json",
              ROOT / "packages/contracts/fixtures/desktop-room-ipc.json",
              ROOT / "config/hosted-routing.json", ROOT / "config/arena-room-origins.json",
              PRODUCT / "src/arena_room_tauri.rs",
              PRODUCT / "src/lib.rs", PRODUCT / "build.rs", PRODUCT / "capabilities/main-ui.json"]
    paths += sorted((PRODUCT / "src/generated").glob("*.json"))
    paths += sorted((ROOT / "packages/contracts/fixtures").glob("desktop-story-*.json"))
    paths += [ROOT / "packages/contracts/fixtures/desktop-arena-hosted.json",
              ROOT / "packages/contracts/fixtures/arena-generation-ranking.json",
              ROOT / "packages/contracts/fixtures/arena-companion.json", ROOT / "packages/contracts/fixtures/desktop-arena-hosted-json.json",
              ROOT / "packages/contracts/fixtures/arena-companion-utf16.json", ROOT / "packages/contracts/fixtures/arena-companion-error-utf16.json", PRODUCT / "Cargo.toml", PRODUCT / "Cargo.lock", Path(__file__).resolve()]
    # Freeze nested module files and literal include inputs too: hand-maintained lists
    # miss newly linked storage tests and fixtures (for example IMG-2a).
    native_sources = sorted((PRODUCT / "src").rglob("*.rs"))
    paths += native_sources
    for source in native_sources:
        for included in re.findall(r'include_(?:str|bytes)!\(\s*"([^"\n]+)"\s*\)', source.read_text()):
            paths.append((source.parent / included).resolve())
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--cargo", default="cargo")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--all-tests", action="store_true", help="Also run all existing modules' regression tests")
    scope.add_argument("--test-filter", action="append", help="Run a Rust test-name filter; repeat for serial groups")
    parser.add_argument("--test-threads", type=int, default=4, help="Rust test threads per group (default: 4)")
    args = parser.parse_args()
    if args.test_threads < 1:
        parser.error("--test-threads must be positive")
    if args.test_filter and any(not value.strip() for value in args.test_filter):
        parser.error("--test-filter must not be empty")
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    initial_hashes = source_hashes()
    manifest = (PRODUCT / "Cargo.toml").read_text()
    manifest = re.sub(r"\[build-dependencies\]\n.*?(?=\n\[)", "", manifest, flags=re.DOTALL)
    manifest = re.sub(r"\[lib\]\n.*?(?=\n\[)", '[lib]\npath = "lib.rs"\n', manifest, flags=re.DOTALL)
    manifest = re.sub(r"^tauri = .*\n", "", manifest, flags=re.MULTILINE)
    write_if_changed(work / "Cargo.toml", manifest)
    lock = (PRODUCT / "Cargo.lock").read_text()
    (work / "Cargo.lock").write_text(lock)
    facade = '''// Only entry-point callers are absent, so their unused helpers are expected.
#![allow(dead_code)]
extern crate self as tauri;
pub mod ipc {
    pub struct Channel<T>(std::marker::PhantomData<T>);
    impl<T> Channel<T> {
        pub fn send(&self, _: T) -> Result<(), std::convert::Infallible> {
            panic!("Headless tests must exercise the real production test sinks, never this facade")
        }
    }
}
'''
    for name in MODULES + TEST_MODULES:
        if name in TEST_MODULES:
            facade += "#[cfg(test)]\n"
        facade += f'#[path = {json.dumps(str(PRODUCT / "src" / (name + ".rs")))}]\nmod {name};\n'
    write_if_changed(work / "lib.rs", facade)
    # Cargo only prunes unused platform dependencies; every resolved registry tuple must
    # remain exactly in the production lock. Never permit a quiet dependency upgrade.
    run([args.cargo, "metadata", "--offline", "--format-version", "1"], work, work / "metadata.log")
    if not lock_packages((work / "Cargo.lock").read_text()) <= lock_packages(lock):
        raise RuntimeError("headless dependencies drifted from the production Cargo.lock")
    filters = args.test_filter or ([None] if args.all_tests else ["arena_hosted"])
    for index, test_filter in enumerate(filters, start=1):
        command = [args.cargo, "test", "--offline", "--locked"]
        if test_filter is not None:
            command.append(test_filter)
        command += ["--", f"--test-threads={args.test_threads}", "--nocapture"]
        log_name = "tests.log" if len(filters) == 1 else f"tests-{index}.log"
        run(command, work, work / log_name)
        if args.test_filter and not re.search(r"test result: ok\. [1-9][0-9]* passed;", (work / log_name).read_text()):
            raise RuntimeError(f"test filter {test_filter!r} did not run any passing tests; inspect {work / log_name}")
    run([args.cargo, "clippy", "--offline", "--locked", "--all-targets", "--", "-D", "warnings"], work, work / "clippy.log")
    if source_hashes() != initial_hashes:
        raise RuntimeError("verification inputs changed during the run; rerun against stable sources")
    hashes = initial_hashes
    (work / "source-verification.json").write_text(json.dumps({
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
        "workingTreeDirty": subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=ROOT, check=False).returncode != 0,
        "sourceSha256": hashes,
        "sourceInputsStable": True,
        "harnessSha256": hashlib.sha256(facade.encode()).hexdigest(),
        "productionLockSubsetVerified": True,
        "tests": "all real imported modules" if args.all_tests else args.test_filter or "arena_hosted",
        "testThreads": args.test_threads,
        "pending": ["Tauri IPC/ACL/UI", "Windows", "OS keyring", "deployed Hono", "real account and BYOK"],
    }, ensure_ascii=False, indent=2) + "\n")
    print(f"Verified real Rust sources; evidence: {work / 'source-verification.json'}")


if __name__ == "__main__":
    main()
