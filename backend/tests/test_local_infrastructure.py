import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
import random
import json

from scripts import bootstrap_env, bootstrap_host_mysql, generate_demo_data
from scripts.local_infrastructure import load_local_infrastructure_settings


def write_env(path: Path, **values: object) -> None:
    path.write_text(
        "\n".join(f"{key}={value}" for key, value in values.items()) + "\n",
        encoding="utf-8",
    )


def test_local_infrastructure_settings_read_host_services_and_process_overrides(tmp_path):
    env_file = tmp_path / ".env"
    write_env(
        env_file,
        MYSQL_HOST="127.0.0.1",
        MYSQL_PORT=3306,
        MYSQL_ROOT_USER="root",
        MYSQL_ROOT_PASSWORD="file-root-secret",
        MYSQL_DATABASE="zev_abnormal_app",
        MYSQL_USER="sentinel_app",
        MYSQL_PASSWORD="file-app-secret",
        STARROCKS_HOST="127.0.0.1",
        STARROCKS_SQL_PORT=9030,
        STARROCKS_USER="root",
        STARROCKS_PASSWORD="",
    )

    settings = load_local_infrastructure_settings(
        env_file,
        environ={"MYSQL_ROOT_PASSWORD": "process-root-secret"},
    )

    assert settings.mysql.host == "127.0.0.1"
    assert settings.mysql.port == 3306
    assert settings.mysql.admin_user == "root"
    assert settings.mysql.admin_password == "process-root-secret"
    assert settings.mysql.database == "zev_abnormal_app"
    assert settings.mysql.app_user == "sentinel_app"
    assert settings.mysql.app_password == "file-app-secret"
    assert settings.starrocks.host == "127.0.0.1"
    assert settings.starrocks.port == 9030
    assert settings.starrocks.user == "root"
    assert settings.starrocks.password == ""


class RecordingCursor:
    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), params))

    def executemany(self, sql, params):
        self.executed.append((" ".join(sql.split()), list(params)))


class RecordingConnection:
    def __init__(self):
        self.cursor_instance = RecordingCursor()
        self.commits = 0
        self.closed = False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


def test_bootstrap_host_mysql_creates_only_project_databases_and_scoped_grants(tmp_path, monkeypatch, capsys):
    env_file = tmp_path / ".env"
    write_env(
        env_file,
        MYSQL_HOST="127.0.0.1",
        MYSQL_PORT=3306,
        MYSQL_ROOT_USER="root",
        MYSQL_ROOT_PASSWORD="admin-secret",
        MYSQL_DATABASE="zev_abnormal_app",
        MYSQL_USER="sentinel_app",
        MYSQL_PASSWORD="app-secret",
    )
    connection = RecordingConnection()
    connect_calls = []

    def connect(**kwargs):
        connect_calls.append(kwargs)
        return connection

    monkeypatch.setattr(bootstrap_host_mysql.pymysql, "connect", connect)

    bootstrap_host_mysql.bootstrap(env_file)

    assert connect_calls == [{
        "host": "127.0.0.1",
        "port": 3306,
        "user": "root",
        "password": "admin-secret",
        "charset": "utf8mb4",
        "autocommit": False,
    }]
    assert connection.cursor_instance.executed == [
        ("CREATE DATABASE IF NOT EXISTS `zev_abnormal_app` CHARACTER SET utf8mb4", None),
        ("CREATE DATABASE IF NOT EXISTS `test_260828` CHARACTER SET utf8mb4", None),
        ("CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s", ("sentinel_app", "localhost", "app-secret")),
        ("ALTER USER %s@%s IDENTIFIED BY %s", ("sentinel_app", "localhost", "app-secret")),
        ("GRANT ALL PRIVILEGES ON `zev_abnormal_app`.* TO %s@%s", ("sentinel_app", "localhost")),
        ("GRANT SELECT ON `test_260828`.* TO %s@%s", ("sentinel_app", "localhost")),
        ("CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s", ("sentinel_app", "%", "app-secret")),
        ("ALTER USER %s@%s IDENTIFIED BY %s", ("sentinel_app", "%", "app-secret")),
        ("GRANT ALL PRIVILEGES ON `zev_abnormal_app`.* TO %s@%s", ("sentinel_app", "%")),
        ("GRANT SELECT ON `test_260828`.* TO %s@%s", ("sentinel_app", "%")),
    ]
    assert connection.commits == 1
    assert connection.closed is True
    output = capsys.readouterr().out
    assert "admin-secret" not in output
    assert "app-secret" not in output


def test_demo_data_connections_use_local_environment_instead_of_hardcoded_credentials(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env"
    write_env(
        env_file,
        MYSQL_HOST="mysql.example.test",
        MYSQL_PORT=3310,
        MYSQL_ROOT_USER="local_admin",
        MYSQL_ROOT_PASSWORD="root-secret",
        MYSQL_USER="sentinel_app",
        MYSQL_PASSWORD="app-secret",
        STARROCKS_HOST="starrocks.example.test",
        STARROCKS_SQL_PORT=9040,
        STARROCKS_USER="analytics",
        STARROCKS_PASSWORD="analytics-secret",
    )
    calls = []
    monkeypatch.setattr(generate_demo_data, "ENV_FILE", env_file)
    monkeypatch.setattr(generate_demo_data.pymysql, "connect", lambda **kwargs: calls.append(kwargs) or object())

    generate_demo_data.mysql_connection(database="app", root=True)
    generate_demo_data.mysql_connection(database="tastien_prod", root=False)
    generate_demo_data.starrocks_connection(database="tastien_ads")

    assert calls == [
        {
            "host": "mysql.example.test", "port": 3310, "user": "local_admin",
            "password": "root-secret", "database": "app", "charset": "utf8mb4", "autocommit": True,
        },
        {
            "host": "mysql.example.test", "port": 3310, "user": "sentinel_app",
            "password": "app-secret", "database": "tastien_prod", "charset": "utf8mb4", "autocommit": True,
        },
        {
            "host": "starrocks.example.test", "port": 9040, "user": "analytics",
            "password": "analytics-secret", "database": "tastien_ads", "charset": "utf8mb4", "autocommit": True,
        },
    ]


def test_demo_mysql_seed_leaves_account_grants_to_host_bootstrap(monkeypatch):
    root_connection = RecordingConnection()
    app_connection = RecordingConnection()
    connections = iter((root_connection, app_connection))
    monkeypatch.setattr(
        generate_demo_data,
        "mysql_connection",
        lambda *args, **kwargs: next(connections),
    )
    args = SimpleNamespace(reset=False, stores=0, orders=0, days=30, batch_size=5000)

    generate_demo_data.seed_mysql(args, random.Random(1))

    root_sql = [statement for statement, _ in root_connection.cursor_instance.executed]
    assert root_sql == ["CREATE DATABASE IF NOT EXISTS tastien_prod CHARACTER SET utf8mb4"]
    assert all("GRANT" not in statement for statement in root_sql)


def test_bootstrap_env_preserves_existing_local_infrastructure_settings(tmp_path, monkeypatch):
    credential_file = tmp_path / "credentials.txt"
    credential_file.write_text("App ID: cli_test_app\nApp Secret: test-secret-value\n", encoding="utf-8")
    env_file = tmp_path / ".env"
    write_env(
        env_file,
        MYSQL_ROOT_PASSWORD="local-root-secret",
        MYSQL_USER="sentinel_app",
        MYSQL_PASSWORD="local-app-secret",
        DATABASE_URL="mysql+pymysql://sentinel_app:local-app-secret@127.0.0.1:3306/app?charset=utf8mb4",
        DATASOURCE_ENCRYPTION_KEY="existing-fernet-key",
        SESSION_SECRET="existing-session-secret",
        SENTINEL_DOCKER_API_BASE_URL="http://host.docker.internal:8000",
    )
    monkeypatch.setattr(bootstrap_env, "CREDENTIAL_FILE", credential_file)
    monkeypatch.setattr(bootstrap_env, "ENV_FILE", env_file)

    bootstrap_env.main()

    values = dict(
        line.split("=", 1)
        for line in env_file.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    )
    assert values["MYSQL_ROOT_PASSWORD"] == "local-root-secret"
    assert values["MYSQL_USER"] == "sentinel_app"
    assert values["MYSQL_PASSWORD"] == "local-app-secret"
    assert values["DATABASE_URL"].startswith("mysql+pymysql://sentinel_app:local-app-secret@")
    assert values["SENTINEL_DOCKER_API_BASE_URL"] == "http://host.docker.internal:8000"
    assert values["DATASOURCE_ENCRYPTION_KEY"] == "existing-fernet-key"
    assert values["SESSION_SECRET"] == "existing-session-secret"


def test_bootstrap_env_defaults_new_install_to_dedicated_mysql_user(tmp_path, monkeypatch):
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
    assert values["MYSQL_USER"] == "sentinel_app"
    assert values["DATABASE_URL"] == (
        "mysql+pymysql://sentinel_app:dev_app_password@127.0.0.1:3306/zev_abnormal_app?charset=utf8mb4"
    )


def test_local_infrastructure_scripts_can_be_loaded_as_direct_entrypoints():
    backend = Path(__file__).resolve().parents[1]

    for script_name in ("bootstrap_host_mysql.py", "generate_demo_data.py"):
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                (
                    "import runpy; "
                    f"runpy.run_path(r'{backend / 'scripts' / script_name}', run_name='not_main')"
                ),
            ],
            cwd=backend,
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0, result.stderr


def test_compose_uses_renamed_project_mysql_and_existing_infrastructure_volumes():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        cwd=root, capture_output=True, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    assert config["name"] == "zev-own-abnormal"
    assert "mysql" in config["services"]
    assert config["volumes"]["mysql-data"]["name"] == "zev-own-abnormal_mysql-data"
    assert config["volumes"]["kafka-data"]["name"] == "local-data-infra_kafka-data"
    assert config["volumes"]["kafka-data"]["external"] is True
    assert config["volumes"]["starrocks-fe-meta"]["name"] == "local-data-infra_starrocks-fe-meta"
