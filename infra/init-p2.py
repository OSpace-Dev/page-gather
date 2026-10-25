#!/usr/bin/env python3
"""初始化部署内P2数据库与凭据文件，不输出凭据、不覆盖已有数据。"""
import importlib.util
import os
from pathlib import Path
import secrets
import stat
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('init_data', Path(__file__).absolute().parent / 'init-data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    root = Path(__file__).absolute().parent.parent
    try:
        if len(sys.argv) != 1:
            raise ValueError('NO_ARGUMENTS')
        module.initialize(root)
        data = module.open_directory(root / 'data')
        try:
            for name in ['database', 'config']:
                try:
                    os.mkdir(name, 0o700, dir_fd=data)
                except FileExistsError:
                    pass
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data)
                try:
                    module.validate_directory(fd)
                    if name == 'config':
                        for filename in ['admin-password', 'worker-token']:
                            try:
                                descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                            except FileExistsError:
                                info = os.stat(filename, dir_fd=fd, follow_symlinks=False)
                                if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000 or info.st_gid != 1000 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size < 24:
                                    raise ValueError('INVALID_EXISTING_SECRET')
                            else:
                                with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                                    output.write(secrets.token_urlsafe(32) + '\n')
                                    output.flush()
                                    os.fsync(output.fileno())
                finally:
                    os.close(fd)
        finally:
            os.close(data)
    except (OSError, ValueError, module.InitError):
        print('P2初始化失败：检查Linux用户1000:1000、部署目录边界及0700/0600权限；不会覆盖已有凭据。', file=sys.stderr)
        return 1
    print('P2初始化完成：data/database与data/config；保留原凭据，未输出密码或Token。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
