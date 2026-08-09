import subprocess
import sys
from pathlib import Path


def test_seed_platform_can_be_loaded_from_backend_directory():
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-I", "-c", f"import runpy; runpy.run_path(r'{backend / 'scripts' / 'seed_platform.py'}', run_name='not_main')"],
        cwd=backend,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_reconcile_schedules_can_be_loaded_from_backend_directory():
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-I", "-c", f"import runpy; runpy.run_path(r'{backend / 'scripts' / 'reconcile_schedules.py'}', run_name='not_main')"],
        cwd=backend,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
