#!/usr/bin/env python3
"""Restore sanitized StreamGenerate descriptors in the committed fixture.

Usage:
  python3 scripts/restore-streamgenerate-captures.py \
    --source app-chip-present-2026-10-02=/path/to/first-buffer.json \
    --source app-chip-present-2026-10-02b=/path/to/present.json \
    --source app-chip-repeat-2026-10-02=/path/to/repeat.json \
    --source app-chip-absent-2026-10-02=/path/to/absent.json

The source files must contain the already-sanitized PAYLOAD_CAPTURE record. This
script copies only structural descriptors; it never reads or serializes request
text. Both the legacy `kind` and current `type` descriptor keys are accepted.
"""

import argparse
import json
import os
import tempfile


FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "cloudflare-worker",
    "tests",
    "fixtures",
    "streamgenerate-captures.json",
)


def normalized(node):
    """Convert sanitizer descriptors to the fixture's stable `kind` shape."""
    if isinstance(node, dict):
        node_type = node.get("type") or node.get("kind")
        if node_type == "string":
            length = node.get("length")
            cls = node.get("cls")
            if not isinstance(length, int) or not isinstance(cls, str):
                raise ValueError("incomplete sanitized string descriptor")
            # The fixture keeps this established spelling, regardless of which
            # spelling the producer used when it captured the record.
            return {"kind": "string", "length": length, "cls": cls}
        return {key: normalized(value) for key, value in node.items()}
    if isinstance(node, list):
        return [normalized(value) for value in node]
    if isinstance(node, str) and node not in {
        "number", "boolean", "max_depth", "undefined"
    }:
        raise ValueError("unexpected string value in sanitized structure")
    return node


def source_record(path):
    with open(path, encoding="utf-8") as stream:
        value = json.load(stream)

    records = []
    if isinstance(value, dict) and isinstance(value.get("captures"), list):
        records.extend(
            item.get("record") for item in value["captures"]
            if isinstance(item, dict) and isinstance(item.get("record"), dict)
        )
    elif isinstance(value, dict) and isinstance(value.get("record"), dict):
        records.append(value["record"])
    elif isinstance(value, dict):
        records.append(value)

    matches = [record for record in records if record.get("endpoint") == "StreamGenerate"]
    if len(matches) != 1:
        raise ValueError(f"{path}: expected exactly one StreamGenerate record, got {len(matches)}")

    envelope = matches[0].get("structure")
    structure = envelope.get("structure") if isinstance(envelope, dict) else None
    if not isinstance(structure, list):
        raise ValueError(f"{path}: missing bounded structure array")
    return normalized(structure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture", default=FIXTURE,
        help="fixture JSON path (defaults to tests/fixtures/streamgenerate-captures.json)",
    )
    parser.add_argument(
        "--source", action="append", required=True, metavar="CAPTURE_ID=PATH",
        help="sanitized capture source to restore; may be repeated",
    )
    args = parser.parse_args()

    sources = {}
    for argument in args.source:
        capture_id, separator, path = argument.partition("=")
        if not separator or not capture_id or not path or capture_id in sources:
            parser.error("each --source must be a unique CAPTURE_ID=PATH")
        sources[capture_id] = source_record(path)

    with open(args.fixture, encoding="utf-8") as stream:
        fixture = json.load(stream)
    captures = {
        capture.get("captureId"): capture
        for capture in fixture.get("captures", [])
        if isinstance(capture, dict)
    }
    missing = sorted(set(sources) - set(captures))
    if missing:
        raise ValueError("fixture is missing capture IDs: " + ", ".join(missing))

    for capture_id, structure in sources.items():
        captures[capture_id]["structure"] = structure
        captures[capture_id]["fieldCount"] = len(structure)

    directory = os.path.dirname(os.path.abspath(args.fixture))
    fd, temporary = tempfile.mkstemp(prefix=".streamgenerate-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(fixture, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, args.fixture)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    print("Restored sanitized structure for " + ", ".join(sorted(sources)))


if __name__ == "__main__":
    main()
