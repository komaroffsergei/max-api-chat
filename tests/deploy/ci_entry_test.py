"""Проверки ограниченного SSH-входа CI на временных файлах, без сервера и сети."""

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


@unittest.skipUnless(
    os.name == 'posix' and hasattr(os, 'O_NOFOLLOW'),
    'Для проверки нужны Linux/POSIX, fcntl и O_NOFOLLOW',
)
class CiEntryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Импортируем файл с дефисом в имени, не вызывая его main при импорте.
        script = Path(__file__).resolve().parents[2] / 'deploy' / 'ci-entry.py'
        spec = importlib.util.spec_from_file_location('ci_entry_under_test', script)
        cls.entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.entry)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='max-api-ci-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.fixture_root = Path(self.temporary.name)
        self.incoming = self.fixture_root / 'incoming'
        self.incoming.mkdir()
        incoming_patch = patch.object(self.entry, 'INCOMING', self.incoming)
        incoming_patch.start()
        self.addCleanup(incoming_patch.stop)
        # Ни один тест не может запустить Bash, Nginx, SSH или настоящий deploy.
        process_patch = patch.object(
            self.entry.subprocess,
            'run',
            return_value=subprocess.CompletedProcess(args=[], returncode=0),
        )
        self.process = process_patch.start()
        self.addCleanup(process_patch.stop)
        self.release_id = 'synthetic-release-01'
        self.payload = b'synthetic archive payload\n'
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.archive = self.incoming / f'{self.release_id}.tar.gz'

    def invoke(self, command, payload=b''):
        # Управляем forced command и stdin; реальные переменные SSH не читаем.
        self.input_stream = io.BytesIO(payload)
        output = io.StringIO()
        with (
            patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}),
            patch.object(self.entry.sys, 'stdin', SimpleNamespace(buffer=self.input_stream)),
            redirect_stdout(output),
        ):
            self.entry.main()
        return output.getvalue()

    def upload(self, payload=None, sha=None):
        return self.invoke(
            f'upload {self.release_id} {sha or self.sha}',
            self.payload if payload is None else payload,
        )

    def activate(self, sha=None):
        return self.invoke(f'activate {self.release_id} {sha or self.sha}')

    def test_invalid_commands_are_rejected_before_file_access_or_stdin(self):
        commands = [
            '',
            'whoami',
            f'upload ../escape {self.sha}',
            f'upload release_with_underscore {self.sha}',
            f'upload x {self.sha}',
            f'upload {"a" * 81} {self.sha}',
            f'activate {self.release_id} {self.sha.upper()}',
            f'upload {self.release_id} short-sha',
            f'upload {self.release_id} {self.sha} extra-argument',
            f'upload {self.release_id} {self.sha}; whoami',
        ]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(SystemExit):
                self.invoke(command, self.payload)
            self.assertEqual(self.input_stream.tell(), 0)
            self.assertEqual(list(self.incoming.iterdir()), [])
            self.process.assert_not_called()

    def test_mismatched_upload_sha_removes_every_temporary_file(self):
        with self.assertRaises(SystemExit):
            self.upload(sha='0' * 64)
        self.assertEqual(list(self.incoming.iterdir()), [])
        self.process.assert_not_called()

    def test_empty_upload_removes_every_temporary_file(self):
        with self.assertRaises(SystemExit):
            self.upload(payload=b'', sha=hashlib.sha256(b'').hexdigest())
        self.assertEqual(list(self.incoming.iterdir()), [])

    def test_oversized_upload_removes_every_temporary_file(self):
        # Уменьшаем предел только в тесте, чтобы не создавать 20 MiB ради границы.
        with patch.object(self.entry, 'MAX_ARCHIVE_BYTES', len(self.payload) - 1):
            with self.assertRaises(SystemExit):
                self.upload()
        self.assertEqual(list(self.incoming.iterdir()), [])

    def test_valid_upload_writes_exact_bytes_and_only_the_final_archive(self):
        output = self.upload()
        self.assertIn(f'UPLOAD_OK {self.release_id}', output)
        self.assertEqual(self.archive.read_bytes(), self.payload)
        self.assertEqual(sorted(path.name for path in self.incoming.iterdir()), [self.archive.name])
        self.process.assert_not_called()

    def test_repeated_identical_upload_succeeds_without_replacing_archive(self):
        self.upload()
        inode = self.archive.stat().st_ino
        output = self.upload()
        self.assertIn(f'UPLOAD_OK {self.release_id}', output)
        self.assertEqual(self.archive.read_bytes(), self.payload)
        self.assertEqual(self.archive.stat().st_ino, inode)
        self.assertEqual(sorted(path.name for path in self.incoming.iterdir()), [self.archive.name])
        self.process.assert_not_called()

    def test_existing_archive_with_another_checksum_is_not_overwritten(self):
        existing_payload = b'another synthetic archive\n'
        self.archive.write_bytes(existing_payload)
        with self.assertRaises((SystemExit, OSError)):
            self.upload()
        self.assertEqual(self.archive.read_bytes(), existing_payload)
        self.assertEqual(sorted(path.name for path in self.incoming.iterdir()), [self.archive.name])
        self.process.assert_not_called()

    def test_upload_cannot_accept_an_existing_symlink_even_with_matching_sha(self):
        target = self.fixture_root / 'symlink-target.tar.gz'
        target.write_bytes(self.payload)
        self.archive.symlink_to(target)
        with self.assertRaises((SystemExit, OSError)):
            self.upload()
        self.assertTrue(self.archive.is_symlink())
        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual(sorted(path.name for path in self.incoming.iterdir()), [self.archive.name])
        self.process.assert_not_called()

    def test_activate_rejects_a_symlink_before_starting_the_process(self):
        # Даже цель symlink находится внутри временного каталога этой фикстуры.
        target = self.fixture_root / 'symlink-target.tar.gz'
        target.write_bytes(self.payload)
        self.archive.symlink_to(target)
        with self.assertRaises((SystemExit, OSError)):
            self.activate()
        self.process.assert_not_called()
        self.assertTrue(self.archive.is_symlink())
        self.assertEqual(target.read_bytes(), self.payload)

    def test_activate_rejects_a_checksum_mismatch_and_keeps_the_archive(self):
        self.archive.write_bytes(self.payload)
        with self.assertRaises(SystemExit):
            self.activate(sha='0' * 64)
        self.process.assert_not_called()
        self.assertEqual(self.archive.read_bytes(), self.payload)

    def test_successful_activation_uses_exact_arguments_and_removes_the_archive(self):
        self.archive.write_bytes(self.payload)
        with self.assertRaises(SystemExit) as result:
            self.activate()
        self.assertEqual(result.exception.code, 0)
        self.process.assert_called_once_with(
            ['/bin/bash', self.entry.ACTIVATE, str(self.archive), self.sha, self.release_id],
            check=False,
        )
        self.assertFalse(self.archive.exists())

    def test_failed_activation_keeps_the_archive_for_an_explicit_retry(self):
        self.archive.write_bytes(self.payload)
        self.process.return_value = subprocess.CompletedProcess(args=[], returncode=7)
        with self.assertRaises(SystemExit) as result:
            self.activate()
        self.assertEqual(result.exception.code, 7)
        self.assertEqual(self.archive.read_bytes(), self.payload)
        self.process.assert_called_once()


if __name__ == '__main__':
    unittest.main()
