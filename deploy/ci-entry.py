#!/usr/bin/env python3
"""Ограниченный вход CI: принять сборку и выпустить только этот статический сайт.

Файл устанавливается оператором в /usr/local/libexec/max-api-ci с владельцем root.
В authorized_keys стоит restrict и forced command. Обычные shell-команды недоступны.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

INCOMING = Path('/srv/portfolio/max-api/incoming')
ACTIVATE = '/usr/local/libexec/max-api-activate-release'
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024


def main():
    # Никакого eval/shell: аргументы сверяем до доступа к файлам и запуску процесса.
    parts = os.environ.get('SSH_ORIGINAL_COMMAND', '').split()
    if (len(parts) != 3 or parts[0] not in {'upload', 'activate'} or
            not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]{1,79}', parts[1]) or
            not re.fullmatch(r'[a-f0-9]{64}', parts[2])):
        raise SystemExit('Допустимы только upload/activate VERSION SHA256')
    action, release_id, expected_sha = parts
    archive = INCOMING / f'{release_id}.tar.gz'

    if action == 'upload':
        # Временный файл закрыт от других пользователей. Лишние байты не принимаем.
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=INCOMING, delete=False) as stream:
                temp_path = Path(stream.name)
                digest = hashlib.sha256()
                size = 0
                while chunk := sys.stdin.buffer.read(65536):
                    size += len(chunk)
                    if size > MAX_ARCHIVE_BYTES:
                        raise SystemExit('Архив превышает 20 MiB')
                    stream.write(chunk)
                    digest.update(chunk)
            if not size or digest.hexdigest() != expected_sha:
                raise SystemExit('SHA-256 загруженного архива не совпал')
            # link не перезапишет чужой файл или symlink с таким же именем.
            try:
                os.link(temp_path, archive)
            except FileExistsError:
                # SSH мог оборваться после успешной загрузки. Тот же архив повторить можно.
                fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as existing:
                    if hashlib.file_digest(existing, 'sha256').hexdigest() != expected_sha:
                        raise SystemExit('Версия уже занята другим архивом')
            print(f'UPLOAD_OK {release_id}')
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        return

    # Одновременно переключать current может только один выпуск.
    with open(INCOMING / 'activate.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected_sha:
                raise SystemExit('SHA-256 сохранённого архива не совпал')
        result = subprocess.run(['/bin/bash', ACTIVATE, str(archive), expected_sha, release_id], check=False)
        if result.returncode == 0:
            archive.unlink()
        raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
