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
from pathlib import Path

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
        # No exact match: the shortest prefix candidate wins (documented behavior).
        hit = self.price.entry_for(cache, "opencode-go", "deepseek-chat-v3-0324")
        self.assertEqual(hit["cost"]["input"], 2)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
