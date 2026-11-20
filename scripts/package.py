#!/usr/bin/env python3
"""Build the Chrome Web Store upload zip.

    python3 scripts/package.py

Checks the manifest fields the store can't edit after upload, then writes
dist/mappedscroller-<version>.zip with manifest.json at the root of the zip.
Before each new upload, raise "version" in extension/manifest.json (e.g. 0.0.0.1 -> 0.0.0.2).
"""
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
DIST = ROOT / "dist"
SKIP = {".DS_Store", "Thumbs.db"}


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def check(manifest):
    problems = []
    for field in ("name", "version", "description", "icons"):
        if not manifest.get(field):
            problems.append(f'missing "{field}"')
    if len(manifest.get("name", "")) > 75:
        problems.append('"name" is longer than 75 characters')
    desc = manifest.get("description", "")
    if len(desc) > 132:
        problems.append(f'"description" is {len(desc)} characters (max 132)')
    version = manifest.get("version", "")
    if not re.fullmatch(r"\d+(\.\d+){0,3}", version) or any(int(p) > 65535 for p in version.split(".")):
        problems.append(f'"version" {version!r} must be 1-4 dot-separated integers (0-65535)')
    icons = manifest.get("icons", {})
    if "128" not in icons:
        problems.append('"icons" needs a 128x128 icon for the store')
    for size, rel in icons.items():
        p = EXT / rel
        if not p.exists():
            problems.append(f"icon {rel} not found")
        elif png_size(p) != (int(size), int(size)):
            problems.append(f"icon {rel} is {png_size(p)}, expected {size}x{size}")
    # Every file the manifest points at must exist.
    refs = [manifest.get("background", {}).get("service_worker"), manifest.get("action", {}).get("default_popup")]
    refs += list(manifest.get("action", {}).get("default_icon", {}).values())
    for rel in filter(None, refs):
        if not (EXT / rel).exists():
            problems.append(f"{rel} (referenced in manifest) not found")
    return problems


def main():
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    problems = check(manifest)
    if problems:
        print("Manifest problems:")
        for p in problems:
            print("  -", p)
        sys.exit(1)

    DIST.mkdir(exist_ok=True)
    out = DIST / f"mappedscroller-{manifest['version']}.zip"
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and p.name not in SKIP)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(EXT).as_posix())

    print(f"name:        {manifest['name']}")
    print(f"version:     {manifest['version']}")
    print(f"description: {manifest['description']} ({len(manifest['description'])}/132)")
    print(f"icons:       {', '.join(sorted(manifest['icons'], key=int))}")
    print(f"\nWrote {out.relative_to(ROOT)} ({len(files)} files, {out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
