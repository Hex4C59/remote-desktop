#!/usr/bin/env python3
"""Check a recovered ZIP against the controller's displayed whole-file receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def verify(path, expected_bytes, expected_sha256):
    digest = hashlib.sha256()
    size = 0
    # Keep one open file for the receipt and CRC pass; never extract or alter evidence.
    with Path(path).open('rb') as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
        actual = digest.hexdigest()
        if size != expected_bytes or actual != expected_sha256.lower():
            raise ValueError('Recovered bytes/SHA-256 differ from the controller receipt; preserve this copy')
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if not entries or len({entry.filename for entry in entries}) != len(entries):
                raise ValueError('ZIP is empty or has duplicate entry names')
            for entry in entries:
                with archive.open(entry) as contents:
                    while contents.read(64 * 1024):
                        pass  # ZipExtFile validates each entry CRC when fully read.
    return {'schema': 'software-archive-receipt-check-v1', 'bytes': size,
            'sha256': actual, 'controller_receipt_matched': True,
            'zip_entries': len(entries), 'all_zip_crc': 'passed',
            'frame_content_validation': 'requires separate index and I420 validation'}


def sha256(text):
    if not re.fullmatch(r'[0-9a-fA-F]{64}', text):
        raise argparse.ArgumentTypeError('SHA-256 must contain 64 hexadecimal digits')
    return text.lower()


def positive_bytes(text):
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError('Receipt byte count must be positive')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--bytes', required=True, type=positive_bytes, dest='expected_bytes')
    parser.add_argument('--sha256', required=True, type=sha256, dest='expected_sha256')
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.expected_bytes, args.expected_sha256)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
        parser.exit(1, f'Archive rejected: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
