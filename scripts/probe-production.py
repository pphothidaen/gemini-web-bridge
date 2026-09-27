#!/usr/bin/env python3
"""Classify a production /health probe.

Kept as a standalone file rather than an inline `python3 -c` in the
workflow: a multi-line program inside a YAML block scalar is parsed as a
mapping key the moment a line begins with a quote, which is how the first
version of the probe workflow failed to load at all.

Writes GitHub Actions outputs (code, detail, body_file) when run as a
step, and prints an advisory line when run with --advisory.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

DEFAULT_URL = "https://prod.gemini-web-bridge.workers.dev"


def probe(url, timeout=30):
    """Return (http_code, body_text). 000 means no response at all."""
    req = urllib.request.Request(
        url + "/health",
        # Some edges reject requests without a UA with a 403 that has
        # nothing to do with the worker's health.
        headers={"User-Agent": "bridge-probe/1.0", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, "probe error: %s" % e


def classify(code, body):
    """Map a response to an operator-actionable sentence.

    The 1101 case is separated deliberately: it is a billing/plan limit,
    not a code fault, and conflating it with a generic 5xx sends whoever
    is on call to debug the wrong thing.
    """
    if code == 200:
        return "healthy"
    if code == 0:
        return ("no response within the timeout - worker unreachable, or the "
                "Durable Object is wedged rather than merely busy")
    if "1101" in body:
        return ("Cloudflare 1101: Durable Object free-tier CPU budget "
                "exhausted. NOT a code regression. Remedy: raise the Workers "
                "plan for this account in the dashboard, then confirm the "
                "next probe is green.")
    if code == 503:
        return ("503: the DO has no usable model. Expected when no browser "
                "extension is connected; investigate only if the extension "
                "should be live.")
    if code == 401 or code == 403:
        return "auth failure on an unauthenticated endpoint - unexpected, check recent deploys"
    if 500 <= code < 600:
        return "server error %d - check wrangler tail and recent deploys" % code
    return "unexpected status %d" % code


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--advisory":
        body_path = sys.argv[2]
        try:
            with open(body_path, encoding="utf-8") as fh:
                d = json.load(fh)
            t = d.get("instance_tracking", {})
            print("   extension_status   :", d.get("extension_status"))
            print("   active connections :", t.get("active_connections_count"))
            print("   catalog_revision   :", (d.get("browser_models") or {}) and "present")
        except Exception:
            print("   could not read the health body for the advisory check")
        return 0

    url = os.environ.get("PROD_URL", DEFAULT_URL).rstrip("/")
    code, body = probe(url)

    handle, body_path = tempfile.mkstemp(prefix="bridge-health-", suffix=".json")
    with os.fdopen(handle, "w", encoding="utf-8") as fh:
        fh.write(body)

    detail = classify(code, body)
    print("HTTP %s from %s/health" % (code, url))
    print("--- body (first 400 bytes) ---")
    print(body[:400])

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write("code=%s\n" % code)
            fh.write("detail=%s\n" % detail.replace("\n", " "))
            fh.write("body_file=%s\n" % body_path)

    print("classification:", detail)
    return 0 if code == 200 else 0  # the workflow decides pass/fail


if __name__ == "__main__":
    sys.exit(main())
