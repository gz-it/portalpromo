"""Extract a bounded, encrypted recovery ZIP. Password arrives only on stdin."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys

import pyzipper


def unpack(archive, destination, password):
    target = Path(destination).resolve()
    if not target.is_dir() or any(target.iterdir()):
        raise ValueError("El destino debe estar vacio")
    with pyzipper.AESZipFile(archive) as source:
        source.setpassword(password.encode())
        entries = source.infolist()
        if len(entries) > 50000 or sum(item.file_size for item in entries) > 4 * 1024**3:
            raise ValueError("El respaldo excede los limites de restauracion")
        if shutil.disk_usage(target).free < sum(item.file_size for item in entries) + 512 * 1024**2:
            raise ValueError("Espacio insuficiente para extraer el respaldo")
        seen = set()
        for entry in entries:
            name = entry.filename
            pure = PurePosixPath(name)
            if not name or "\\" in name or ":" in name or pure.is_absolute() or ".." in pure.parts or str(pure) in seen:
                raise ValueError("Ruta invalida en el respaldo")
            seen.add(str(pure))
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("No se admiten enlaces en el respaldo")
            if not (name in ("manifest.json", "database.dump", "portal.env") or name.startswith(("uploads/", "code/"))):
                raise ValueError("Contenido ajeno al formato de recuperacion")
            output = target.joinpath(*pure.parts)
            if entry.is_dir():
                output.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with source.open(entry) as reader, output.open("xb") as writer:
                os.chmod(output, 0o600)
                shutil.copyfileobj(reader, writer, 1024 * 1024)
        manifest = json.loads((target / "manifest.json").read_text())
        if manifest.get("format") != 1 or not isinstance(manifest.get("hashes"), dict):
            raise ValueError("Formato de recuperacion no compatible")
        files = {str(item.relative_to(target)).replace(os.sep, "/") for item in target.rglob("*") if item.is_file()}
        if files != set(manifest["hashes"]) | {"manifest.json"}:
            raise ValueError("El manifiesto no coincide con los archivos")
        for name, expected in manifest["hashes"].items():
            pure = PurePosixPath(name)
            if pure.is_absolute() or ".." in pure.parts or "\\" in name:
                raise ValueError("Ruta invalida en el manifiesto")
            with target.joinpath(*pure.parts).open("rb") as reader:
                if hashlib.file_digest(reader, "sha256").hexdigest() != expected:
                    raise ValueError("El archivo no supera la verificacion de integridad")
        if not {"database.dump", "portal.env"}.issubset(files):
            raise ValueError("Falta la base o configuracion de recuperacion")


if __name__ == "__main__":
    try:
        os.umask(0o077)
        request = json.loads(sys.stdin.read(8192))
        unpack(sys.argv[1], sys.argv[2], request["password"])
        print("VERIFIED")
    except Exception:
        print("Respaldo invalido, clave incorrecta o espacio insuficiente", file=sys.stderr)
        sys.exit(1)
