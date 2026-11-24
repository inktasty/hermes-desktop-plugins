#!/usr/bin/env python3
"""Round-trip tests for install.sh and uninstall.sh against a temporary HOME.

Run:  python3 -m unittest discover -s gateway-scripts/tests
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGIN_IDS = ("deepseek-rate", "opencode-usage", "session-usage", "context-runway")
GATEWAY_SCRIPTS = ("model_price_lookup.py", "opencode_go_usage.py", "opencode_go_models.py")


@unittest.skipUnless(shutil.which("bash"), "bash is required to run the install scripts")
class InstallRoundTripTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.plugins = self.home / ".hermes" / "desktop-plugins"
        self.scripts = self.home / ".hermes" / "scripts"

    def run_script(self, name):
        env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
        env["HOME"] = str(self.home)
        return subprocess.run(["bash", str(REPO / name)], env=env, check=True,
                              capture_output=True, text=True).stdout

    def test_uninstall_removes_everything_install_added(self):
        self.run_script("install.sh")
        for plugin_id in PLUGIN_IDS:
            self.assertTrue((self.plugins / plugin_id / "plugin.js").is_file())

        self.run_script("uninstall.sh")
        for plugin_id in PLUGIN_IDS:
            self.assertFalse((self.plugins / plugin_id).exists())
        for script in GATEWAY_SCRIPTS:
            self.assertFalse((self.scripts / script).exists())

    def test_uninstall_keeps_files_it_did_not_install(self):
        self.run_script("install.sh")
        note = self.plugins / "deepseek-rate" / "notes.txt"
        note.write_text("keep me\n")
        backup = self.plugins / "session-usage" / "backup" / "plugin.js.bak"
        backup.parent.mkdir()
        backup.write_text("keep me too\n")
        other_script = self.scripts / "my_script.py"
        other_script.write_text("print('mine')\n")

        out = self.run_script("uninstall.sh")

        self.assertEqual(note.read_text(), "keep me\n")
        self.assertEqual(backup.read_text(), "keep me too\n")
        self.assertTrue(other_script.is_file())
        for plugin_id in PLUGIN_IDS:
            self.assertFalse((self.plugins / plugin_id / "plugin.js").exists())
        self.assertFalse((self.plugins / "opencode-usage").exists())
        self.assertIn("kept    " + str(self.plugins / "deepseek-rate"), out)


if __name__ == "__main__":
    unittest.main()
