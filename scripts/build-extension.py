#!/usr/bin/env python3
"""
build-extension.py — Build extension with secrets injected at build time.

Replaces placeholders in source files with secrets from Doppler:
  __BRIDGE_AUTH_TOKEN__  → from Doppler BRIDGE_AUTH_TOKEN
  __CLIENT_API_TOKEN__   → from Doppler CLIENT_API_TOKEN
  __WORKER_URL__         → from Doppler WORKER_URL (optional)
  __MCP_ENDPOINT__       → from Doppler MCP_ENDPOINT (optional)
  __WSS_ENDPOINT__       → from Doppler WSS_ENDPOINT (optional)

Usage:
  python3 build-extension.py
  python3 build-extension.py --output dist/
  python3 build-extension.py --clean

Files with .template suffix are copied to output with placeholders resolved.
Direct .js/.html files are scanned and replaced in-place if they contain placeholders.
"""

import os
import re
import sys
import shutil
import argparse
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "extension-cloudflare"
DEFAULT_OUT_DIR = REPO_ROOT / "dist" / "extension"

PLACEHOLDER_PATTERNS = {
    "__BRIDGE_AUTH_TOKEN__": "BRIDGE_AUTH_TOKEN",
    "__CLIENT_API_TOKEN__": "CLIENT_API_TOKEN",
    "__WORKER_URL__": "WORKER_URL",
    "__MCP_ENDPOINT__": "MCP_ENDPOINT",
    "__WSS_ENDPOINT__": "WSS_ENDPOINT",
    "__OPENAI_ENDPOINT__": "OPENAI_ENDPOINT",
}

# First check Doppler, then environment
DOPPLER_PROJECT = "gemini-web-bridge"
DOPPLER_CONFIG = "prd_worker"


def get_doppler_secret(key: str) -> str:
    """Fetch secret from Doppler, fallback to env var."""
    try:
        result = subprocess.run(
            ["doppler", "secrets", "get", key, "--project", DOPPLER_PROJECT, "--config", DOPPLER_CONFIG, "--plain"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


def resolve_placeholder(placeholder: str, env_var: str) -> str:
    """Resolve placeholder: Doppler → env → error."""
    # Try Doppler first
    val = get_doppler_secret(env_var)
    if val:
        return val
    # Fallback to environment
    val = os.environ.get(env_var, "")
    if val:
        return val
    # Some are optional (URLs have defaults)
    if env_var in ("WORKER_URL", "MCP_ENDPOINT", "WSS_ENDPOINT", "OPENAI_ENDPOINT"):
        return f"__DEFAULT_{env_var}__"  # Will be replaced with hardcoded default
    print(f"ERROR: Secret '{env_var}' not found in Doppler or environment", file=sys.stderr)
    sys.exit(1)


def replace_placeholders(content: str, secrets: dict) -> str:
    """Replace all placeholders in content with resolved values."""
    for placeholder, env_var in PLACEHOLDER_PATTERNS.items():
        if placeholder in content:
            value = secrets.get(env_var, resolve_placeholder(placeholder, env_var))
            content = content.replace(placeholder, value)
    return content


def build_extension(output_dir: Path) -> None:
    """Build extension with secrets injected."""
    # Collect secrets upfront
    secrets = {}
    for placeholder, env_var in PLACEHOLDER_PATTERNS.items():
        secrets[env_var] = resolve_placeholder(placeholder, env_var)
    
    print(f"Resolved secrets: {list(secrets.keys())}")
    
    # Clean output dir
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy and replace
    for src_file in SRC_DIR.rglob("*"):
        if src_file.is_dir():
            continue
        if src_file.suffix in (".pyc", ".pyo"):
            continue
        
        rel_path = src_file.relative_to(SRC_DIR)
        out_file = output_dir / rel_path
        
        if src_file.suffix in (".js", ".html", ".json"):
            content = src_file.read_text(encoding="utf-8")
            # Check if has placeholders
            has_placeholders = any(p in content for p in PLACEHOLDER_PATTERNS)
            if has_placeholders:
                print(f"  Replacing placeholders in: {rel_path}")
                content = replace_placeholders(content, secrets)
            out_file.write_text(content, encoding="utf-8")
        else:
            shutil.copy2(src_file, out_file)
    
    # Also update manifest version to indicate build
    manifest_path = output_dir / "manifest.json"
    if manifest_path.exists():
        manifest = manifest_path.read_text(encoding="utf-8")
        # Add build timestamp comment? No, manifest.json doesn't support comments
        pass
    
    print(f"✅ Extension built to: {output_dir}")
    print(f"   Load unpacked from this directory in Chrome")

    # Write .gitignore for output
    gitignore_path = output_dir / ".gitignore"
    gitignore_path.write_text("*", encoding="utf-8")
    print(f"   Added .gitignore (build artifacts not committed)")


def clean(output_dir: Path) -> None:
    """Clean build output."""
    if output_dir.exists():
        shutil.rmtree(output_dir)
        print(f"✅ Cleaned: {output_dir}")
    else:
        print(f"Already clean: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Build extension with secrets injected")
    parser.add_argument("--output", "-o", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--clean", "-c", action="store_true")
    args = parser.parse_args()
    
    if args.clean:
        clean(args.output)
    else:
        build_extension(args.output)


if __name__ == "__main__":
    main()
