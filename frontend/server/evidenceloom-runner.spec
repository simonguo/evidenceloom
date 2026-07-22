# PyInstaller spec for the Evidence Loom Tauri sidecar runner.
# Build from the repository root, for example:
#   pyinstaller frontend/server/evidenceloom-runner.spec --distpath /tmp/evidenceloom-runner-dist

from pathlib import Path

repo_root = Path.cwd()
runner = repo_root / "frontend" / "server" / "run_analysis.py"

block_cipher = None

a = Analysis(
    [str(runner)],
    pathex=[str(repo_root)],
    binaries=[],
    datas=[],
    hiddenimports=["load_ohlcv_chart", "resolve_instrument", "test_llm"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="evidenceloom-runner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
