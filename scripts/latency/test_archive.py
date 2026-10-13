import hashlib
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

import archive


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'evidence.zip'
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as zip:
            zip.writestr('frame', bytes(range(256)) * 128)
        self.original = stream.getvalue()
        self.path.write_bytes(self.original)
        self.sha256 = hashlib.sha256(self.original).hexdigest()

    def test_valid_receipt_and_crc(self):
        result = archive.verify(self.path, len(self.original), self.sha256)
        self.assertTrue(result['controller_receipt_matched'])
        self.assertEqual(result['zip_entries'], 1)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_size_and_digest_mismatches_preserve_copy(self):
        for size, digest in [(len(self.original) - 1, self.sha256),
                             (len(self.original), '0' * 64)]:
            with self.assertRaises(ValueError):
                archive.verify(self.path, size, digest)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_zero_block_fails_even_when_whole_file_receipt_matches(self):
        corrupt = bytearray(self.original)
        corrupt[1610:4096] = bytes(4096 - 1610)
        self.path.write_bytes(corrupt)
        with self.assertRaises(zipfile.BadZipFile):
            archive.verify(self.path, len(corrupt), hashlib.sha256(corrupt).hexdigest())
        self.assertEqual(self.path.read_bytes(), corrupt)

    def test_empty_archive_rejected(self):
        with zipfile.ZipFile(self.path, 'w'):
            pass
        empty = self.path.read_bytes()
        with self.assertRaises(ValueError):
            archive.verify(self.path, len(empty), hashlib.sha256(empty).hexdigest())

    def test_receipt_argument_validation(self):
        import argparse
        with self.assertRaises(argparse.ArgumentTypeError):
            archive.sha256('bad')
        with self.assertRaises(argparse.ArgumentTypeError):
            archive.positive_bytes('0')
        self.assertEqual(archive.sha256('A' * 64), 'a' * 64)


if __name__ == '__main__':
    unittest.main()
