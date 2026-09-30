#!/usr/bin/env python3
"""
build-extension.py — Build extension with secrets injected at build time.

Replaces placeholders in source files with secrets from Doppler:
  __BRIDGE_AUTH_TOKEN__  -> from Doppler BRIDGE_AUTH_TOKEN
  __CLIENT_API_KEY__   -> from Doppler CLIENT_API_KEY
  __WORKER_URL__         -> from Doppler WORKER_URL (optional)
  __MCP_ENDPOINT__       -> from Doppler MCP_ENDPOINT (optional)
  __WSS_ENDPOINT__       -> from Doppler WSS_ENDPOINT (optional)
  __OPENAI_ENDPOINT__    -> from Doppler OPENAI_ENDPOINT (optional)

Version management:
  --bump-version {patch,minor,major}  Auto-increment version from manifest
  --set-version VERSION               Force specific version (e.g. 4.3.9)

Usage:
  python3 build-extension.py
  python3 build-extension.py --output dist/
  python3 build-extension.py --clean
  python3 build-extension.py --bump-version patch
  python3 build-extension.py --set-version 4.3.9
"""

import os
import re
import sys
import shutil
import argparse
import subprocess
import json
import datetime
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "extension-cloudflare"

# ONE build root. Everything the build produces lives under dist/ so there is
# never a second copy to fall out of date:
#
#   dist/extension/            unpacked build — "Load unpacked" points here
#   dist/extension/BUILD.json  stamp: version, commit, build time
#   dist/extension-<v>.zip     packaged release + .md5
#
# The old repo-root release/ directory is gone; RELEASE_DIR is kept only so
# existing callers raise a clear error instead of silently writing elsewhere.
#
# The paths themselves come from extension.config.json so there is one
# definition shared with scripts/zip-extension.py, stored relative to the
# repo root so no developer home directory ends up in a log or a doc.
_EXTENSION_CFG = json.loads((REPO_ROOT / "extension.config.json").read_text())["extension"]
DIST_DIR = REPO_ROOT / _EXTENSION_CFG["unpacked"].rsplit("/", 1)[0]
DEFAULT_OUT_DIR = REPO_ROOT / _EXTENSION_CFG["unpacked"]
MANIFEST_PATH = SRC_DIR / "manifest.json"
RELEASE_DIR = DIST_DIR

STAMP_NAME = "BUILD.json"

PLACEHOLDER_PATTERNS = {
    "__BRIDGE_AUTH_TOKEN__": "BRIDGE_AUTH_TOKEN",
    "__CLIENT_API_KEY__": "CLIENT_API_KEY",
    "__WORKER_URL__": "WORKER_URL",
    "__MCP_ENDPOINT__": "MCP_ENDPOINT",
    "__WSS_ENDPOINT__": "WSS_ENDPOINT",
    "__OPENAI_ENDPOINT__": "OPENAI_ENDPOINT",
}

DOPPLER_PROJECT = "gemini-web-bridge"
DOPPLER_CONFIG = "prd_worker"

# Default fallback values for optional URL placeholders
DEFAULT_VALUES = {
    "WORKER_URL": "https://prod.gemini-web-bridge.workers.dev",
    "MCP_ENDPOINT": "https://prod.gemini-web-bridge.workers.dev/mcp",
    "WSS_ENDPOINT": "wss://prod.gemini-web-bridge.workers.dev/bridge",
    "OPENAI_ENDPOINT": "https://prod.gemini-web-bridge.workers.dev/v1",
}


def get_doppler_secret(key: str) -> str:
    """Fetch secret from Doppler, fallback to env var.
    
    Uses DOPPLER_SERVICE_TOKEN if set, otherwise relies on Doppler CLI auth.
    """
    try:
        # Set DOPPLER_SERVICE_TOKEN if available (for CI/CD automation)
        env = os.environ.copy()
        if os.environ.get("DOPPLER_SERVICE_TOKEN"):
            env["DOPPLER_TOKEN"] = os.environ["DOPPLER_SERVICE_TOKEN"]
        
        result = subprocess.run(
            ["doppler", "secrets", "get", key, "--project", DOPPLER_PROJECT,
             "--config", DOPPLER_CONFIG, "--plain"],
            capture_output=True, text=True, timeout=10,
            env=env
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


def upsert_doppler_secrets(secrets: dict, dry_run: bool = False) -> bool:
    """Upsert multiple secrets to Doppler.
    
    Args:
        secrets: dict of {secret_name: value} to upsert
        dry_run: if True, only print what would be done
    
    Returns:
        True if all upserts succeeded, False otherwise
    """
    if not os.environ.get("DOPPLER_SERVICE_TOKEN"):
        print("WARNING: DOPPLER_SERVICE_TOKEN not set — skipping Doppler upsert")
        return False
    
    env = os.environ.copy()
    env["DOPPLER_TOKEN"] = os.environ["DOPPLER_SERVICE_TOKEN"]
    
    all_success = True
    for key, value in secrets.items():
        if dry_run:
            print(f"  [DRY-RUN] Would upsert: {key}")
            continue
        
        try:
            result = subprocess.run(
                ["doppler", "secrets", "set", key, "--project", DOPPLER_PROJECT,
                 "--config", DOPPLER_CONFIG, "--plain"],
                input=value,
                capture_output=True, text=True, timeout=10,
                env=env
            )
            if result.returncode == 0:
                print(f"  ✅ Upserted: {key}")
            else:
                print(f"  ❌ Failed to upsert {key}: {result.stderr.strip()}")
                all_success = False
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            print(f"  ❌ Error upserting {key}: {e}")
            all_success = False
    
    return all_success


def resolve_placeholder(placeholder: str, env_var: str) -> str:
    """Resolve placeholder: Doppler -> env -> default -> error."""
    # Try Doppler first
    val = get_doppler_secret(env_var)
    if val:
        return val
    # Fallback to environment variable
    val = os.environ.get(env_var, "")
    if val:
        return val
    # Optional URL placeholders have hardcoded defaults
    if env_var in DEFAULT_VALUES:
        print(f"  Note: {env_var} not in Doppler/env, using default value")
        return DEFAULT_VALUES[env_var]
    print(f"ERROR: Secret '{env_var}' not found in Doppler or environment",
          file=sys.stderr)
    sys.exit(1)


def replace_placeholders(content: str, secrets: dict) -> str:
    """Replace all placeholders in content with resolved values."""
    for placeholder, env_var in PLACEHOLDER_PATTERNS.items():
        if placeholder in content:
            value = secrets.get(env_var, resolve_placeholder(placeholder, env_var))
            content = content.replace(placeholder, value)
    return content


def read_manifest() -> dict:
    """Read manifest.json from source directory."""
    if not MANIFEST_PATH.exists():
        print(f"ERROR: manifest.json not found at {MANIFEST_PATH}",
              file=sys.stderr)
        sys.exit(1)
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def write_manifest(manifest: dict) -> None:
    """Write manifest.json back to source directory."""
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def parse_version(version_str: str) -> tuple:
    """Parse semver string into (major, minor, patch) integers."""
    parts = version_str.strip().split(".")
    if len(parts) != 3:
        print(f"ERROR: Invalid version format: {version_str} (expected X.Y.Z)",
              file=sys.stderr)
        sys.exit(1)
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        print(f"ERROR: Version components must be integers: {version_str}",
              file=sys.stderr)
        sys.exit(1)


def bump_version(current_version: str, bump_type: str) -> str:
    """Bump version by patch, minor, or major."""
    major, minor, patch = parse_version(current_version)

    if bump_type == "patch":
        patch += 1
    elif bump_type == "minor":
        minor += 1
        patch = 0
    elif bump_type == "major":
        major += 1
        minor = 0
        patch = 0
    else:
        print(f"ERROR: Invalid bump type: {bump_type} (use patch, minor, or major)",
              file=sys.stderr)
        sys.exit(1)

    new_version = f"{major}.{minor}.{patch}"
    print(f"  {current_version} -> {new_version} ({bump_type} bump)")
    return new_version


def update_manifest_version(
    output_dir: Path,
    new_version: Optional[str] = None,
    bump_type: Optional[str] = None,
    dry_run: bool = False,
) -> str:
    """Update manifest version and return the final version string.

    Args:
        output_dir: Output directory for built extension.
        new_version: Explicit version to set (takes precedence over bump).
        bump_type: Type of version bump (patch, minor, major).
        dry_run: If True, only print what would be done.

    Returns:
        The final version string.
    """
    manifest = read_manifest()
    current_version = manifest.get("version", "0.0.0")
    print(f"  Current manifest version: {current_version}")

    if new_version:
        final_version = new_version
        print(f"  Setting version to: {final_version} (--set-version)")
    elif bump_type:
        final_version = bump_version(current_version, bump_type)
    else:
        final_version = current_version
        print(f"  Keeping version: {final_version} (no bump requested)")

    if not dry_run and output_dir != SRC_DIR:
        # Write updated manifest to source (so zip and CI artifacts have correct version)
        manifest["version"] = final_version
        write_manifest(manifest)
        print(f"  Updated manifest.json version to: {final_version}")
    elif dry_run:
        print(f"  [DRY RUN] Would set version to: {final_version}")

    # Also update the output manifest if it exists
    out_manifest = output_dir / "manifest.json"
    if out_manifest.exists() and not dry_run:
        out_manifest.write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )

    return final_version


def build_extension(
    output_dir: Path,
    bump_version_type: Optional[str] = None,
    set_version: Optional[str] = None,
    dry_run: bool = False,
) -> str:
    """Build extension with secrets injected and version updated.

    Returns the version string used for this build.
    """
    # Collect secrets upfront
    secrets = {}
    for placeholder, env_var in PLACEHOLDER_PATTERNS.items():
        secrets[env_var] = resolve_placeholder(placeholder, env_var)

    print(f"Resolved secrets: {list(secrets.keys())}")
    print(f"  (Secrets sourced from Doppler: {DOPPLER_PROJECT}/{DOPPLER_CONFIG})")

    # Update manifest version BEFORE building
    version = update_manifest_version(
        output_dir, new_version=set_version, bump_type=bump_version_type,
        dry_run=dry_run
    )

    if dry_run:
        print(f"\n[DRY RUN] Would build extension v{version} to: {output_dir}")
        return version

    # Clean output dir
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Copy and replace
    files_processed = 0
    files_replaced = 0
    for src_file in SRC_DIR.rglob("*"):
        if src_file.is_dir():
            continue
        if src_file.suffix in (".pyc", ".pyo"):
            continue

        rel_path = src_file.relative_to(SRC_DIR)
        out_file = output_dir / rel_path

        if src_file.suffix in (".js", ".html", ".json"):
            content = src_file.read_text(encoding="utf-8")
            has_placeholders = any(p in content for p in PLACEHOLDER_PATTERNS)
            if has_placeholders:
                print(f"  Injecting secrets in: {rel_path}")
                content = replace_placeholders(content, secrets)
                files_replaced += 1
            out_file.write_text(content, encoding="utf-8")
            files_processed += 1
        else:
            shutil.copy2(src_file, out_file)
            files_processed += 1

    print(f"  Files processed: {files_processed}")
    print(f"  Secrets injected: {files_replaced} files")

    print(f"✅ Extension built to: {output_dir}")
    print(f"   Version: v{version}")
    print(f"   Load unpacked from this directory in Chrome")
    print(f"   Or install from: {RELEASE_DIR / f'extension-{version}.zip'}")

    # Write .gitignore for output
    gitignore_path = output_dir / ".gitignore"
    gitignore_path.write_text("*", encoding="utf-8")
    print(f"   Added .gitignore (build artifacts not committed)")

    write_build_stamp(output_dir, version)
    return version


def _git(*args: str) -> str:
    """Run a git command, returning "" on any failure (e.g. no repo)."""
    try:
        out = subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def _source_version() -> str:
    """Version declared in the source manifest — the one git tracks."""
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8")).get("version", "")
    except Exception:
        return ""


def _source_digest() -> str:
    """
    Hash the source files that actually feed the build.

    Comparing commit SHAs is not enough: the working tree is dirty most of
    the time during development, so the same commit covers an untouched tree
    and one where content.js was just edited. That is precisely the case that
    let a live verification run against a stale build. Hashing the inputs
    catches "the source moved, the build did not", regardless of git.
    """
    import hashlib

    h = hashlib.sha256()
    for path in sorted(SRC_DIR.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        rel = path.relative_to(SRC_DIR).as_posix()
        h.update(rel.encode("utf-8"))
        try:
            h.update(path.read_bytes())
        except OSError:
            continue
    return h.hexdigest()[:12]


def write_build_stamp(output_dir: Path, version: str) -> Path:
    """
    Record what this build was made from.

    A built manifest can carry a new version while the JS beside it is from an
    earlier build — that mismatch once hid a live verification, because the
    version looked current and nobody asked whether the code was. The stamp
    makes the two comparable: if the version or the commit moves without a
    rebuild, verify_build() says so instead of the build going quietly stale.
    """
    stamp = {
        "version": version,
        "source_version": _source_version(),
        "source_digest": _source_digest(),
        "commit": _git("rev-parse", "--short", "HEAD"),
        "dirty": bool(_git("status", "--porcelain")),
        "built_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        # Relative to the repo root, and the same string extension.config.json
        # declares, so a tool holding only this file knows where "Load unpacked"
        # must point without a developer's home directory baked into it.
        "unpacked_path": _EXTENSION_CFG["unpacked"],
    }
    path = output_dir / STAMP_NAME
    path.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
    print(f"   Stamped {STAMP_NAME} (commit {stamp['commit'] or 'unknown'}"
          f"{', dirty tree' if stamp['dirty'] else ''})")
    return path


def verify_build() -> int:
    """
    Report whether dist/extension still matches the source it was built from.

    Exit 0 when fresh, 1 when stale or missing. This is the check to run
    before trusting anything about a live browser session, because "the
    extension is loaded" does not imply "the extension has the current code".
    """
    out_dir = DEFAULT_OUT_DIR
    stamp_path = out_dir / STAMP_NAME

    if not (out_dir / "manifest.json").is_file():
        print(f"❌ No build at {out_dir}")
        print("   Run: python3 scripts/build-extension.py")
        return 1

    if not stamp_path.is_file():
        print(f"⚠️  Build at {out_dir} has no {STAMP_NAME} (built before stamping).")
        print("   Rebuild to get a comparable stamp.")
        return 1

    try:
        stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"❌ {STAMP_NAME} is unreadable: {e}")
        return 1

    src_ver = _source_version()
    built_ver = stamp.get("version", "")
    head = _git("rev-parse", "--short", "HEAD")
    problems = []

    if src_ver and built_ver and src_ver != built_ver:
        problems.append(f"version: built {built_ver}, source is {src_ver}")

    # The decisive check: did the source move since this build?
    src_digest = _source_digest()
    built_digest = stamp.get("source_digest", "")
    if built_digest and src_digest and built_digest != src_digest:
        problems.append(
            f"source changed: built from {built_digest}, source is now {src_digest}"
        )

    if problems:
        print(f"❌ STALE build at {out_dir}")
        for p in problems:
            print(f"   {p}")
        print("   Chrome would be running older code than the repo. Run:")
        print("   python3 scripts/build-extension.py   # then reload the extension")
        return 1

    print(f"✅ Build is current: v{built_ver} from {stamp.get('commit') or 'unknown'}"
          f", built {stamp.get('built_at', 'unknown')}")

    # A newer commit is only worth mentioning, never a failure: commits that
    # touch docs, tests, or the worker do not change what Chrome loads, and
    # flagging those would train the reader to ignore a real STALE.
    if head and stamp.get("commit") and stamp["commit"] != head:
        print(f"   ℹ️  HEAD is {head}, built from {stamp['commit']} — but the "
              f"extension source is unchanged, so the loaded code is current.")
    if stamp.get("dirty"):
        print("   ⚠️  built from a dirty working tree")
    return 0


def create_release_zip(version: str, output_dir: Path) -> Path:
    """Package the built extension into dist/, beside the unpacked build."""
    zip_path = RELEASE_DIR / f"extension-{version}.zip"

    # Remove old zip
    if zip_path.exists():
        zip_path.unlink()
        print(f"  Removed old zip: {zip_path.name}")

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)

    # Create zip
    import zipfile
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for filepath in output_dir.rglob("*"):
            if not filepath.is_file():
                continue
            # Skip macOS junk and git files
            if "__MACOSX" in str(filepath) or ".DS_Store" in str(filepath):
                continue
            if ".git" in str(filepath):
                continue
            if filepath.name == ".gitignore":
                continue
            arcname = filepath.relative_to(output_dir)
            zf.write(filepath, arcname)

    # Verify zip
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        size_bytes = sum(info.file_size for info in zf.infolist())

        has_manifest = any("manifest.json" in n for n in names)
        has_background = any("background.js" in n for n in names)
        has_content = any("content.js" in n for n in names)
        has_injected = any("injected.js" in n for n in names)

        if not all([has_manifest, has_background, has_content, has_injected]):
            print("❌ FAIL: Missing required files in zip")
            sys.exit(1)

        # Validate manifest
        m = json.loads(zf.read("manifest.json"))
        assert m["version"] == version, \
            f"Version mismatch in zip: {m['version']} != {version}"
        assert m["manifest_version"] == 3

    size_kb = size_bytes / 1024
    print(f"✅ Created zip: {zip_path.name}")
    print(f"   Size: {size_kb:.1f} KB ({size_bytes} bytes)")
    print(f"   Files: {len(names)}")
    print(f"   Version: v{version}")
    print(f"   Path: {zip_path}")

    return zip_path


def zip_extension(output_dir: Path, version: str) -> Path:
    """Package extension zip (wrapper for create_release_zip)."""
    return create_release_zip(version, output_dir)


def clean(output_dir: Path) -> None:
    """Remove the unpacked build and every packaged artifact in dist/."""
    if output_dir.exists():
        shutil.rmtree(output_dir)
        print(f"✅ Cleaned: {output_dir}")
    else:
        print(f"Already clean: {output_dir}")

    # Every zip in dist/ is a build artifact of this script, so clean them all
    # rather than only the current version's — a stale one is the thing most
    # likely to be loaded by mistake.
    if RELEASE_DIR.is_dir():
        for z in sorted(RELEASE_DIR.glob("extension-*.zip*")):
            z.unlink()
            print(f"✅ Cleaned: {z.name}")


def main():
    parser = argparse.ArgumentParser(
        description="Build Chrome extension with secrets injected and version management"
    )
    parser.add_argument(
        "--output", "-o", type=Path, default=DEFAULT_OUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUT_DIR})"
    )
    parser.add_argument(
        "--clean", "-c", action="store_true",
        help="Clean build output and release zip"
    )
    parser.add_argument(
        "--bump-version", "-b", choices=["patch", "minor", "major"],
        help="Auto-increment version (e.g. 4.3.7 -> 4.3.8 for patch)"
    )
    parser.add_argument(
        "--set-version", "-s", type=str,
        help="Force specific version (e.g. 4.3.9). Overrides --bump-version"
    )
    parser.add_argument(
        "--dry-run", "-n", action="store_true",
        help="Show what would be done without building"
    )
    parser.add_argument(
        "--create-zip", "-z", action="store_true", default=True,
        help="Package the build into dist/extension-<version>.zip (default: on)"
    )
    parser.add_argument(
        "--no-zip", action="store_true",
        help="Skip the zip; only the unpacked build in dist/extension is written"
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Check whether dist/extension still matches the source. No build. "
             "Exits 1 if stale — run this before trusting a live browser session."
    )
    parser.add_argument(
        "--skip-build", action="store_true",
        help="Skip build step, only update version in manifest"
    )
    parser.add_argument(
        "--upsert-secrets", action="store_true",
        help="Upsert URL secrets (WORKER_URL, MCP_ENDPOINT, WSS_ENDPOINT, OPENAI_ENDPOINT) to Doppler"
    )

    args = parser.parse_args()

    # --verify is a read-only check: no build, no secrets, no network.
    if args.verify:
        sys.exit(verify_build())

    if args.no_zip:
        args.create_zip = False

    # Handle upsert secrets command
    if args.upsert_secrets:
        secrets_to_upsert = {
            "WORKER_URL": os.environ.get("WORKER_URL", DEFAULT_VALUES["WORKER_URL"]),
            "MCP_ENDPOINT": os.environ.get("MCP_ENDPOINT", DEFAULT_VALUES["MCP_ENDPOINT"]),
            "WSS_ENDPOINT": os.environ.get("WSS_ENDPOINT", DEFAULT_VALUES["WSS_ENDPOINT"]),
            "OPENAI_ENDPOINT": os.environ.get("OPENAI_ENDPOINT", DEFAULT_VALUES["OPENAI_ENDPOINT"]),
        }
        print("Upserting URL secrets to Doppler...")
        success = upsert_doppler_secrets(secrets_to_upsert, dry_run=args.dry_run)
        sys.exit(0 if success else 1)

    # Validate argument combinations
    if args.skip_build and args.create_zip:
        print("ERROR: --skip-build and --create-zip are mutually exclusive",
              file=sys.stderr)
        sys.exit(1)

    if args.set_version and args.bump_version:
        print("ERROR: --set-version and --bump-version are mutually exclusive",
              file=sys.stderr)
        sys.exit(1)

    if args.skip_build:
        # Only update version in manifest, no build
        version = update_manifest_version(
            args.output,
            new_version=args.set_version,
            bump_type=args.bump_version,
            dry_run=args.dry_run,
        )
        print(f"\n✅ Version updated to: {version}")
        print(f"   Manifest: {MANIFEST_PATH}")
        return

    if args.clean:
        clean(args.output)
        return

    if args.dry_run:
        version = update_manifest_version(
            args.output,
            new_version=args.set_version,
            bump_type=args.bump_version,
            dry_run=True,
        )
        print(f"\n[DRY RUN] Build would produce: v{version}")
        return

    # Normal build
    version = build_extension(
        args.output,
        bump_version_type=args.bump_version,
        set_version=args.set_version,
    )

    # Optionally create zip
    if args.create_zip:
        zip_path = create_release_zip(version, args.output)
        print(f"\n📦 Release artifact: {zip_path}")

    print(f"\n🏁 Build complete: v{version}")


if __name__ == "__main__":
    main()
