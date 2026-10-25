#!/usr/bin/env python3
"""只在独立临时部署测试初始化边界；不访问预览数据。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import stat
import subprocess
import tempfile
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('init_data', ROOT / 'infra/init-data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='page-gather-init-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def initialize(self):
        module.initialize(self.root)

    def test_private_idempotent_and_preserves_files(self):
        self.initialize()
        marker = self.root / 'data/profiles/synthetic'
        marker.write_bytes(b'synthetic-only')
        marker.chmod(0o600)
        self.initialize()
        self.assertEqual(marker.read_bytes(), b'synthetic-only')
        for name in ['', 'profiles', 'spool', 'artifacts']:
            info = (self.root / 'data' / name).stat()
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (1000, 1000, 0o700))
        self.assertEqual(sorted(p.name for p in (self.root / 'data').iterdir()), ['artifacts', 'profiles', 'spool'])

    def test_symlink_boundaries(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        for position in ['root', 'data', 'child']:
            with self.subTest(position=position):
                deployment = self.root / position
                deployment.mkdir(mode=0o700)
                if position == 'root':
                    link = self.root / 'linked-root'
                    link.symlink_to(deployment, target_is_directory=True)
                    target = link
                elif position == 'data':
                    (deployment / 'data').symlink_to(outside, target_is_directory=True)
                    target = deployment
                else:
                    (deployment / 'data').mkdir(mode=0o700)
                    (deployment / 'data/profiles').symlink_to(outside, target_is_directory=True)
                    target = deployment
                with self.assertRaises((OSError, module.InitError)):
                    module.initialize(target)
                self.assertEqual(list(outside.iterdir()), [])
                if position == 'child':
                    self.assertFalse((deployment / 'data/spool').exists())

    def test_bad_mode_rejected_without_repair(self):
        self.initialize()
        child = self.root / 'data/artifacts'
        child.chmod(0o755)
        with self.assertRaises(module.InitError):
            self.initialize()
        self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o755)

    def test_file_boundary_rejected(self):
        (self.root / 'data').write_bytes(b'synthetic')
        with self.assertRaises(OSError):
            self.initialize()
        self.assertEqual((self.root / 'data').read_bytes(), b'synthetic')

    def test_lock_refuses_concurrent_initializer(self):
        import fcntl
        self.initialize()
        fd = os.open(self.root / 'data', os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(OSError):
                self.initialize()
        finally:
            os.close(fd)

    def test_non_node_user_rejected_without_creating_data(self):
        with mock.patch.object(module.os, 'getuid', return_value=0):
            with self.assertRaises(module.InitError):
                self.initialize()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_socket_failure_cleans_probe_and_creates_no_data(self):
        with mock.patch.object(module.socket, 'socket', side_effect=OSError('synthetic unsupported socket')):
            with self.assertRaises(OSError):
                self.initialize()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_wrong_owner_rejected_without_repair(self):
        self.initialize()
        info = mock.Mock(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o700)
        with mock.patch.object(module.os, 'fstat', return_value=info):
            with self.assertRaises(module.InitError):
                self.initialize()
        self.assertEqual((self.root / 'data').stat().st_uid, 1000)
        self.assertFalse(any(p.name.startswith('.page-gather-probe-') for p in self.root.iterdir()))

    def test_no_arguments_and_deployment_relative(self):
        for directory in ['scripts', 'infra']:
            (self.root / directory).mkdir()
        for name in ['scripts/init-data.sh', 'infra/init-data.py']:
            shutil.copyfile(ROOT / name, self.root / name)
        command = ['bash', str(self.root / 'scripts/init-data.sh')]
        result = subprocess.run(command + ['external-data'], cwd='/', capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'data').exists())
        result = subprocess.run(command, cwd='/', capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertTrue((self.root / 'data/profiles').is_dir())

    def test_backup_git_and_build_exclusions(self):
        shutil.copyfile(ROOT / '.gitignore', self.root / '.gitignore')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)
        names = ['backups/page-gather-data.tar.gz', 'page-gather-data.tar.gz',
                 'nested/synthetic.tgz', '.deployment-source.json', 'data/profiles/synthetic']
        for name in names:
            result = subprocess.run(['git', '-C', str(self.root), 'check-ignore', '-q', name])
            self.assertEqual(result.returncode, 0, name)
        patterns = (ROOT / '.dockerignore').read_text(encoding='utf-8').splitlines()
        for pattern in ['backups', '**/backups', '*.tar.gz', '**/*.tar.gz', '.deployment-source.json', 'data']:
            self.assertIn(pattern, patterns)

    def test_integration_copy_omits_backup_and_private_markers(self):
        files = ['backups/synthetic.txt', 'synthetic.tar.gz', 'nested/synthetic.zip',
                 '.deployment-source.json', 'data/profiles/synthetic', 'keep.txt']
        for name in files:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic-only')
        source = (ROOT / 'scripts/verify-p1-container.sh').read_text(encoding='utf-8')
        command = source[source.index('tar --exclude='):].split('|', 1)[0].replace('\\\n', ' ')
        result = subprocess.run(shlex.split(command), cwd=self.root, capture_output=True, check=True)
        listing = subprocess.run(['tar', '-tf', '-'], input=result.stdout, capture_output=True, check=True).stdout.decode()
        self.assertIn('./keep.txt', listing)
        for name in files[:-1]:
            self.assertNotIn(name, listing)

    def test_compose_mount_contract(self):
        env = {**os.environ, 'CHROME_VERSION': '1.2.3.4-1'}
        result = subprocess.run(['docker', 'compose', '-f', str(ROOT / 'compose.yaml'), 'config', '--format', 'json'],
                                env=env, capture_output=True, check=True)
        config = json.loads(result.stdout)
        self.assertFalse(config.get('volumes'))
        mounts = config['services']['browser-worker']['volumes']
        self.assertEqual(len(mounts), 3)
        self.assertEqual((ROOT / 'compose.yaml').read_text(encoding='utf-8').count('create_host_path: false'), 3)
        for mount, name in zip(mounts, ['profiles', 'spool', 'artifacts']):
            self.assertEqual(mount['type'], 'bind')
            self.assertEqual(mount['source'], str(ROOT / 'data' / name))
            self.assertEqual(mount['target'], '/data/' + name)
            # Compose 规范化会省略值为 false 的 create_host_path。
            self.assertIs(mount['bind'].get('create_host_path', False), False)


if __name__ == '__main__':
    unittest.main()
