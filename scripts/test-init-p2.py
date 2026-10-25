#!/usr/bin/env python3
"""只用独立临时部署测试P2凭据初始化，不接触活动data。"""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 1000 and os.getgid() == 1000, '需要Linux运行用户1000:1000')
class P2InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='page-gather-p2-init-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'infra').mkdir(mode=0o700)
        for name in ['init-data.py', 'init-p2.py']:
            shutil.copyfile(ROOT / 'infra' / name, self.root / 'infra' / name)

    def run_init(self):
        return subprocess.run([sys.executable, str(self.root / 'infra/init-p2.py')], capture_output=True)

    def test_private_secrets_are_created_once(self):
        self.assertEqual(self.run_init().returncode, 0)
        before = {}
        for name in ['admin-password', 'worker-token']:
            file = self.root / 'data/config' / name
            before[name] = file.read_bytes()
            self.assertGreater(len(before[name]), 24)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertNotEqual(before['admin-password'], before['worker-token'])
        result = self.run_init()
        self.assertEqual(result.returncode, 0)
        for name, value in before.items():
            self.assertEqual((self.root / 'data/config' / name).read_bytes(), value)
            self.assertNotIn(value.strip(), result.stdout + result.stderr)

    def test_bad_permissions_do_not_rotate_existing_secrets(self):
        self.assertEqual(self.run_init().returncode, 0)
        file = self.root / 'data/config/admin-password'
        previous = file.read_bytes()
        file.chmod(0o644)
        self.assertNotEqual(self.run_init().returncode, 0)
        self.assertEqual(file.read_bytes(), previous)
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)

    def test_config_symlink_refused_without_outside_writes(self):
        self.assertEqual(self.run_init().returncode, 0)
        shutil.rmtree(self.root / 'data/config')
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        (self.root / 'data/config').symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.run_init().returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_secret_symlink_refused(self):
        self.assertEqual(self.run_init().returncode, 0)
        outside = self.root / 'outside-secret'
        outside.write_bytes(b'synthetic-marker')
        file = self.root / 'data/config/admin-password'
        file.unlink()
        file.symlink_to(outside)
        self.assertNotEqual(self.run_init().returncode, 0)
        self.assertEqual(outside.read_bytes(), b'synthetic-marker')


if __name__ == '__main__':
    unittest.main()
