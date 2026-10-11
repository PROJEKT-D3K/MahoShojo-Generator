#!/usr/bin/env python3
"""Bounded, serial candidate-history growth evidence; fixture tiers are not product caps.

Build the opt-in test from the same frozen source first. Each phase is a fresh
process. RSS/file lengths are 25ms samples, not absolute/allocated disk peaks.
Only runner-owned child processes and disposable fixture roots are terminated or
removed. Logs and samples are bounded; overflow/time/disk fuses invalidate a run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

TEST = "arena_story::branch::tail_rewrite::tests::resource_probes::real_store_candidate_history_resource_probe"
FLOOR = 256 * 1024**2
LOG_LIMIT = 4 * 1024**2
SAMPLE_LIMIT = 32 * 1024**2


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024**2), b""):
            h.update(chunk)
    return h.hexdigest()


def inventory(root):
    result = {}
    for path in root.rglob("*"):
        try:
            if path.is_file():
                result[str(path.relative_to(root))] = path.stat().st_size
        except FileNotFoundError:
            pass
    return result


def memory(pid):
    result = {}
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(("VmRSS:", "VmHWM:")):
                key, value, _unit = line.split()
                result[key.rstrip(":")] = int(value) * 1024
    except FileNotFoundError:
        pass
    return result


def freeze_valid(manifest):
    return all(Path(row["path"]).stat().st_size == row["bytes"] and
               digest(Path(row["path"])) == row["sha256"] for row in manifest)


def preserve_proof(root, evidence):
    # Keep hashes and the small assertion inputs after disposable databases go.
    # This runs after all children exit, outside measured store operations.
    proof = {"files": [], "smallJson": {}}
    total_json = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        assert not path.is_symlink(), "unexpected fixture symlink"
        assert len(proof["files"]) < 128, "proof inventory overflow"
        relative = str(path.relative_to(root))
        size = path.stat().st_size
        proof["files"].append({"path": relative, "bytes": size,
                               "mode": path.stat().st_mode & 0o777, "sha256": digest(path)})
        if path.suffix == ".json":
            total_json += size
            assert size <= 64*1024 and total_json <= 512*1024, "proof JSON budget"
            proof["smallJson"][relative] = json.loads(path.read_text())
    (evidence/"fixture-proof.json").write_text(json.dumps(proof, indent=2)+"\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--seed-evidence", type=Path, help="Read-only source evidence for an interrupted synthetic history fixture; copied before use")
    parser.add_argument("--axis", choices=["upgrade", "history"], required=True)
    parser.add_argument("--phase-timeout", type=float, default=600)
    args = parser.parse_args()
    assert args.phase_timeout > 0
    assert 100 <= args.rows <= 10000
    assert args.seed_evidence or args.rows in (100, 1000, 10000)
    assert not args.seed_evidence or args.axis == "history"
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    binary = args.binary.resolve()
    source = json.loads(args.source_manifest.read_text())
    assert freeze_valid(source), "source drift before probe"
    binary_sha = digest(binary)
    nonce = uuid.uuid4().hex
    # Conservative fixture admission estimate; neither an observed failure nor
    # a product limit. The independent floor fuse remains in force throughout.
    required = max(1_250_000_000, FLOOR + 64*1024**2 + args.rows*4000*8)
    free = shutil.disk_usage(evidence).free
    admission = {"requiredFreeBytes": required, "actualFreeBytes": free,
                 "rows": args.rows, "scope": "experimental admission only"}
    (evidence/"admission.json").write_text(json.dumps(admission, indent=2)+"\n")
    assert free >= required, "insufficient conservative fixture headroom; not run"
    root = Path(tempfile.mkdtemp(prefix="owned-fixture-", dir=evidence))
    if args.seed_evidence:
        seed_evidence = args.seed_evidence.resolve()
        previous = json.loads((seed_evidence/"run.json").read_text())
        seed = Path(previous["root"]).resolve()
        assert previous["axis"] == "history" and seed.parent == seed_evidence
        assert seed.name.startswith("owned-fixture-") and not (seed_evidence/"complete.json").exists()
        # Acquire the same Linux advisory file lock as InstanceGuard before
        # copying the stopped, runner-owned synthetic generation.
        import fcntl
        with (seed/"library.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            original = {}
            for path in seed.rglob("*"):
                assert not path.is_symlink(), "unexpected seed symlink"
                if path.is_file():
                    assert len(original) < 128
                    original[str(path.relative_to(seed))] = {"bytes": path.stat().st_size, "sha256": digest(path)}
            assert sum(item["bytes"] for item in original.values()) <= 64*1024**2, "seed copy admission budget"
            shutil.copytree(seed, root, dirs_exist_ok=True)
            assert all(digest(seed/name) == row["sha256"] == digest(root/name) for name, row in original.items()), "seed changed during copy"
            (evidence/"seed-copy.json").write_text(json.dumps({"sourceEvidence": str(seed_evidence), "sourceRun": previous, "files": original, "copiedAndVerified": True}, indent=2)+"\n")
    command = [str(binary), "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
    run = {"binary": str(binary), "binarySha256": binary_sha, "sourceManifest": str(args.source_manifest.resolve()),
           "sourceManifestSha256": digest(args.source_manifest), "command": command,
           "nonce": nonce, "root": str(root), "rows": args.rows, "axis": args.axis,
           "sampleIntervalSeconds": .025, "phaseTimeoutSeconds": args.phase_timeout}
    (evidence/"run.json").write_text(json.dumps(run, indent=2)+"\n")
    records = []
    phases = ["fixture", "upgrade", "reopen", "restore"] if args.axis == "upgrade" else ["fixture", "rewrite", "reopen"]
    if args.seed_evidence:
        phases = ["adopt", "rewrite", "reopen"]
    for phase in phases:
        env = dict(os.environ, MAHO_HISTORY_PHASE=phase, MAHO_HISTORY_ROOT=str(root), MAHO_HISTORY_AXIS=args.axis,
                   MAHO_HISTORY_ROWS=str(args.rows), MAHO_HISTORY_NONCE=nonce, TMPDIR=str(root))
        log = evidence/f"{phase}.log"
        samples_path = evidence/f"{phase}-samples.jsonl"
        start = time.monotonic()
        samples = 0
        samples_bytes = 0
        min_free = free
        max_rss = max_hwm = max_files = max_wal = max_backup = 0
        reason = None
        with log.open("xb") as output, samples_path.open("x") as sample_output:
            child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            os.set_blocking(child.stdout.fileno(), False)
            output_bytes = 0
            last_sample = -1.0
            try:
                while True:
                    eof = False
                    # Bounded writes, even if a malformed child floods stdout.
                    for _ in range(16):
                        try:
                            chunk = os.read(child.stdout.fileno(), 65536)
                        except BlockingIOError:
                            break
                        if not chunk:
                            eof = True
                            break
                        remaining = LOG_LIMIT - output_bytes
                        output.write(chunk[:remaining])
                        output.flush()  # Make bounded progress markers visible to the supervisor.
                        output_bytes += min(len(chunk), remaining)
                        if len(chunk) > remaining:
                            reason = "process-log-fuse"
                            break
                    if reason:
                        break
                    now = time.monotonic()-start
                    if now > args.phase_timeout:
                        reason = "phase-timeout"
                        break
                    if now-last_sample >= .025:
                        last_sample = now
                        free = shutil.disk_usage(evidence).free
                        min_free = min(min_free, free)
                        mem = memory(child.pid)
                        files = inventory(root)
                        row = {"seconds": now, "freeBytes": free, "memoryBytes": mem, "files": files}
                        line = json.dumps(row, separators=(",", ":"))+"\n"
                        if samples_bytes + len(line) > SAMPLE_LIMIT:
                            reason = "sample-log-fuse"
                        elif free < FLOOR:
                            reason = "free-disk-fuse"
                        if reason:
                            break
                        sample_output.write(line)
                        samples_bytes += len(line)
                        samples += 1
                        max_rss = max(max_rss, mem.get("VmRSS", 0))
                        max_hwm = max(max_hwm, mem.get("VmHWM", 0))
                        max_files = max(max_files, sum(files.values()))
                        max_wal = max(max_wal, files.get("library.sqlite-wal", 0))
                        max_backup = max(max_backup, sum(size for name, size in files.items() if name.startswith("backups/")))
                    if child.poll() is not None and eof:
                        break
                    time.sleep(.005)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                code = child.wait()
                child.stdout.close()
        markers = []
        test_success = False
        if log.stat().st_size <= LOG_LIMIT:
            with log.open() as lines:
                for line in lines:
                    if "HISTORY_RESOURCE " in line:
                        assert len(markers) < 128, "marker overflow"
                        markers.append(json.loads(line.split("HISTORY_RESOURCE ", 1)[1]))
                    test_success |= "test result: ok. 1 passed; 0 failed; 0 ignored;" in line
        starts = [m for m in markers if m["phase"] == "process-start"]
        ends = [m for m in markers if m["phase"] == "process-end"]
        valid = (reason is None and code == 0 and test_success and samples > 0 and
                 len(starts) == len(ends) == 1 and
                 starts[0]["extra"] == {"phase": phase, "debugAssertions": True} and
                 ends[0]["extra"] == {"phase": phase} and
                 all(m["nonce"] == nonce and m["pid"] == child.pid and m["rows"] == args.rows and m["axis"] == args.axis for m in markers))
        row = {"phase": phase, "evidenceValid": valid, "exitCode": code, "fuse": reason,
               "elapsedSeconds": time.monotonic()-start, "samples": samples, "sampleBytes": samples_bytes,
               "minFreeBytes": min_free, "sampledMaxRssBytes": max_rss, "sampledMaxHwmBytes": max_hwm,
               "sampledMaxFixtureLogicalBytes": max_files, "sampledMaxWalBytes": max_wal, "sampledMaxBackupBytes": max_backup,
               "finalFiles": inventory(root), "markers": markers, "axis": args.axis,
               "caveat": "sampled RSS and maximum reported HWM (not assumed reliable cumulative high-water) and non-atomic logical file lengths; no absolute/allocated peak; call timings and transaction hooks include probe overhead, no lock duration or kernel exact lock time; no Tauri/IPC/OS ENOSPC/fsync/cancel-SLO claim"}
        (evidence/f"{phase}.json").write_text(json.dumps(row, indent=2)+"\n")
        records.append({k: v for k, v in row.items() if k not in ("markers", "finalFiles")})
        print(json.dumps(records[-1]), flush=True)
        if not valid:
            raise SystemExit(f"invalid {phase}; fixture preserved at {root}")
    assert digest(binary) == binary_sha and freeze_valid(source), "binary/source drift after probe"
    preserve_proof(root, evidence)
    shutil.rmtree(root)
    (evidence/"complete.json").write_text(json.dumps({"evidenceValid": True, "fixtureRemoved": True, "axis": args.axis, "rows": args.rows, "binarySha256": binary_sha, "records": records}, indent=2)+"\n")


if __name__ == "__main__":
    main()
