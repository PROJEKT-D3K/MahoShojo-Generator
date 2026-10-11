#!/usr/bin/env python3
"""Bounded, serial Native short-history evidence; fixture tiers are not product caps.

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

TEST = "arena_story::branch::storage::tests::resource_probes::real_store_short_history_resource_probe"
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


def boundaries(markers):
    found = [m for m in markers if m["phase"] == "end-return"]
    if not found:
        return None
    assert len(found) == 1
    events = found[0]["extra"]["events"]
    e = {row["name"]: row["nanos"] for row in events}
    assert len(e) == len(events)
    result = {}
    for name, before in [("stages", "before-acquire"), ("connection", "before-acquire"),
                         ("permit", "before-admission")]:
        result[name] = {
            "uncontendedAcquireCallNs" if name != "permit" else "admissionCallNs": e[f"{name}.acquired"] - e[f"{name}.{before}"],
            "heldLowerBoundNs" if name != "permit" else "lifetimeLowerBoundNs": e[f"{name}.before-release"] - e[f"{name}.acquired"],
            "conservativeHeldUpperBoundIncludingAcquireNs" if name != "permit" else "conservativeLifetimeUpperBoundIncludingAdmissionNs": e[f"{name}.after-release"] - e[f"{name}.{before}"],
            "upperBoundCaveat": "includes acquisition/admission wait and probe overhead; deliberately conservative",
            "releaseBracketNs": e[f"{name}.after-release"] - e[f"{name}.before-release"],
        }
    ending = "commit" if "sqlite.commit.before" in e else "rollback"
    result["sqlite"] = {"beginCallNs": e["sqlite.begin.after"]-e["sqlite.begin.before"],
                        "ending": ending,
                        "endCallNs": e[f"sqlite.{ending}.after"]-e[f"sqlite.{ending}.before"],
                        "beginReturnedToEndReturnedNs": e[f"sqlite.{ending}.after"]-e["sqlite.begin.after"]}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--chapters", type=int, choices=[100, 1000, 10000], required=True)
    parser.add_argument("--phase-timeout", type=float, default=600)
    args = parser.parse_args()
    assert args.phase_timeout > 0
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    binary = args.binary.resolve()
    source = json.loads(args.source_manifest.read_text())
    assert freeze_valid(source), "source drift before probe"
    binary_sha = digest(binary)
    nonce = uuid.uuid4().hex
    # Conservative fixture admission estimate; neither an observed failure nor
    # a product limit. The independent floor fuse remains in force throughout.
    required = FLOOR + 64*1024**2 + args.chapters*4000*4
    free = shutil.disk_usage(evidence).free
    admission = {"requiredFreeBytes": required, "actualFreeBytes": free,
                 "chapters": args.chapters, "scope": "experimental admission only"}
    (evidence/"admission.json").write_text(json.dumps(admission, indent=2)+"\n")
    assert free > required, "insufficient conservative fixture headroom; not run"
    root = Path(tempfile.mkdtemp(prefix="owned-fixture-", dir=evidence))
    command = [str(binary), "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
    run = {"binary": str(binary), "binarySha256": binary_sha, "sourceManifest": str(args.source_manifest.resolve()),
           "sourceManifestSha256": digest(args.source_manifest), "command": command,
           "nonce": nonce, "root": str(root), "chapters": args.chapters,
           "sampleIntervalSeconds": .025, "phaseTimeoutSeconds": args.phase_timeout}
    (evidence/"run.json").write_text(json.dumps(run, indent=2)+"\n")
    records = []
    for phase in ["fixture", "rollback", "verify-rollback", "branch", "verify"]:
        env = dict(os.environ, MAHO_SHORT_PHASE=phase, MAHO_SHORT_ROOT=str(root),
                   MAHO_SHORT_CHAPTERS=str(args.chapters), MAHO_SHORT_NONCE=nonce, TMPDIR=str(root))
        log = evidence/f"{phase}.log"
        samples_path = evidence/f"{phase}-samples.jsonl"
        start = time.monotonic()
        samples = 0
        samples_bytes = 0
        min_free = free
        max_rss = max_hwm = max_files = max_wal = 0
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
                    if "SHORT_HISTORY " in line:
                        assert len(markers) < 128, "marker overflow"
                        markers.append(json.loads(line.split("SHORT_HISTORY ", 1)[1]))
                    test_success |= "test result: ok. 1 passed; 0 failed; 0 ignored;" in line
        starts = [m for m in markers if m["phase"] == "process-start"]
        ends = [m for m in markers if m["phase"] == "process-end"]
        valid = (reason is None and code == 0 and test_success and samples > 0 and
                 len(starts) == len(ends) == 1 and
                 starts[0]["extra"] == {"phase": phase, "debugAssertions": True} and
                 ends[0]["extra"] == {"phase": phase} and
                 all(m["nonce"] == nonce and m["pid"] == child.pid and m["chapters"] == args.chapters for m in markers))
        row = {"phase": phase, "evidenceValid": valid, "exitCode": code, "fuse": reason,
               "elapsedSeconds": time.monotonic()-start, "samples": samples, "sampleBytes": samples_bytes,
               "minFreeBytes": min_free, "sampledMaxRssBytes": max_rss, "sampledMaxHwmBytes": max_hwm,
               "sampledMaxFixtureLogicalBytes": max_files, "sampledMaxWalBytes": max_wal,
               "finalFiles": inventory(root), "markers": markers, "boundaries": boundaries(markers),
               "caveat": "sampled RSS/HWM and non-atomic logical file lengths; no absolute/allocated peak; boundary brackets include probe overhead, no kernel exact lock time; no Tauri/IPC/OS ENOSPC/fsync/cancel-SLO claim"}
        (evidence/f"{phase}.json").write_text(json.dumps(row, indent=2)+"\n")
        records.append({k: v for k, v in row.items() if k not in ("markers", "finalFiles")})
        print(json.dumps(records[-1]), flush=True)
        if not valid:
            raise SystemExit(f"invalid {phase}; fixture preserved at {root}")
    assert digest(binary) == binary_sha and freeze_valid(source), "binary/source drift after probe"
    shutil.rmtree(root)
    (evidence/"complete.json").write_text(json.dumps({"evidenceValid": True, "fixtureRemoved": True, "binarySha256": binary_sha, "records": records}, indent=2)+"\n")


if __name__ == "__main__":
    main()
