#!/usr/bin/env python3
"""Merge a thin arm64 .app and a thin x86_64 .app into one universal2 .app.

Walks both bundles in lockstep. Every Mach-O file is combined with `lipo`;
everything else is copied through from the arm64 bundle (the two builds share
identical Python bytecode/data since they use the same interpreter version).
Symlinks are preserved. The merged bundle is re-signed ad-hoc at the end
because lipo invalidates the per-binary signatures PyInstaller applied — and
arm64 code will not launch unsigned.

Usage:
    merge-universal.py <arm64.app> <x86_64.app> <output.app>
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def lipo_archs(path: Path) -> set[str] | None:
    """Return the arch slices of a Mach-O file, or None if not Mach-O."""
    r = subprocess.run(["lipo", "-archs", str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return set(r.stdout.split())


def thin(src: Path, arch: str, dest: Path) -> None:
    subprocess.run(["lipo", str(src), "-thin", arch, "-output", str(dest)], check=True)


def make_fat(arm: Path, x86: Path, dest: Path, tmp: Path) -> None:
    """lipo -create the union of slices from arm and x86 into dest."""
    arm_archs = lipo_archs(arm) or set()
    x86_archs = lipo_archs(x86) or set()
    want = arm_archs | x86_archs
    if want <= arm_archs:  # arm already covers everything (e.g. already fat)
        return
    inputs: list[Path] = []
    scratch: list[Path] = []
    for i, a in enumerate(sorted(want)):
        # take each slice from its native build when available
        source = x86 if a == "x86_64" else (arm if a in arm_archs else x86)
        if len(lipo_archs(source) or set()) == 1:
            inputs.append(source)  # already thin for this arch, use as-is
        else:
            s = tmp / f"slice_{i}_{a}"
            thin(source, a, s)
            inputs.append(s)
            scratch.append(s)
    # write to a temp first: `dest` is usually the arm input, and lipo must not
    # read and overwrite the same path in one call.
    out = tmp / "merged.bin"
    subprocess.run(["lipo", "-create", *map(str, inputs), "-output", str(out)], check=True)
    mode = dest.stat().st_mode
    shutil.move(str(out), str(dest))
    os.chmod(dest, mode)
    for s in scratch:
        s.unlink(missing_ok=True)


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write(__doc__ or "")
        return 2
    arm_app, x86_app, out_app = (Path(p) for p in sys.argv[1:4])
    for p in (arm_app, x86_app):
        if not p.is_dir():
            sys.stderr.write(f"✗ not a bundle: {p}\n")
            return 1

    if out_app.exists():
        shutil.rmtree(out_app)
    # arm64 bundle is the base: preserves symlinks, layout, permissions.
    shutil.copytree(arm_app, out_app, symlinks=True)

    tmp = out_app.parent / ".lipo-tmp"
    tmp.mkdir(exist_ok=True)

    merged = copied = missing = 0
    for root, _dirs, files in os.walk(out_app):
        for name in files:
            uni = Path(root) / name
            if uni.is_symlink():
                continue
            rel = uni.relative_to(out_app)
            x86 = x86_app / rel
            if not x86.exists():
                # file only present in arm build — leave the arm copy in place
                missing += 1
                continue
            if lipo_archs(uni) is not None and lipo_archs(x86) is not None:
                make_fat(uni, x86, uni, tmp)
                merged += 1
            elif uni.stat().st_size != x86.stat().st_size:
                # non-Mach-O that differs between builds: prefer x86 copy so
                # nothing arch-specific is silently dropped (rare/none expected)
                shutil.copy2(x86, uni)
                copied += 1

    shutil.rmtree(tmp, ignore_errors=True)

    # lipo stripped the signatures; re-sign the whole bundle ad-hoc.
    print("→ re-signing merged bundle (ad-hoc)")
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(out_app)], check=True
    )

    print(f"✓ merged {merged} Mach-O files, copied {copied}, arm-only {missing}")
    print(f"  → {out_app}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
