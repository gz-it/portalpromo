import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import pyzipper

spec = importlib.util.spec_from_file_location("unpacker", Path(__file__).resolve().parents[1] / "scripts/unpack-recovery-zip.py")
unpacker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unpacker)


class ExtractionTests(unittest.TestCase):
    def check_archive(self, extra=None, tamper=False, password="test-backup-password-123456789"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            entries = {"database.dump": b"PGDMP-test", "portal.env": b"SESSION_SECRET=test"}
            manifest = {"format": 1, "hashes": {name: hashlib.sha256(data).hexdigest() for name, data in entries.items()}}
            if tamper:
                entries["database.dump"] = b"changed"
            entries["manifest.json"] = json.dumps(manifest).encode()
            if extra:
                entries[extra] = b"outside"
            with pyzipper.AESZipFile(root / "backup.zip", "w", encryption=pyzipper.WZ_AES) as archive:
                archive.setpassword(b"test-backup-password-123456789")
                for name, data in entries.items():
                    archive.writestr(name, data)
            target = root / "extract"
            target.mkdir()
            unpacker.unpack(root / "backup.zip", target, password)
            self.assertEqual((target / "database.dump").read_bytes(), b"PGDMP-test")

    def test_valid_archive(self):
        self.check_archive()

    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            self.check_archive(extra="../escape")

    def test_extra_file_rejected(self):
        with self.assertRaises(ValueError):
            self.check_archive(extra="uploads/unlisted.txt")

    def test_modified_content_rejected(self):
        with self.assertRaises(ValueError):
            self.check_archive(tamper=True)

    def test_wrong_password_rejected(self):
        with self.assertRaises(RuntimeError):
            self.check_archive(password="wrong")
