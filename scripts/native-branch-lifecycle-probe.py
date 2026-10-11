#!/usr/bin/env python3
"""Run the opt-in Native crash/reopen and pinned-reader WAL lifecycle probe.

Supply an already-built, ordinary debug test binary from this checkout. Four
serial cases each use a private mkdtemp fixture and fresh processes. Only owned
Popen handles can be signalled. Failed fixtures and all evidence are retained.
25 ms samples are observations, not proofs of instantaneous resource peaks.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


MIB = 1024 * 1024
START_FREE = 512 * MIB
MIN_FREE = 384 * MIB
FIXTURE_LIMIT = 128 * MIB
LOG_LIMIT = 16 * MIB
INTERVAL = 0.025
TEST = "arena_story::branch::storage::tests::resource_probes::real_store_branch_lifecycle_probe"
CASES = ("copy-chapter", "before-commit", "after-commit", "wal")
FROZEN_FILES = ("frozen-manifest.json", "frozen-parts.json", "frozen-receipt.json",
                "frozen-digest.json", "frozen-instance.json")
CAVEAT = (
    "25 ms RSS and logical file-length samples are not absolute peaks; file "
    "inventories are non-atomic. VmHWM belongs to one independent process. "
    "This is a debug Native-store probe, not IPC/Tauri, OS ENOSPC, or precise lock timing."
)

# This is a separate process and connection. BEGIN alone does not pin a read
# snapshot: the actual source SELECT must succeed before reader-ready is sent.
READER = r'''
import json, os, sqlite3, sys
from pathlib import Path

def mark(phase, **extra):
    print("LIFECYCLE " + json.dumps(dict(phase=phase, pid=os.getpid(),
        nonce=os.environ["MAHO_LIFECYCLE_NONCE"], case=os.environ["MAHO_LIFECYCLE_CASE"],
        extra=extra)), flush=True)

def expect(command):
    value = sys.stdin.readline()
    if value != command + "\n":
        raise RuntimeError("expected " + repr(command) + ", got " + repr(value))

path = Path(sys.argv[1]).resolve(strict=True)
connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
connection.execute("PRAGMA query_only=ON")
connection.execute("BEGIN")
sources = connection.execute("SELECT count(*) FROM arena_story_session WHERE id='source'").fetchone()[0]
if sources != 1:
    raise RuntimeError("expected exactly one source, got " + str(sources))
mark("reader-ready", database=str(path), sourceCount=sources)
expect("check")
targets = connection.execute("SELECT count(*) FROM arena_story_session WHERE id<>'source'").fetchone()[0]
if targets != 0:
    raise RuntimeError("pinned reader unexpectedly saw targets: " + str(targets))
mark("reader-checked", targetCount=targets)
expect("release")
connection.rollback()
connection.close()
mark("reader-released")
'''


class ProbeError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ProbeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


class Evidence:
    """Bound the combined stdout, event, marker and sample logs, not just a line."""

    def __init__(self, directory, budget=None):
        self.directory = directory
        self.budget = {"bytes": 0} if budget is None else budget
        self.bytes = 0
        self.streams = {}

    def write(self, name, data):
        if name not in self.streams:
            self.streams[name] = (self.directory / name).open("xb")
        remaining = LOG_LIMIT - self.budget["bytes"]
        if len(data) > remaining:
            self.streams[name].write(data[:max(0, remaining)])
            self.streams[name].flush()
            self.bytes += max(0, remaining)
            self.budget["bytes"] += max(0, remaining)
            raise ProbeError("combined stdout/event/sample logs reached 16 MiB")
        self.streams[name].write(data)
        self.streams[name].flush()
        self.bytes += len(data)
        self.budget["bytes"] += len(data)

    def event(self, name, value):
        self.write(name, (json.dumps(value, separators=(",", ":")) + "\n").encode())

    def sync(self):
        for stream in self.streams.values():
            stream.flush()
            os.fsync(stream.fileno())

    def close(self):
        for stream in self.streams.values():
            stream.close()


class OwnedProcess:
    def __init__(self, command, phase, env, evidence, journal):
        self.command = command
        self.phase = phase
        self.nonce = env["MAHO_LIFECYCLE_NONCE"]
        self.case = env["MAHO_LIFECYCLE_CASE"]
        self.started = time.monotonic()
        self.ended = None
        self.markers = []
        self.pending = b""
        self.output_closed = False
        self.test_ok = False
        self.signals = []
        self.evidence = evidence
        self.journal = journal
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=env, start_new_session=True,
        )
        try:
            os.set_blocking(self.process.stdout.fileno(), False)
        except BaseException:
            self.process.kill()
            self.process.wait()
            self.process.stdin.close()
            self.process.stdout.close()
            raise
        self.journal.append(dict(event="spawn", phase=phase, pid=self.process.pid,
                                 command=command, nonce=self.nonce, case=self.case))

    def read(self):
        try:
            data = os.read(self.process.stdout.fileno(), 65536)
        except BlockingIOError:
            return
        if not data:
            self.output_closed = True
            require(not self.pending or b"LIFECYCLE " not in self.pending,
                    f"{self.phase}: unterminated lifecycle marker")
            self.pending = b""
            return
        self.evidence.write(self.phase + ".log", data)
        self.pending += data
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            if b"test result: ok. 1 passed; 0 failed; 0 ignored;" in line:
                self.test_ok = True
            if b"LIFECYCLE " not in line:
                continue
            payload = line.split(b"LIFECYCLE ", 1)[1]
            try:
                marker = json.loads(payload)
            except (ValueError, UnicodeDecodeError) as error:
                raise ProbeError(f"{self.phase}: invalid marker: {error}") from error
            require(isinstance(marker, dict), f"{self.phase}: marker must be an object")
            require(marker.get("pid") == self.process.pid and type(marker.get("pid")) is int
                    and marker.get("nonce") == self.nonce and marker.get("case") == self.case,
                    f"{self.phase}: marker PID/nonce/case mismatch")
            require(isinstance(marker.get("phase"), str) and isinstance(marker.get("extra"), dict),
                    f"{self.phase}: malformed marker phase/extra")
            self.markers.append(marker)
            self.evidence.event("markers.jsonl", dict(processPhase=self.phase, marker=marker))

    def marker(self, phase):
        matches = [marker for marker in self.markers if marker["phase"] == phase]
        require(len(matches) <= 1, f"{self.phase}: duplicate {phase} marker")
        return matches[0] if matches else None

    def send(self, value):
        require(self.process.poll() is None, f"{self.phase}: exited before stdin {value}")
        event = dict(event="stdin", phase=self.phase, pid=self.process.pid, value=value)
        self.journal.append(event)
        self.evidence.event("events.jsonl", event)
        self.process.stdin.write((value + "\n").encode())
        self.process.stdin.flush()

    def kill(self, reason):
        if self.process.poll() is not None:
            return False
        event = dict(event="signal", phase=self.phase, pid=self.process.pid,
                     nonce=self.nonce, case=self.case, signal="SIGKILL", reason=reason)
        self.signals.append(event)
        self.journal.append(event)
        # Log-limit failures still retain the signal in the final summary.
        try:
            self.evidence.event("events.jsonl", event)
            self.evidence.sync()
        except (ProbeError, OSError):
            pass
        self.process.kill()  # Owned Popen only; never PID scanning or killpg.
        return True

    def summary(self):
        return dict(phase=self.phase, pid=self.process.pid, nonce=self.nonce,
                    command=self.command, exitCode=self.process.poll(), signals=self.signals,
                    stdout=self.phase + ".log", markers=self.markers,
                    elapsedSeconds=round((self.ended or time.monotonic()) - self.started, 4))

    def close(self):
        self.process.stdin.close()
        self.process.stdout.close()


class Case:
    def __init__(self, name, root, directory, binary, binary_sha, timeout, log_budget=None):
        self.name = name
        self.root = root
        self.directory = directory
        self.nonce = uuid.uuid4().hex
        self.binary = binary
        self.binary_sha = binary_sha
        self.timeout = timeout
        self.evidence = Evidence(directory, log_budget)
        self.selector = selectors.DefaultSelector()
        self.processes = []
        self.journal = []
        self.started = time.monotonic()
        self.last_sample = 0
        self.sample_count = 0
        self.sampled_max_fixture = 0
        self.sampled_max_wal = 0
        self.sampled_max_rss = {}
        self.min_free = None
        self.frozen = {}

    def start(self, phase, database=None):
        env = dict(os.environ, MAHO_LIFECYCLE_ROOT=str(self.root),
                   MAHO_LIFECYCLE_PHASE=phase, MAHO_LIFECYCLE_CASE=self.name,
                   MAHO_LIFECYCLE_NONCE=self.nonce, TMPDIR=str(self.root))
        if database is None:
            command = [str(self.binary), "--exact", TEST, "--ignored", "--nocapture", "--test-threads=1"]
        else:
            command = [sys.executable, "-u", "-c", READER, str(database)]
        process = OwnedProcess(command, phase, env, self.evidence, self.journal)
        self.processes.append(process)
        self.evidence.event("events.jsonl", self.journal[-1])
        self.selector.register(process.process.stdout, selectors.EVENT_READ, process)
        return process

    def sample(self, force=False):
        now = time.monotonic()
        if not force and now - self.last_sample < INTERVAL:
            return
        self.last_sample = now
        free = shutil.disk_usage(self.root).free
        files = {}
        for path in self.root.rglob("*"):
            try:
                require(not path.is_symlink(), f"unexpected fixture symlink: {path}")
                if path.is_file():
                    files[str(path.relative_to(self.root))] = path.stat().st_size
            except FileNotFoundError:
                pass
        memories = {}
        for owned in self.processes:
            if owned.process.poll() is not None:
                continue
            values = {}
            try:
                for line in Path(f"/proc/{owned.process.pid}/status").read_text().splitlines():
                    if line.startswith(("VmRSS:", "VmHWM:")):
                        key, value, _unit = line.split()
                        values[key.rstrip(":")] = int(value) * 1024
            except (FileNotFoundError, ProcessLookupError):
                pass
            memories[str(owned.process.pid)] = values
            self.sampled_max_rss[owned.phase] = max(
                self.sampled_max_rss.get(owned.phase, 0), values.get("VmRSS", 0))
        fixture_bytes = sum(files.values())
        wal_bytes = max((size for name, size in files.items() if name.endswith("-wal")), default=0)
        self.sample_count += 1
        self.min_free = free if self.min_free is None else min(free, self.min_free)
        self.sampled_max_fixture = max(self.sampled_max_fixture, fixture_bytes)
        self.sampled_max_wal = max(self.sampled_max_wal, wal_bytes)
        self.evidence.event("samples.jsonl", dict(seconds=round(now - self.started, 6),
                            freeBytes=free, fixtureBytes=fixture_bytes, files=files, memoryBytes=memories))
        require(free >= MIN_FREE, "free space fell below 384 MiB")
        require(fixture_bytes < FIXTURE_LIMIT, "aggregate fixture reached 128 MiB")

    def pump(self):
        self.sample()
        for key, _mask in self.selector.select(INTERVAL):
            owned = key.data
            owned.read()
            if owned.output_closed:
                self.selector.unregister(key.fileobj)
        self.sample()
        for owned in self.processes:
            if owned.process.poll() is None:
                require(time.monotonic() - owned.started < self.timeout,
                        f"{owned.phase}: exceeded {self.timeout:g} second process timeout")

    def wait_marker(self, owned, phase):
        while True:
            self.pump()
            marker = owned.marker(phase)
            if marker is not None:
                require(owned.process.poll() is None, f"{owned.phase}: exited at {phase} handshake")
                return marker
            require(not owned.output_closed, f"{owned.phase}: exited without {phase}")

    def finish(self, owned, expected=0, rust=True):
        while owned.process.poll() is None or not owned.output_closed:
            self.pump()
        code = owned.process.wait()
        owned.ended = time.monotonic()
        event = dict(event="exit", phase=owned.phase, pid=owned.process.pid, code=code)
        self.journal.append(event)
        self.evidence.event("events.jsonl", event)
        require(code == expected, f"{owned.phase}: exit {code}, expected {expected}")
        if rust:
            start = owned.marker("process-start")
            require(start is not None and start["extra"].get("phase") == owned.phase,
                    f"{owned.phase}: missing/mismatched process-start")
            require(start["extra"].get("debugAssertions") is True,
                    f"{owned.phase}: ordinary debug assertions required")
            if expected == 0:
                end = owned.marker("process-end")
                require(end is not None and end["extra"] == {"phase": owned.phase} and owned.test_ok,
                        f"{owned.phase}: missing successful test result/process-end")
            else:
                require(owned.marker("process-end") is None and not owned.test_ok,
                        f"{owned.phase}: crash writer unexpectedly completed normally")
        expected_markers = {
            "fixture": ["process-start", "process-end"],
            "crash-writer": ["process-start", "crash-ready"],
            "reopen": ["process-start", "reopen-verified", "process-end"],
            "wal-writer": ["process-start", "writer-ready", "wal-commit", "wal-commit",
                           "wal-commit", "commits-ready", "wal-truncated", "process-end"],
            "wal-reader": ["reader-ready", "reader-checked", "reader-released"],
            "wal-reopen": ["process-start", "wal-reopen-verified", "process-end"],
        }
        require([marker["phase"] for marker in owned.markers] == expected_markers[owned.phase],
                f"{owned.phase}: unexpected lifecycle marker sequence")
        self.evidence.sync()

    def normal(self, phase):
        owned = self.start(phase)
        self.finish(owned)
        return owned

    def freeze(self, names, label):
        target = self.directory / "source-freeze"
        target.mkdir(exist_ok=True)
        for name in names:
            source = self.root / name
            require(source.is_file() and not source.is_symlink(), f"missing frozen source artifact: {name}")
            destination = target / name
            with source.open("rb") as reader, destination.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=MIB)
                writer.flush()
                os.fsync(writer.fileno())
            digest = sha256(source)
            require(digest == sha256(destination), f"source evidence copy mismatch: {name}")
            self.frozen[name] = dict(sha256=digest, bytes=source.stat().st_size,
                                     copy=str(destination.relative_to(self.directory)))
        save_json(self.directory / ("source-freeze-" + label + ".json"), self.frozen)
        self.evidence.sync()

    def verify_freeze(self):
        for name, details in self.frozen.items():
            require(sha256(self.root / name) == details["sha256"], f"frozen source artifact changed: {name}")

    def run(self):
        self.sample(force=True)
        self.normal("fixture")
        self.freeze(("source-fingerprint.json",), "fixture")
        if self.name != "wal":
            writer = self.start("crash-writer")
            ready = self.wait_marker(writer, "crash-ready")
            require(ready["extra"].get("step") == self.name, "wrong crash-ready step")
            self.freeze(FROZEN_FILES, "crash-ready")
            self.verify_freeze()
            self.evidence.sync()
            require(writer.kill("verified crash-ready " + self.name), "crash writer already exited")
            self.finish(writer, expected=-signal.SIGKILL)
            self.normal("reopen")
        else:
            self.wal()
        self.verify_freeze()
        self.sample(force=True)

    def wal(self):
        writer = self.start("wal-writer")
        ready = self.wait_marker(writer, "writer-ready")
        database_text = ready["extra"].get("database")
        require(isinstance(database_text, str), "missing writer-ready database")
        database = Path(database_text)
        require(database.is_absolute() and database.resolve() == self.root / "library.sqlite"
                and database.is_file() and not database.is_symlink(), "unexpected WAL database path")
        reader = self.start("wal-reader", database)
        reader_ready = self.wait_marker(reader, "reader-ready")
        require(reader_ready["extra"] == dict(database=str(database), sourceCount=1),
                "reader did not pin the expected source snapshot")
        writer.send("reader-ready")
        self.wait_marker(writer, "commits-ready")
        commits = [marker for marker in writer.markers if marker["phase"] == "wal-commit"]
        require(len(commits) == 3, "expected exactly three bounded WAL commits")
        targets = [marker["extra"].get("target") for marker in commits]
        require(targets == ["target1", "target2", "target3"], "unexpected WAL target sequence")
        self.freeze(tuple(f"{target}-{part}.json" for target in targets
                          for part in ("manifest", "receipt")), "commits-ready")
        checkpoints = [marker["extra"].get("checkpoint") for marker in commits]
        require(all(isinstance(row, list) and len(row) == 3
                    and all(type(value) is int and value >= 0 for value in row)
                    for row in checkpoints), "malformed WAL checkpoint evidence")
        require(any(row[1] > row[2] for row in checkpoints), "no reader-held WAL checkpoint backlog observed")
        reader.send("check")
        checked = self.wait_marker(reader, "reader-checked")
        require(checked["extra"] == {"targetCount": 0}, "reader snapshot saw a new target")
        reader.send("release")
        # The reader is allowed to exit immediately after releasing its snapshot.
        self.finish(reader, rust=False)
        require(reader.marker("reader-released") is not None, "reader never released its connection")
        writer.send("reader-released")
        self.finish(writer)
        truncated = writer.marker("wal-truncated")
        require(truncated is not None and truncated["extra"].get("checkpoint") == [0, 0, 0],
                "TRUNCATE did not report [0,0,0] after reader exit")
        self.normal("wal-reopen")

    def cleanup_owned_processes(self):
        for owned in self.processes:
            try:
                owned.kill("runner failure cleanup")
            except OSError as error:
                self.journal.append(dict(event="cleanup-signal-failure", pid=owned.process.pid,
                                         error=str(error)))
        for owned in self.processes:
            # SIGKILL cannot be handled; wait is bounded to avoid hiding a stuck OS.
            try:
                owned.process.wait(timeout=10)
                if owned.ended is None:
                    owned.ended = time.monotonic()
            except subprocess.TimeoutExpired:
                self.journal.append(dict(event="cleanup-wait-timeout", pid=owned.process.pid))
            try:
                deadline = time.monotonic() + 1
                while not owned.output_closed and time.monotonic() < deadline:
                    owned.read()
                    if owned.process.poll() is None:
                        time.sleep(INTERVAL)
            except (ProbeError, OSError):
                pass

    def summary(self, error=None):
        return dict(case=self.name, nonce=self.nonce, root=str(self.root), binarySha256=self.binary_sha,
                    evidenceValid=error is None, failure=error, fixtureRemoved=False,
                    processes=[owned.summary() for owned in self.processes], events=self.journal,
                    sourceFreeze=self.frozen, samples="samples.jsonl", sampleCount=self.sample_count,
                    samplingIntervalSeconds=INTERVAL, minFreeBytes=self.min_free,
                    sampledMaxFixtureBytes=self.sampled_max_fixture,
                    sampledMaxWalBytes=self.sampled_max_wal, sampledMaxRssBytes=self.sampled_max_rss,
                    logBytes=self.evidence.bytes, runLogBytes=self.evidence.budget["bytes"],
                    elapsedSeconds=round(time.monotonic() - self.started, 4), caveat=CAVEAT)

    def close(self):
        self.selector.close()
        for owned in self.processes:
            owned.close()
        self.evidence.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=180,
                        help="timeout for each owned process, including handshake waits (default: 180)")
    args = parser.parse_args()
    require(os.name == "posix", "this SIGKILL lifecycle runner requires POSIX")
    require(0 < args.timeout_seconds <= 1800, "process timeout must be in (0,1800] seconds")
    binary = args.binary.resolve(strict=True)
    require(binary.is_file() and os.access(binary, os.X_OK), "--binary must be an executable file")
    evidence = args.evidence.resolve()
    os.umask(0o077)
    evidence.mkdir(parents=True, exist_ok=True)
    require(not any(evidence.iterdir()), "use an empty evidence directory; previous evidence is preserved")
    require(shutil.disk_usage(evidence).free >= START_FREE, "start requires at least 512 MiB free")
    binary_sha = sha256(binary)
    save_json(evidence / "run.json", dict(binary=str(binary), binarySha256=binary_sha, test=TEST,
              cases=CASES, python=sys.version, sampleIntervalSeconds=INTERVAL, caveat=CAVEAT,
              guards=dict(startFreeBytes=START_FREE, minFreeBytes=MIN_FREE,
                          aggregateFixtureBytes=FIXTURE_LIMIT, logBytes=LOG_LIMIT)))
    fixture_parent = evidence / "fixtures"
    fixture_parent.mkdir()
    completed = []
    log_budget = {"bytes": 0}
    for name in CASES:
        require(shutil.disk_usage(evidence).free >= START_FREE, f"{name}: start requires 512 MiB free")
        require(sha256(binary) == binary_sha, "test binary changed during this run")
        directory = evidence / name
        directory.mkdir()
        root = Path(tempfile.mkdtemp(prefix=name + "-", dir=fixture_parent)).resolve()
        case = Case(name, root, directory, binary, binary_sha, args.timeout_seconds, log_budget)
        error = None
        try:
            case.run()
        except BaseException as failure:
            error = f"{type(failure).__name__}: {failure}"
            case.cleanup_owned_processes()
        try:
            result = case.summary(error)
            save_json(directory / "result.json", result)
        finally:
            case.close()
        if error is not None:
            raise ProbeError(f"{name} failed: {error}; fixture retained at {root}")
        # Remove only this runner's unique private root, after evidence is closed.
        shutil.rmtree(root)
        save_json(directory / "complete.json", dict(case=name, binarySha256=binary_sha,
                  fixtureRemoved=True, sourceFreezePreserved=True))
        completed.append(name)
        print(json.dumps(dict(case=name, evidenceValid=True, fixtureRemoved=True,
                              evidence=str(directory))), flush=True)
    save_json(evidence / "complete.json", dict(cases=completed, binarySha256=binary_sha,
              evidenceValid=True, fixtureRootsRemoved=True, caveat=CAVEAT))


if __name__ == "__main__":
    try:
        main()
    except (ProbeError, OSError) as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
