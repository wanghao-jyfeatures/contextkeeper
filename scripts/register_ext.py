# -*- coding: utf-8 -*-
"""Register the ContextKeeper extension into Trae's extensions.json catalog.

Trae treats extensions.json as the authoritative extension list; the CLI
install channel (--install-extension) silently fails, so sideloading is
the supported path. This script is idempotent (skips if already registered)
and backs up the catalog before writing.

Usage:
    python register_ext.py [--ext-dir <path-to-copied-extension-folder>]

Defaults:
    ext-dir = ~/.trae-cn/extensions/hackathon-lm-probe.lm-probe-0.0.1
    catalog = ~/.trae-cn/extensions/extensions.json
"""
import json
import os
import shutil
import sys
import time

EXT_ID = "hackathon-lm-probe.lm-probe"
EXT_NAME = "hackathon-lm-probe.lm-probe-0.0.1"


def to_uri(p):
    """Windows path -> VS Code URI style path (c:/... -> /c:/...)."""
    p = p.replace("\\", "/")
    if len(p) > 1 and p[1] == ":":
        return "/" + p[0].lower() + p[1:]
    return p


def main():
    argv = sys.argv[1:]
    ext_dir = None
    if "--ext-dir" in argv:
        ext_dir = argv[argv.index("--ext-dir") + 1]
    home = os.path.expanduser("~")
    ext_root = os.path.join(home, ".trae-cn", "extensions")
    if not ext_dir:
        ext_dir = os.path.join(ext_root, EXT_NAME)
    if not os.path.isdir(ext_dir):
        print(f"ERROR: extension folder not found: {ext_dir}")
        print("Copy extension/ (extension.js + package.json) there first, or pass --ext-dir.")
        sys.exit(1)

    catalog = os.path.join(ext_root, "extensions.json")
    if not os.path.isfile(catalog):
        print(f"ERROR: catalog not found: {catalog}")
        sys.exit(1)

    shutil.copy2(catalog, catalog + ".bak")
    print(f"backup: {catalog}.bak")

    with open(catalog, "r", encoding="utf-8") as f:
        data = json.load(f)

    print(f"current entries: {len(data)}")
    if any(e.get("identifier", {}).get("id") == EXT_ID for e in data):
        print("already registered, skip")
        return

    entry = {
        "identifier": {"id": EXT_ID},
        "version": "0.0.1",
        "location": {"$mid": 1, "path": to_uri(ext_dir), "scheme": "file"},
        "relativeLocation": os.path.basename(ext_dir),
        "metadata": {
            "installedTimestamp": int(time.time() * 1000),
            "pinned": False,
            "source": "vsix",
            "id": EXT_ID,
            "publisherId": "",
            "publisherDisplayName": "hackathon-lm-probe",
            "targetPlatform": "universal",
            "updated": False,
            "private": False,
            "isPreReleaseVersion": False,
            "hasPreReleaseVersion": False,
        },
    }
    data.append(entry)
    with open(catalog, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"registered, total entries: {len(data)}")

    with open(catalog, "r", encoding="utf-8") as f:
        check = json.load(f)
    print(f"verify: {len(check)} entries, json valid")


if __name__ == "__main__":
    main()
