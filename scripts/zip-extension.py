#!/usr/bin/env python3
"""Build extension zip locally for manual install.

Packages dist/extension/ — the output of scripts/build-extension.py, with the
real secrets substituted — and NEVER extension-cloudflare/ (the committed
source, which still contains the __BRIDGE_AUTH_TOKEN__ / __CLIENT_API_TOKEN__
placeholders).

Packaging the source dir produces a zip that installs cleanly and then fails
every request with 401. CI has always caught this (the "unresolved
placeholders" step in ci.yml's package-extension job); this script now does
too, so the failure is local and obvious instead of only in CI.
"""
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = REPO_ROOT / "extension-cloudflare"
DIST_DIR = REPO_ROOT / "dist" / "extension"
RELEASE_DIR = REPO_ROOT / "release"

PLACEHOLDERS = (
    "__BRIDGE_AUTH_TOKEN__",
    "__CLIENT_API_TOKEN__",
    "__WORKER_URL__",
    "__MCP_ENDPOINT__",
    "__WSS_ENDPOINT__",
    "__OPENAI_ENDPOINT__",
)


def main():
    # Read version from the SOURCE manifest (the build step does not change it
    # unless --bump-version was passed).
    manifest_path = EXT_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    version = manifest["version"]

    # Refuse to package the source tree. It has placeholders by design.
    if not DIST_DIR.is_dir():
        print("❌ dist/extension/ not found.")
        print("   Run scripts/build-extension.py first — it substitutes the real")
        print("   tokens into the placeholders. Zipping extension-cloudflare/")
        print("   instead yields an extension that 401s on every request.")
        sys.exit(1)

    # Clean and create release dir
    RELEASE_DIR.mkdir(exist_ok=True)
    out_zip = RELEASE_DIR / f"gemini-bridge-v{version}.zip"

    # Remove old zip
    if out_zip.exists():
        out_zip.unlink()

    # Import zip utilities
    import zipfile

    # Build zip from the BUILT output.
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for filepath in DIST_DIR.rglob("*"):
            if not filepath.is_file():
                continue
            # Skip macOS junk and git files
            if "__MACOSX" in str(filepath) or ".DS_Store" in str(filepath):
                continue
            if ".git" in str(filepath):
                continue
            arcname = filepath.relative_to(DIST_DIR)
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

        # Hard gate: an unresolved placeholder means this zip installs but
        # cannot authenticate. Refuse to emit it, and never print the values.
        offenders = []
        for name in names:
            if not name.endswith((".js", ".html", ".json")):
                continue
            try:
                text = zf.read(name).decode("utf-8", errors="ignore")
            except Exception:
                continue
            for ph in PLACEHOLDERS:
                if ph in text:
                    offenders.append(f"{name}: {ph}")
        if offenders:
            print("=" * 68)
            print("❌ REFUSING TO PACKAGE — unresolved placeholders remain:")
            for o in offenders:
                print(f"     {o}")
            print("")
            print("   This zip would install but fail every request with 401.")
            print("   Re-run: python3 scripts/build-extension.py")
            print("=" * 68)
            sys.exit(1)

    size_kb = out_zip.stat().st_size / 1024
    print(f"✅ Built: {out_zip}")
    print(f"   Size: {size_kb:.1f} KB")
    print(f"   Files: {len(names)}")
    print("   Placeholders: none (secrets injected)")
    print(f"\nLoad unpacked from: {DIST_DIR}")
    print(f"Or install from: {out_zip}")
    print("\nDO NOT load unpacked from extension-cloudflare/ — it contains")
    print("placeholders, not secrets.")


if __name__ == "__main__":
    main()
