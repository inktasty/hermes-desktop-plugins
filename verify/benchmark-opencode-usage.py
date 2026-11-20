#!/usr/bin/env python3
"""Compare two gateway usage snapshots offline: python3 verify/benchmark-opencode-usage.py BASE_REF."""

import argparse
import base64
import gzip
import io
import json
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = "gateway-scripts/opencode_go_usage.py"
DELAY = 0.120
SAMPLES = 5


def load(source):
    namespace = {"__name__": "opencode_usage_benchmark"}
    exec(compile(source, SCRIPT, "exec"), namespace)
    return namespace


def measure(script, count):
    rows = [
        dict(index=i, label="Synthetic %d" % i, priority=i, source="manual",
             pool_status=None, key="test-%d" % i)
        for i in range(count)
    ]

    def urlopen(request, timeout):
        index = int(request.get_header("Authorization").rsplit("-", 1)[1])
        time.sleep(DELAY)
        if index == 1:
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
        return io.BytesIO(json.dumps({"usage": {"rolling": {"percent": index + 1}}}).encode())

    elapsed = []
    with patch.dict(script, collect_entries=lambda: rows, heartbeat=lambda _: None), \
         patch.object(urllib.request, "urlopen", new=urlopen):
        for _ in range(SAMPLES):
            output = io.StringIO()
            with redirect_stdout(output):
                start = time.perf_counter()
                script["main"]()
                elapsed.append(time.perf_counter() - start)
            payload = json.loads(output.getvalue())
            if "gzip" in payload:
                payload = json.loads(gzip.decompress(base64.b64decode(payload["gzip"])))
            del payload["fetched_at"]
            assert payload["ok"] and len(payload["keys"]) == count
    return statistics.median(elapsed) * 1000, payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_ref", help="Git ref for the baseline script")
    args = parser.parse_args()
    before = load(subprocess.check_output(["git", "show", args.base_ref + ":" + SCRIPT], cwd=ROOT))
    after = load((ROOT / SCRIPT).read_bytes())
    print("| Usable keys | Before (ms) | After (ms) | Speedup |")
    print("| ---: | ---: | ---: | ---: |")
    for count in (1, 3, 8):
        old_ms, old_payload = measure(before, count)
        new_ms, new_payload = measure(after, count)
        assert old_payload == new_payload, "output changed for %d keys" % count
        print("| %d | %.1f | %.1f | %.2fx |" % (count, old_ms, new_ms, old_ms / new_ms))
