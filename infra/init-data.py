#!/usr/bin/env python3
"""仅创建固定目录；不读取数据、不递归 chmod/chown、不跟随路径中的符号链接。"""
import os
from pathlib import Path
import secrets
import socket
import stat
import sys

if sys.platform == 'linux':
    import fcntl


class InitError(Exception):
    pass


def open_directory(path):
    """逐级使用 O_NOFOLLOW 打开，拒绝任意祖先链接及路径穿越。"""
    path = os.path.abspath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def validate_directory(fd):
    info = os.fstat(fd)
    if info.st_uid != 1000 or info.st_gid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
        raise InitError('目录必须由运行用户 1000:1000 持有且权限为 0700；拒绝自动修改已有目录。')


def probe_filesystem(parent):
    """在自建空目录实测私有权限和 Chrome Singleton 链接/Unix socket。"""
    name = '.page-gather-probe-' + secrets.token_hex(12)
    os.mkdir(name, 0o700, dir_fd=parent)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    server = None
    try:
        server = socket.socket(socket.AF_UNIX)
        validate_directory(fd)
        file_fd = os.open('permission', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            os.fchmod(file_fd, 0o400)
            if stat.S_IMODE(os.fstat(file_fd).st_mode) != 0o400:
                raise InitError('文件系统不能可靠保存私有文件权限。')
            os.fchmod(file_fd, 0o600)
        finally:
            os.close(file_fd)
        target = f'/proc/self/fd/{fd}/socket'
        server.bind(target)
        os.symlink(target, 'SingletonSocket', dir_fd=fd)
        os.symlink('synthetic-host-123', 'SingletonLock', dir_fd=fd)
        os.symlink('synthetic-cookie', 'SingletonCookie', dir_fd=fd)
        if os.readlink('SingletonSocket', dir_fd=fd) != target:
            raise InitError('文件系统不能可靠保存 Chrome 符号链接。')
        server.listen(1)
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(f'/proc/self/fd/{fd}/SingletonSocket')
            connection, _ = server.accept()
            connection.close()
    finally:
        if server is not None:
            server.close()
        for entry in ['permission', 'SingletonSocket', 'SingletonLock', 'SingletonCookie', 'socket']:
            try:
                os.unlink(entry, dir_fd=fd)
            except FileNotFoundError:
                pass
        os.close(fd)
        os.rmdir(name, dir_fd=parent)


def initialize(deployment):
    if sys.platform != 'linux' or os.getuid() != 1000 or os.getgid() != 1000:
        raise InitError('请在 Linux/WSL 使用非 root 的 UID/GID 1000:1000 运行；与镜像 node 用户一致。')
    root = open_directory(deployment)
    try:
        # 权限与链接能力先验收，失败时不创建或修改 data。
        probe_filesystem(root)
        try:
            os.mkdir('data', 0o700, dir_fd=root)
        except FileExistsError:
            pass
        data = os.open('data', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            fcntl.flock(data, fcntl.LOCK_EX | fcntl.LOCK_NB)
            validate_directory(data)
            # 先校验全部已有目录，拒绝部分修复或跟随链接。
            for name in ['profiles', 'spool', 'artifacts']:
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data)
                except FileNotFoundError:
                    continue
                try:
                    validate_directory(child)
                finally:
                    os.close(child)
            probe_filesystem(data)
            for name in ['profiles', 'spool', 'artifacts']:
                try:
                    os.mkdir(name, 0o700, dir_fd=data)
                except FileExistsError:
                    pass
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data)
                try:
                    validate_directory(child)
                    probe_filesystem(child)
                finally:
                    os.close(child)
        finally:
            os.close(data)
    finally:
        os.close(root)


def main():
    try:
        if len(sys.argv) != 1:
            raise InitError('初始化不接受参数。')
        initialize(Path(__file__).absolute().parent.parent)
    except (OSError, InitError):
        # 不输出异常路径、内容或主机信息。
        print('初始化失败：要求无符号链接的目录边界、UID/GID 1000:1000、0700 目录及 Unix socket/Chrome 链接支持。'
              '已有目录不会自动改权。若 Windows/NTFS checkout 不满足条件，请将整个部署 checkout 移到 WSL ext4 后重试；不要外置 data 或 chmod 777。', file=sys.stderr)
        return 1
    print('初始化通过：./data/{profiles,spool,artifacts}，0700，运行用户 1000:1000；权限及 Chrome 链接/socket 能力已实测。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
