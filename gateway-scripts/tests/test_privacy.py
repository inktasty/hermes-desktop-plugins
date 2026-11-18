"""Synthetic privacy fixtures are assembled at runtime, never real credentials."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "verify" / "privacy.py"
SPEC = importlib.util.spec_from_file_location("privacy", SCRIPT)
privacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(privacy)


def fake_email():
    return "fictional.person" + "@" + "mail.invalid"


def fake_key():
    return "sk-" + "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv"


class PrivacyTests(unittest.TestCase):
    def test_email(self):
        self.assertEqual(privacy.categories(fake_email()), {"email"})

    def test_ip(self):
        ipv6 = ":".join(("2001", "4860", "4860", "", "8888"))
        for value in ("8." + "8.4.4", "8." + "8.4.4.", "10." + "2.3.4", ipv6,
                      ipv6 + ".", "::ffff:" + "8." + "8.4.4"):
            with self.subTest(value=value):
                self.assertEqual(privacy.categories(value), {"ip"})

    def test_home(self):
        for prefix in ("/home/", "/Users/", "C:/Users/", "C:\\Users\\", "C:\\\\Users\\\\"):
            with self.subTest(prefix=prefix):
                self.assertEqual(privacy.categories(prefix + "fake-person/docs"), {"home"})

    def test_api_keys(self):
        for value in (fake_key(), "ghp_" + "a" * 36, "gho_" + "b" * 36,
                      "github_pat_" + "c" * 40, "AKIA" + "Z" * 16,
                      "xoxb-" + "1" * 24, "xoxp-" + "2" * 24,
                      "Bearer " + "aB3_" * 9,
                      'api_key="' + "Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv" + '"'):
            with self.subTest(prefix=value[:5]):
                self.assertEqual(privacy.categories(value), {"api-key"})

    def test_allowed(self):
        for value in ("a" + "@example.com", "b" + "@example.org",
                      "noreply" + "@mail.invalid", "no-reply" + "@mail.invalid",
                      "127.0.0.1", "0.0.0.0", "::1", "::", "2001:db8::1234",
                      "192.0.2.7", "198.51.100.9", "203.0.113.4",
                      "/home/" + "USER", "/Users/" + "you", "C:\\Users\\" + "USER",
                      "$HOME/docs", "~/docs", "C:/Users/...", "key=" + "a" * 40,
                      "api_key=${ENV_SECRET}", "Bearer short", "999.999.999.999",
                      "", "ordinary text"):
            with self.subTest(value=value):
                self.assertEqual(privacy.categories(value), set())

    def test_allow_marker_is_scoped_and_requires_reason(self):
        self.assertEqual(privacy.categories(fake_email() + " # privacy: allow=email -- synthetic fixture"), set())
        self.assertEqual(privacy.categories(fake_email() + " # privacy: allow=email -- short"), {"email"})
        self.assertEqual(privacy.categories(fake_email() + " # privacy: allow=home -- synthetic fixture"), {"email"})

    def test_tracked_files_masking_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            def run():
                return subprocess.run([sys.executable, str(SCRIPT)], cwd=root,
                                      capture_output=True, text=True)
            self.assertEqual(run().returncode, 0)
            (root / "fixture.txt").write_text("\n".join((fake_email(), "8." + "8.4.4",
                                                        "/home/" + "fake-person/docs", fake_key())))
            self.assertEqual(run().returncode, 0)
            subprocess.run(["git", "add", "fixture.txt"], cwd=root, check=True)
            result = run()
            self.assertEqual(result.returncode, 1)
            for line, category in enumerate(("email", "ip", "home", "api-key"), 1):
                self.assertIn(f"'fixture.txt':{line}: {category}: [REDACTED]", result.stdout)
            self.assertNotIn(fake_email(), result.stdout + result.stderr)
            self.assertNotIn(fake_key(), result.stdout + result.stderr)
            (root / "fixture.txt").write_text("")
            (root / "binary.bin").write_bytes(b"\0" + fake_email().encode())
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.txt").write_text(fake_key())
            subprocess.run(["git", "add", "binary.bin", "node_modules"], cwd=root, check=True)
            self.assertEqual(run().returncode, 0)
            (root / "fixture.txt").unlink()
            result = run()
            self.assertEqual(result.returncode, 2)
            self.assertIn("unable to read tracked files", result.stderr)


if __name__ == "__main__":
    unittest.main()
