import subprocess
import sys
from pathlib import Path

from scripts import bootstrap_env


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


def test_bootstrap_env_writes_all_runtime_settings_without_printing_secrets(tmp_path, monkeypatch, capsys):
    credential_file = tmp_path / "credentials.txt"
    credential_file.write_text("App ID: cli_test_app\nApp Secret: test-secret-value\n", encoding="utf-8")
    env_file = tmp_path / ".env"
    monkeypatch.setattr(bootstrap_env, "CREDENTIAL_FILE", credential_file)
    monkeypatch.setattr(bootstrap_env, "ENV_FILE", env_file)

    bootstrap_env.main()

    values = dict(
        line.split("=", 1)
        for line in env_file.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    )
    assert values["AUTO_LOGIN"] == "false"
    assert values["SENTINEL_PUBLIC_BASE_URL"] == "http://localhost:8000"
    assert values["SENTINEL_API_BASE_URL"] == "http://127.0.0.1:8000"
    assert values["SENTINEL_INTERNAL_TOKEN"]
    assert "INTERNAL_EXECUTION_TOKEN" not in values
    assert values["VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS"] == "60"
    assert values["VALIDATION_MAINTENANCE_BATCH_SIZE"] == "50"
    assert values["FEISHU_HTTP_TIMEOUT_SECONDS"] == "10"
    assert values["FEISHU_APP_ID"] == "cli_test_app"
    assert values["FEISHU_APP_SECRET"] == "test-secret-value"
    output = capsys.readouterr().out
    assert "test-secret-value" not in output
    assert values["SENTINEL_INTERNAL_TOKEN"] not in output
