#!/usr/bin/env python3
"""Build extension zip locally for manual install."""
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = REPO_ROOT / "extension-cloudflare"
RELEASE_DIR = REPO_ROOT / "release"


def main():
    # Read version from manifest
    manifest_path = EXT_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    version = manifest["version"]
    print(f"Building extension v{version}...")

    # Clean and create release dir
    RELEASE_DIR.mkdir(exist_ok=True)
    out_zip = RELEASE_DIR / f"gemini-bridge-v{version}.zip"

    # Remove old zip
    if out_zip.exists():
        out_zip.unlink()

    # Import zip utilities
    import zipfile

    # Build zip
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for filepath in EXT_DIR.rglob("*"):
            if not filepath.is_file():
                continue
            # Skip macOS junk and git files
            if "__MACOSX" in str(filepath) or ".DS_Store" in str(filepath):
                continue
            if ".git" in str(filepath):
                continue
            arcname = filepath.relative_to(EXT_DIR)
            zf.write(filepath, arcname)

    # Verify
    with zipfile.ZipFile(out_zip, "r") as zf:
        names = zf.namelist()
        has_manifest = any("manifest.json" in n for n in names)
        has_background = any("background.js" in n for n in names)
        has_content = any("content.js" in n for n in names)
        has_injected = any("injected.js" in n for n in names)

        if not all([has_manifest, has_background, has_content, has_injected]):
            print("❌ FAIL: Missing required files in zip")
            sys.exit(1)

        # Validate manifest
        m = json.loads(zf.read("manifest.json"))
        assert m["version"] == version, f"Version mismatch: {m['version']} != {version}"
        assert m["manifest_version"] == 3
        assert "background" in m
        assert "content_scripts" in m

    size_kb = out_zip.stat().st_size / 1024
    print(f"✅ Built: {out_zip}")
    print(f"   Size: {size_kb:.1f} KB")
    print(f"   Files: {len(names)}")
    print(f"\nLoad unpacked from: {EXT_DIR}")
    print(f"Or install from: {out_zip}")


if __name__ == "__main__":
    main()
