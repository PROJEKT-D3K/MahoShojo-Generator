#!/usr/bin/env python3
"""Run opt-in Native test binary with fresh fixture/branch/verify processes.

The binary must be built from this checkout, with ordinary debug assertions.
Sampling is not a proof of instantaneous peaks. HWM is per process, not per
marker. endElapsedUs measures the entire end call, never writer-lock duration.
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--evidence", type=Path, required=True)
parser.add_argument("--mib", type=int, nargs="+", default=[2])
parser.add_argument("--shapes", nargs="+", default=["string", "escapes", "members", "duplicates", "key"])
parser.add_argument("--parts", nargs="+", default=["chapter", "checkpoint"])
args = parser.parse_args()
binary = args.binary.resolve()
evidence = args.evidence.resolve()
evidence.mkdir(parents=True, exist_ok=True)
fixture_parent = evidence / "fixtures"
fixture_parent.mkdir(exist_ok=True)
assert not list(fixture_parent.iterdir()), "preserve and inspect any previous unfinished fixture"
sha = hashlib.sha256()
with binary.open("rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        sha.update(chunk)
binary_sha = sha.hexdigest()
command = [str(binary), "--exact", "arena_story::branch::storage::tests::resource_probes::real_store_long_record_shape_resource_probe", "--ignored", "--nocapture", "--test-threads=1"]
for mib in args.mib:
    assert 0 < mib < 128, "whole three-record package must remain within original 128 MiB"
    for shape in args.shapes:
        for part in args.parts:
            case = f"{mib}MiB-{shape}-{part}"
            # Reserve ample room for main + journal/WAL + uploads; the independent
            # low-space fuse below is an additional guard, not a disk-full test.
            assert shutil.disk_usage(evidence).free > (256 + 5 * mib) * 1024**2
            root = Path(tempfile.mkdtemp(prefix=case + "-", dir=fixture_parent))
            records = []
            for phase in ["fixture", "rollback", "verify-rollback", "branch", "verify"]:
                env = dict(os.environ, MAHO_PROBE_PHASE=phase, MAHO_PROBE_ROOT=str(root), MAHO_PROBE_SHAPE=shape, MAHO_PROBE_BYTES=str(mib * 1024**2), MAHO_PROBE_PART=part, TMPDIR=str(root))
                log = evidence / f"{case}-{phase}.log"
                start = time.monotonic()
                samples = []
                terminated = False
                with log.open("x") as out:
                    p = subprocess.Popen(command, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
                    while p.poll() is None:
                        free = shutil.disk_usage(evidence).free
                        memory = {}
                        try:
                            for line in Path(f"/proc/{p.pid}/status").read_text().splitlines():
                                if line.startswith(("VmRSS:", "VmHWM:")):
                                    key, val, _unit = line.split()
                                    memory[key.rstrip(":")] = int(val) * 1024
                        except FileNotFoundError:
                            pass
                        files = {}
                        for f in root.rglob("*"):
                            try:
                                if f.is_file():
                                    files[str(f.relative_to(root))] = f.stat().st_size
                            except FileNotFoundError:
                                pass
                        samples.append(dict(seconds=round(time.monotonic() - start, 4), freeBytes=free, memoryBytes=memory, files=files))
                        if free < 256 * 1024**2:
                            os.killpg(p.pid, signal.SIGTERM)
                            terminated = True
                            break
                        time.sleep(0.025)
                    code = p.wait()
                markers = [json.loads(line.split("RECORD_RESOURCE ", 1)[1]) for line in log.read_text().splitlines() if "RECORD_RESOURCE " in line]
                completed_text = log.read_text()
                starts = [m for m in markers if m["phase"] == "process-start"]
                ends = [m for m in markers if m["phase"] == "process-end"]
                evidence_valid = (
                    len(starts) == len(ends) == 1
                    and starts[0]["extra"] == dict(phase=phase, shape=shape, bytes=mib * 1024**2, part=part, debugAssertions=True)
                    and ends[0]["extra"] == dict(phase=phase)
                    and "test result: ok. 1 passed; 0 failed; 0 ignored;" in completed_text
                    and bool(samples)
                )
                final_files = {str(f.relative_to(root)): f.stat().st_size for f in root.rglob("*") if f.is_file()}
                record = dict(evidenceValid=evidence_valid, finalFixtureFiles=final_files, case=case, phase=phase, command=command, binarySha256=binary_sha, exitCode=code, terminatedForDisk=terminated, elapsedSeconds=round(time.monotonic() - start, 4), minFreeBytes=min((s["freeBytes"] for s in samples), default=None), sampledMaxRssBytes=max((s["memoryBytes"].get("VmRSS",0) for s in samples), default=None), sampledMaxFixtureBytes=max((sum(s["files"].values()) for s in samples), default=None), markers=markers, samples=samples, samplingIntervalSeconds=0.025, peakCaveat="RSS is sampled, not an absolute peak; file lengths are non-atomic snapshots, not simultaneous allocated-disk peaks; marker VmHWM is lifetime of this phase's independent process", scope="Real Native store, debug profile; not IPC/Tauri/OS ENOSPC, exact lock timing, or proof of resource gate closure")
                (evidence / f"{case}-{phase}.json").write_text(json.dumps(record, indent=2) + "\n")
                records.append(record)
                print(json.dumps({k:v for k,v in record.items() if k not in ("samples", "markers", "command")}), flush=True)
                if code != 0 or not evidence_valid:
                    raise SystemExit(f"Failed {case}/{phase}; fixture retained at {root}")
            # Only this runner-created fixture is removed after all assertions and
            # all evidence have been durably closed. Never clean shared products.
            shutil.rmtree(root)
            (evidence / f"{case}-complete.json").write_text(json.dumps(dict(case=case, phases=[r["phase"] for r in records], binarySha256=binary_sha, fixtureRemoved=True), indent=2) + "\n")
