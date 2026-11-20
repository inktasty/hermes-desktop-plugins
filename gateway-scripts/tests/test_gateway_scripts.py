#!/usr/bin/env python3
"""Offline unit tests for the gateway scripts.

Stdlib unittest only: the scripts are documented as stdlib-only on any python3,
and this repo installs no pip dependencies. HERMES_HOME is pointed at a temp dir
before the modules import, so no real gateway home is ever read or written.

Run:  python3 -m unittest discover -s gateway-scripts/tests
  or: python3 gateway-scripts/tests/test_gateway_scripts.py
"""

import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from threading import Barrier, Event, Lock
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent.parent


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class GatewayScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = cls._tmp.name
        cls.home = Path(cls._tmp.name)
        # Import AFTER HERMES_HOME is set: each module resolves its cache paths
        # (HERMES_HOME/...) once at import.
        cls.models = _load("ocgm", "opencode_go_models.py")
        cls.usage = _load("ocgu", "opencode_go_usage.py")
        cls.price = _load("mpl", "model_price_lookup.py")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    # -- env_lookup ---------------------------------------------------------

    def test_price_main_strips_quoted_provider_argument(self):
        cache = {
            provider: {"models": {"synthetic-model": {"cost": {"input": rate, "output": rate}}}}
            for provider, rate in (("synthetic-alpha", 2), ("synthetic-beta", 5))
        }
        cache_path = self.home / "quoted_provider_cache.json"
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        original_cache, original_argv = self.price.CACHE, sys.argv
        try:
            self.price.CACHE = cache_path
            for quote in ("'", '"'):
                with self.subTest(quote=quote):
                    sys.argv = ["model_price_lookup.py", "synthetic-model", quote + "synthetic-beta" + quote]
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.price.main()
                    result = json.loads(output.getvalue())
                    self.assertTrue(result["ok"])
                    self.assertEqual(result["requested_provider"], "synthetic-beta")
                    self.assertEqual(result["provider"], "synthetic-beta")
                    self.assertEqual(result["input"], 5)
        finally:
            self.price.CACHE, sys.argv = original_cache, original_argv

    def test_env_lookup_handles_bom_quotes_export_and_comment(self):
        env = self.home / ".env"
        env.write_text(
            "\ufeffHDP_TEST_PRIMARY=abc\n"
            "HDP_TEST_QUOTED='a quoted value'\n"
            "export HDP_TEST_EXPORTED=exported\n"
            "HDP_TEST_COMMENT=val # trailing note\n",
            encoding="utf-8",
        )
        # The BOM must not hide the FIRST variable (str.strip() leaves U+FEFF).
        self.assertEqual(self.usage.env_lookup("HDP_TEST_PRIMARY"), "abc")
        self.assertEqual(self.usage.env_lookup("HDP_TEST_QUOTED"), "a quoted value")
        self.assertEqual(self.usage.env_lookup("HDP_TEST_EXPORTED"), "exported")
        self.assertEqual(self.usage.env_lookup("HDP_TEST_COMMENT"), "val")
        self.assertEqual(self.usage.env_lookup("HDP_TEST_ABSENT"), "")

    def test_env_value_reads_the_same_env(self):
        self.assertEqual(self.models.env_value("HDP_TEST_PRIMARY"), "abc")

    # -- parse_docs ---------------------------------------------------------

    def test_parse_docs_price_and_request_tables(self):
        markdown = (
            "| Model | Input | Output | Cached read | Cache write | Monthly cap |\n"
            "| --- | --- | --- | --- | --- | --- |\n"
            "| Foo (≤ 256K tokens) | **$0.15** | $0.60 | $0.003 | $0.30 | $60 |\n"
            "\n"
            "| Model | Requests per 5 hour | Weekly | Monthly |\n"
            "| --- | --- | --- | --- |\n"
            "| Foo | 1,000 | 2,000 | 3,000 |\n"
            "\n"
            "| Unrelated | Header |\n"
            "| --- | --- |\n"
            "| ignored | row |\n"
        )
        docs = self.models.parse_docs(markdown)
        self.assertIn("foo", docs)
        entry = docs["foo"]
        self.assertEqual(entry["name"], "Foo")
        self.assertEqual(entry["tiers"][0]["variant"], "≤ 256K tokens")
        self.assertEqual(entry["tiers"][0]["input"], 0.15)
        self.assertEqual(entry["monthly_usd"], 60)
        # Requests table merged onto the same key.
        self.assertEqual(entry["req_5h"], 1000)
        self.assertEqual(entry["req_week"], 2000)
        self.assertEqual(entry["req_month"], 3000)
        # The table with no recognised header is ignored entirely.
        self.assertNotIn("ignored", docs)

    # -- parse_privacy ------------------------------------------------------

    def test_parse_privacy_table_and_footnote(self):
        markdown = (
            "| Model | Model training | Data retention |\n"
            "| --- | --- | --- |\n"
            "| Bar | Yes* | 0 days |\n"
            "| Baz | No | 30 days |\n"
            "\n"
            "- **Bar**: training is required for this price.\n"
        )
        rows, notes = self.models.parse_privacy(markdown)
        self.assertEqual(rows["bar"]["training"], "used")
        self.assertTrue(rows["bar"]["zdr"])
        self.assertEqual(rows["baz"]["training"], "not_used")
        self.assertFalse(rows["baz"]["zdr"])
        self.assertIn("bar", notes)
        self.assertEqual(notes["bar"]["text"], "training is required for this price.")
        # A footnote links to the row whose key equals, or starts with, the note key.
        self.assertEqual(rows["bar"]["note_key"], "bar")
        self.assertIsNone(rows["baz"]["note_key"])

    def test_parse_privacy_empty(self):
        self.assertEqual(self.models.parse_privacy(""), ({}, {}))

    # -- bench_info ---------------------------------------------------------

    def test_bench_info_cooldown_expiry(self):
        now = dt.datetime(2026, 10, 11, 12, 0, tzinfo=dt.timezone.utc)
        future = (now + dt.timedelta(hours=2)).isoformat()
        past = (now - dt.timedelta(hours=2)).isoformat()
        benched_active = {"pool_status": "exhausted", "last_error_reset_at": future}
        benched_expired = {"pool_status": "exhausted", "last_error_reset_at": past}
        healthy = {"pool_status": None, "failure_reason": None}
        self.assertEqual(self.usage.bench_info(benched_active, now), (True, dt.datetime.fromisoformat(future)))
        self.assertEqual(self.usage.bench_info(benched_expired, now), (False, dt.datetime.fromisoformat(past)))
        self.assertEqual(self.usage.bench_info(healthy, now), (False, None))
        # A reason alone (no status) also benches.
        self.assertEqual(self.usage.bench_info({"failure_reason": "quota"}, now), (True, None))

    # -- window_start -------------------------------------------------------

    def test_window_start_month_edge_and_simple_windows(self):
        resets = dt.datetime(2026, 3, 31, 6, 0, tzinfo=dt.timezone.utc)
        # Mar 31 -> Feb is invalid (no Feb 31), so it falls back to resets - 30d.
        self.assertEqual(
            self.usage.window_start(resets, "monthly"),
            resets - dt.timedelta(days=30),
        )
        self.assertEqual(self.usage.window_start(resets, "rolling"), resets - dt.timedelta(hours=5))
        self.assertEqual(self.usage.window_start(resets, "weekly"), resets - dt.timedelta(days=7))

    def test_window_start_month_normal(self):
        resets = dt.datetime(2026, 4, 15, 0, 0, tzinfo=dt.timezone.utc)
        self.assertEqual(self.usage.window_start(resets, "monthly"), dt.datetime(2026, 3, 15, tzinfo=dt.timezone.utc))

    # -- entry_for / rates_of ----------------------------------------------

    def test_entry_for_exact_and_prefix_ambiguity(self):
        cache = {
            "opencode-go": {
                "models": {
                    "gpt-4o": {"cost": {"input": 1}},
                    "deepseek-chat": {"cost": {"input": 2}},
                    "deepseek-chat-v3": {"cost": {"input": 3}},
                }
            }
        }
        self.assertEqual(self.price.entry_for(cache, "opencode-go", "gpt-4o")["cost"]["input"], 1)
        # No exact match: the most specific card wins.
        hit = self.price.entry_for(cache, "opencode-go", "deepseek-chat-v3-0324")
        self.assertEqual(hit["cost"]["input"], 3)
        self.assertEqual(self.price.entry_for(cache, "opencode-go", "DEEPSEEK-CHAT-V3")["cost"]["input"], 3)
        boundary_cache = {"opencode-go": {"models": {"gpt-4": {"cost": {"input": 4}}}}}
        self.assertIsNone(self.price.entry_for(boundary_cache, "opencode-go", "gpt-4o-mini"))
        # A reverse prefix ('gpt' < 'gpt-4o') also matches the served snapshot.
        self.assertEqual(self.price.entry_for(cache, "opencode-go", "gpt")["cost"]["input"], 1)
        self.assertIsNone(self.price.entry_for(cache, "opencode-go", "nope"))
        self.assertIsNone(self.price.entry_for(cache, "missing-provider", "gpt-4o"))

    def test_rates_of_aliases(self):
        hit = {"cost": {"input_tokens": 1.5, "output": 2.5, "input_cache_read": 0.1}}
        rates = self.price.rates_of(hit)
        self.assertEqual(rates["input"], 1.5)
        self.assertEqual(rates["output"], 2.5)
        self.assertEqual(rates["cache_read"], 0.1)

    # -- gateway_key benched ranking ---------------------------------------

    def test_gateway_key_prefers_unbenched_then_env(self):
        auth = self.home / "auth.json"
        auth.write_text(json.dumps({
            "credential_pool": {
                "opencode-go": [
                    {"access_token": "benchA", "priority": 0, "last_status": "exhausted"},
                    {"access_token": "liveB", "priority": 1, "last_status": "ok"},
                ]
            }
        }), encoding="utf-8")
        self.assertEqual(self.models.gateway_key(), "liveB")
        # All benched: the highest-priority row still leads the fallback chain.
        auth.write_text(json.dumps({
            "credential_pool": {
                "opencode-go": [
                    {"access_token": "benchA", "priority": 0, "last_status": "exhausted"},
                    {"access_token": "benchC", "priority": 1, "last_status": "invalid"},
                ]
            }
        }), encoding="utf-8")
        self.assertEqual(self.models.gateway_key(), "benchA")

    def test_gateway_key_falls_back_to_env(self):
        (self.home / "auth.json").unlink(missing_ok=True)
        env = self.home / ".env"
        env.write_text("OPENCODE_GO_API_KEY=env-key\n", encoding="utf-8")
        self.assertEqual(self.models.gateway_key(), "env-key")

    def test_usage_probes_overlap_and_preserve_pool_order(self):
        rows = [
            dict(index=i, label="Synthetic %d" % i, priority=i, source="manual",
                 pool_status="exhausted" if i == 0 else None, key="test-%d" % i if i != 2 else "")
            for i in range(6)
        ]
        first_wave = Barrier(3)
        later_request = Event()
        lock = Lock()
        requests = []
        in_flight = peak = 0

        def urlopen(request, timeout):
            nonlocal in_flight, peak
            auth = request.get_header("Authorization")
            index = int(auth.rsplit("-", 1)[1])
            with lock:
                requests.append((auth, request.full_url, timeout))
                in_flight += 1
                peak = max(peak, in_flight)
            try:
                if index in (0, 1, 3):
                    first_wave.wait(timeout=3)
                if index == 0 and not later_request.wait(timeout=3):
                    raise TimeoutError("never scheduled a later request")
                if index == 1:
                    raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
                if index == 3:
                    raise TimeoutError("synthetic slow request")
                if index == 5:
                    later_request.set()
                return io.BytesIO(json.dumps({"usage": {"rolling": {"percent": index + 1}}}).encode())
            finally:
                with lock:
                    in_flight -= 1

        output = io.StringIO()
        with patch.object(self.usage, "collect_entries", return_value=rows), \
             patch.object(self.usage, "heartbeat"), \
             patch.object(self.usage.urllib.request, "urlopen", side_effect=urlopen), \
             contextlib.redirect_stdout(output):
            self.assertEqual(self.usage.main(), 0)

        self.assertEqual(peak, 3)
        indexes = [0, 1, 3, 4, 5]
        self.assertCountEqual(requests, [
            ("Bearer test-%d" % i, self.usage.USAGE_URL, self.usage.TIMEOUT) for i in indexes
        ])
        result = json.loads(output.getvalue())
        self.assertTrue(result["ok"])
        self.assertEqual([row["index"] for row in result["skipped_keys"]], [2])
        keys = result["keys"]
        self.assertEqual([key["index"] for key in keys], indexes)
        self.assertEqual([key["ordinal"] for key in keys], [1, 2, 3, 4, 5])
        self.assertTrue(keys[0]["benched"])
        self.assertEqual([key["index"] for key in keys if key["active"]], [1])
        self.assertEqual((keys[1]["ok"], keys[1]["error"], keys[1]["status"]),
                         (False, "API key rejected", 401))
        self.assertEqual((keys[2]["ok"], keys[2]["error"]), (False, "TimeoutError: synthetic slow request"))
        self.assertEqual([key["ok"] for key in keys], [True, False, False, True, True])
        self.assertEqual(result["windows"], keys[0]["windows"])

    # -- spool round-trip (atomic write) -----------------------------------

    def test_spool_write_and_read_parts(self):
        text = "x" * (self.models.SPOOL_PART_CHARS * 2 + 10)
        descriptor = self.models.write_spool(text)
        # The name is a hash of the payload's own bytes, so two runs in one window
        # cannot splice each other's slices; the descriptor carries it back to the
        # reader instead of the reader guessing a fixed filename.
        self.assertEqual(descriptor["parts"], 3)
        spool = self.home / "cache" / ("opencode_go_models." + descriptor["id"] + ".spool")
        self.assertTrue(spool.exists())
        self.assertFalse(spool.with_name(spool.name + ".tmp").exists())
        joined = ""
        for i in range(descriptor["parts"]):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = self.models.print_part(i, descriptor["id"])
            self.assertEqual(rc, 0)
            joined += buf.getvalue()
        self.assertEqual(joined, text)
        # A slice request that does not name this run's spool is refused, not served.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.models.print_part(0, "0" * 16)
        self.assertEqual(rc, 1)
        self.assertIn("no spooled payload", buf.getvalue())

    # -- announcement expiry ----------------------------------------------

    def test_announcement_expiry(self):
        models = self.models
        today = dt.date.today()
        # The gate reads the real clock, so assert the RULE against each entry's own
        # end date rather than a fixed day: a dated announcement in the past must not
        # render, and one without an end date never lapses.
        for item in models.ANNOUNCEMENTS:
            ends = item.get("ends")
            got = models.announcement_for(item["match"])
            if ends and dt.date.fromisoformat(str(ends)) < today:
                self.assertIsNone(got, "%s lapsed on %s and must not render" % (item["match"], ends))
            else:
                self.assertIsNotNone(got, "%s carries no passed end date and must render" % item["match"])
        self.assertIsNotNone(models.announcement_for("omen-alpha"))
        self.assertIsNone(models.announcement_for("does-not-exist"))


    # -- models endpoint ----------------------------------------------------

    # One synthetic item in the shape https://opencode.ai/inference/go/v1/models
    # documents: models.dev v2 fields plus the Go-only `go` object.
    ENDPOINT_ITEM = {
        "id": "foo-1.5",
        "name": "Foo 1.5",
        "release_date": "2026-05-01",
        "limit": {"context": 1000000, "output": 64000},
        "cost": {
            "text": {
                "input": {"price": 0.4, "cache": {"read": 0.04, "write": {"30m": 0.5, "12h": 1}},
                          "overrides": [{"when": {"context": {"gt": 256000}}, "price": 1.2, "cache": {"read": 0.12}}]},
                "output": {"price": 1.6, "overrides": [{"when": {"context": {"gt": 256000}}, "price": 4.8}]},
            },
            "multipliers": [{"when": {"utc_days": {"in": ["mon", "fri"]},
                                      "any": [{"all": [{"utc_hours": {"gte": "01:00"}}, {"utc_hours": {"lt": "04:00"}}]}]},
                             "factor": 2}],
        },
        "go": {"monthly_usage": {"go": 60, "go-plus": 180, "go-teams": 65},
               "training": False, "zdr": True, "limited_regions": False},
    }

    def test_endpoint_entry_reads_prices_caps_and_privacy(self):
        entry = self.models.endpoint_entry(self.ENDPOINT_ITEM)
        self.assertEqual((entry["input"], entry["output"], entry["cache_read"]), (0.4, 1.6, 0.04))
        # A cache-write price keyed by TTL takes the first (shortest) one listed.
        self.assertEqual(entry["cache_write"], 0.5)
        self.assertEqual(entry["context"], 1000000)
        self.assertEqual(entry["released"], "2026-05-01")
        self.assertEqual(entry["monthly_usage"], {"go": 60, "go-plus": 180, "go-teams": 65})
        self.assertIs(entry["zdr"], True)
        self.assertIs(entry["training"], False)
        labels = [tier["label"] for tier in entry["tiers"]]
        self.assertEqual(labels, ["> 256K tokens", "peak hours (2x)"])
        self.assertEqual(entry["tiers"][0]["input"], 1.2)
        self.assertEqual(entry["tiers"][0]["output"], 4.8)
        self.assertEqual(entry["tiers"][1]["input"], 0.8)
        self.assertEqual(entry["tiers"][1]["output"], 3.2)

    def test_endpoint_entry_free_model_has_no_cap(self):
        entry = self.models.endpoint_entry({
            "id": "free-x", "name": "Free X",
            "cost": {"text": {"input": {"price": 0, "cache": {"read": 0}}, "output": {"price": 0}}},
            "go": {"monthly_usage": None, "training": True, "zdr": False},
        })
        self.assertEqual((entry["input"], entry["output"]), (0.0, 0.0))
        self.assertIsNone(entry["monthly_usage"])
        self.assertEqual(entry["tiers"], [])

    def test_build_model_prefers_endpoint_over_catalog(self):
        endpoint = {"foo-1.5": self.models.endpoint_entry(self.ENDPOINT_ITEM)}
        catalog = {"foo-1.5": {"name": "Foo", "input": 9.0, "output": 9.0, "cache_read": 9.0, "context": 1}}
        privacy = {"foo-1-5": {"training": None, "retention": "0 days", "zdr": True, "note_key": "foo"}}
        record = self.models.build_model("foo-1.5", {}, catalog, privacy, {}, {}, endpoint)
        self.assertEqual((record["input"], record["output"], record["cache_read"]), (0.4, 1.6, 0.04))
        self.assertEqual(record["price_source"], "api")
        self.assertEqual(record["monthly_usd"], 60)
        self.assertEqual(record["monthly_by_plan"], {"go": 60, "go-plus": 180, "go-teams": 65})
        self.assertEqual(record["cap_source"], "api")
        self.assertEqual(record["price_check"], "differs")
        self.assertEqual(record["released"], "2026-05-01")
        self.assertEqual(record["privacy"], {"training": "not_used", "retention": "0 days", "zdr": True, "note_key": "foo"})
        self.assertEqual([t["label"] for t in record["tiers"]], ["> 256K tokens", "peak hours (2x)"])

    def test_build_model_privacy_from_endpoint_alone(self):
        item = dict(self.ENDPOINT_ITEM, id="bar", name="Bar", go={"monthly_usage": None, "training": True, "zdr": False})
        record = self.models.build_model("bar", {}, {}, {}, {}, {}, {"bar": self.models.endpoint_entry(item)})
        self.assertEqual(record["privacy"], {"training": "used", "retention": "Not ZDR", "zdr": False, "note_key": None})
        self.assertIsNone(record["monthly_usd"])

    def test_announced_cap_never_overrides_a_published_one(self):
        item = dict(self.ENDPOINT_ITEM, id="omen-alpha", name="Omen Alpha")
        record = self.models.build_model("omen-alpha", {}, {}, {}, {}, {}, {"omen-alpha": self.models.endpoint_entry(item)})
        self.assertEqual(record["monthly_usd"], 60)
        self.assertEqual(record["cap_source"], "api")

    def test_api_models_reads_the_public_list_without_a_key(self):
        payload = json.dumps({"object": "list", "data": [self.ENDPOINT_ITEM]}).encode()
        seen = []

        def fake_get(url, headers=None, timeout=None):
            seen.append((url, dict(headers or {})))
            return payload, None

        original_get, original_key = self.models.http_get, self.models.gateway_key
        self.models.http_get, self.models.gateway_key = fake_get, lambda: ""
        try:
            entries, base, error, authed = self.models.api_models()
        finally:
            self.models.http_get, self.models.gateway_key = original_get, original_key
        self.assertIsNone(error)
        self.assertFalse(authed)
        self.assertEqual(list(entries), ["foo-1.5"])
        self.assertEqual(seen[0][0], self.models.DEFAULT_GO_BASE + "/models")
        self.assertNotIn("Authorization", seen[0][1])

    def test_parse_privacy_retention_only_table(self):
        markdown = (
            "| Model | Data retention |\n"
            "| --- | --- |\n"
            "| Bar 2 | 30 days |\n"
            "| Baz | 0 days\\* |\n"
        )
        rows, _ = self.models.parse_privacy(markdown)
        self.assertEqual(rows["bar-2"]["retention"], "30 days")
        self.assertFalse(rows["bar-2"]["zdr"])
        self.assertIsNone(rows["bar-2"]["training"])
        self.assertTrue(rows["baz"]["zdr"])

    def test_plan_info_reads_the_usage_limit_sentences(self):
        markdown = (
            "| **Go** | **$10/month** | x |\n\n"
            "- The **5-hour limit** is 20% of your monthly allowance. The window starts later.\n"
            "- The **weekly limit** is 50% of your monthly allowance. It resets on Monday.\n"
        )
        plan = self.models.plan_info(markdown)
        self.assertEqual(plan["price_usd_month"], 10)
        self.assertEqual(plan["five_hour_share"], 0.2)
        self.assertEqual(plan["weekly_share"], 0.5)

    def test_endpoint_entry_applies_a_scheduled_change_once_it_starts(self):
        item = dict(self.ENDPOINT_ITEM, cost=dict(self.ENDPOINT_ITEM["cost"], multipliers=[
            {"when": {"date": {"gte": "2026-12-01"}}, "factor": 2},
        ]))
        before = self.models.endpoint_entry(item, today=dt.date(2026, 11, 30))
        self.assertEqual((before["input"], before["output"]), (0.4, 1.6))
        self.assertEqual([t["label"] for t in before["tiers"]], ["> 256K tokens", "from 2026-12-01 (2x)"])
        after = self.models.endpoint_entry(item, today=dt.date(2026, 12, 1))
        self.assertEqual((after["input"], after["output"], after["cache_read"]), (0.8, 3.2, 0.08))
        self.assertEqual([t["label"] for t in after["tiers"]], ["> 256K tokens"])
        self.assertEqual((after["tiers"][0]["input"], after["tiers"][0]["output"]), (2.4, 9.6))

    def test_id_only_model_list_keeps_catalog_prices(self):
        endpoint = {"foo-1.5": self.models.endpoint_entry({"id": "foo-1.5"})}
        catalog = {"foo-1.5": {"name": "Foo", "input": 0.5, "output": 2.0, "cache_read": 0.05, "context": 1}}
        record = self.models.build_model("foo-1.5", {}, catalog, {}, {}, {}, endpoint)
        self.assertEqual((record["input"], record["output"], record["cache_read"]), (0.5, 2.0, 0.05))
        self.assertEqual(record["price_source"], "catalog")
        self.assertIsNone(record["monthly_usd"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
