"""Verify AES ZIP contents without extracting private information or logging keys."""
import hashlib
import json
import pathlib
import sys

import pyzipper


def main():
    archive, key_file = map(pathlib.Path, sys.argv[1:3])
    password = key_file.read_bytes().strip()
    with pyzipper.AESZipFile(archive) as backup:
        backup.setpassword(password)
        if backup.testzip() is not None:
            raise ValueError("El ZIP no supera la verificacion")
        report = json.loads(backup.read("Verificacion.json"))
        assert report["restoredDatabaseVerified"] and report["restoredAppVerified"]
        names = backup.namelist()
        if report.get("format") == "consulta-v1":
            assert not any(name.endswith((".ppr", ".dump", ".env", ".key")) or name.startswith("code/") for name in names)
            recovery = archive.with_name(report["recoveryFilename"])
            with recovery.open("rb") as source:
                assert source.read(4) == b"PPR1"
                source.seek(0)
                assert hashlib.file_digest(source, "sha256").hexdigest() == report["recoverySha256"]
            assert report["snapshotAt"]
        else:
            assert backup.read("recuperacion-completa.ppr")[:4] == b"PPR1"
        assert "Datos/events.csv" in names
        assert "Datos/users.csv" in names
        assert not any("password_reset_tokens.csv" in name for name in names)
        documents = [name for name in names if name.startswith("Documentos/") and not name.endswith("/")]
        assert len(documents) == report["attachmentsVerified"]
    with pyzipper.AESZipFile(archive) as backup:
        backup.setpassword(b"wrong-password-test-only")
        try:
            backup.read("Verificacion.json")
        except RuntimeError:
            pass
        else:
            raise ValueError("El ZIP acepto una clave incorrecta")
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    print(json.dumps({"zipVerified": True, "wrongPasswordRejected": True, "documents": len(documents), "sha256": digest}))


if __name__ == "__main__":
    main()
