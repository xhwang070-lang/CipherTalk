# -*- coding: utf-8 -*-
"""Huaji pack helper.

Usage:
  python pack.py           # full Windows installer -> Desktop\\Huaji-版本-Setup.exe
  python pack.py --hot     # patch this PC's installed Huaji only (fast)
  python pack.py --no-pause
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def which_npm() -> str:
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if npm:
        return npm
    raise SystemExit("找不到 npm。先打开能跑 npm 的终端，或把 Node 加进 PATH。")


def run_npm(script: str) -> None:
    npm = which_npm()
    print(f"\n> {npm} run {script}\n", flush=True)
    env = os.environ.copy()
    env.setdefault("CSC_IDENTITY_AUTO_DISCOVERY", "false")
    result = subprocess.run(
        [npm, "run", script],
        cwd=ROOT,
        env=env,
        shell=False,
    )
    if result.returncode:
        raise SystemExit(f"打包失败，退出码 {result.returncode}")


def latest_setup() -> Path | None:
    release = ROOT / "release"
    if not release.exists():
        return None
    setups = sorted(release.glob("Huaji-*-Setup.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    return setups[0] if setups else None


def main() -> int:
    parser = argparse.ArgumentParser(description="打包华记")
    parser.add_argument("--hot", action="store_true", help="只热更本机已安装的华记，不打安装包")
    parser.add_argument("--no-pause", action="store_true", help="结束后不等回车")
    args = parser.parse_args()

    os.chdir(ROOT)
    print(f"目录: {ROOT}")
    print(f"模式: {'本机热更 pack:hot' if args.hot else '安装包 pack:win'}")

    try:
        if args.hot:
            run_npm("pack:hot")
            print("\n热更完成。本机华记已替换，不用重装。")
        else:
            run_npm("pack:win")
            setup = latest_setup()
            desktop = Path.home() / "Desktop"
            if setup:
                copied = desktop / setup.name
                print(f"\n安装包: {setup}")
                if copied.exists():
                    print(f"桌面副本: {copied}")
            else:
                print("\n打包结束，但没找到 release\\Huaji-*-Setup.exe，去 release 目录看一下。")
        return 0
    except SystemExit as exc:
        print(exc)
        return int(exc.code) if isinstance(exc.code, int) else 1
    finally:
        if not args.no_pause:
            try:
                input("\n按回车退出...")
            except EOFError:
                pass


if __name__ == "__main__":
    sys.exit(main())
