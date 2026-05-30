#!/usr/bin/env python3
"""Build the Chrome Web Store upload ZIP (quick-summary-for-youtube.zip).

Bundles only the runtime files (manifest.json, src/, icons/) and nothing else —
no docs, dev tooling, or IDE folders. Entry paths use forward slashes, which the
ZIP spec and Chrome's extension loader require (Windows PowerShell's
Compress-Archive writes backslashes, which can break the upload). Run from anywhere:

    python tools/package.py
"""

import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "quick-summary-for-youtube.zip")

# Paths to include, relative to the extension root.
INCLUDE_FILES = ["manifest.json"]
INCLUDE_DIRS = ["src", "icons"]


def main():
    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in INCLUDE_FILES:
            z.write(os.path.join(ROOT, rel), rel)
        for d in INCLUDE_DIRS:
            for dirpath, _dirs, files in os.walk(os.path.join(ROOT, d)):
                for name in sorted(files):
                    full = os.path.join(dirpath, name)
                    arc = os.path.relpath(full, ROOT).replace(os.sep, "/")
                    z.write(full, arc)

    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    print("wrote %s (%d files)" % (os.path.relpath(OUT, ROOT), len(names)))
    for n in sorted(names):
        print("   ", n)


if __name__ == "__main__":
    main()
