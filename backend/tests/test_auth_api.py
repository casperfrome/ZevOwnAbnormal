import bcrypt
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from app.config import Settings
from app.main import create_app
from app.models import User


def test_me_auto_logs_in_superadmin():
    client = TestClient(create_app(testing=True))

    response = client.get("/api/v1/auth/me")

    assert response.status_code == 200
    assert response.json()["username"] == "admin"
    assert response.json()["is_superuser"] is True
    assert response.cookies.get("sentinel_session")


def test_login_accepts_seeded_admin_and_rejects_wrong_password():
    with TestClient(create_app(testing=True)) as client:
        ok = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        wrong = client.post("/api/v1/auth/login", json={"username": "admin", "password": "wrong"})

    assert ok.status_code == 200
    assert ok.cookies.get("sentinel_session")
    assert wrong.status_code == 401


def test_me_validates_a_login_cookie_against_the_current_persistent_user_when_auto_login_is_off():
    app = create_app(testing=True)
    app.state.settings.auto_login = False

    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        me = client.get("/api/v1/auth/me")
        with app.state.session_factory() as session:
            user = session.scalar(select(User).where(User.username == "admin"))
            session.delete(user)
            session.commit()
        deleted = client.get("/api/v1/auth/me")

    assert login.status_code == 200
    assert me.status_code == 200
    assert me.json()["username"] == "admin"
    assert me.json()["is_superuser"] is True
    assert deleted.status_code == 401


def test_me_rejects_a_tampered_cookie_when_auto_login_is_off():
    app = create_app(testing=True)
    app.state.settings.auto_login = False

    with TestClient(app) as client:
        client.cookies.set("sentinel_session", "not-a-signed-jwt")
        response = client.get("/api/v1/auth/me")

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("delete", "/api/v1/datasources/missing", None),
        ("delete", "/api/v1/datasets/missing", None),
        ("delete", "/api/v1/rules/missing", None),
        ("post", "/api/v1/rules/missing/execute", None),
        ("patch", "/api/v1/anomalies/missing/status", {"status": "resolved"}),
    ],
)
def test_management_mutations_require_an_authenticated_admin_when_auto_login_is_off(method, path, body):
    app = create_app(testing=True)
    app.state.settings.auto_login = False

    with TestClient(app) as client:
        response = client.request(method, path, json=body)

    assert response.status_code == 401


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/datasources",
        "/api/v1/datasources/missing",
        "/api/v1/datasets",
        "/api/v1/datasets/missing",
        "/api/v1/rules",
        "/api/v1/rules/missing",
        "/api/v1/rule-runs/missing",
        "/api/v1/anomalies",
        "/api/v1/anomalies/export",
        "/api/v1/anomalies/missing",
        "/api/v1/overview",
    ],
)
def test_sensitive_management_reads_require_authentication(path):
    app = create_app(testing=True)
    app.state.settings.auto_login = False

    with TestClient(app) as client:
        response = client.get(path)

    assert response.status_code == 401


def test_non_superuser_session_can_read_me_but_cannot_mutate_management_data():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        with app.state.session_factory() as session:
            session.add(User(
                username="viewer",
                password_hash=bcrypt.hashpw(b"viewer-password", bcrypt.gensalt()).decode(),
                is_superuser=False,
            ))
            session.commit()
        assert client.post(
            "/api/v1/auth/login", json={"username": "viewer", "password": "viewer-password"},
        ).status_code == 200

        me = client.get("/api/v1/auth/me")
        reads = [
            client.get("/api/v1/datasources"),
            client.get("/api/v1/datasets"),
            client.get("/api/v1/rules"),
            client.get("/api/v1/anomalies"),
            client.get("/api/v1/anomalies/export"),
            client.get("/api/v1/overview"),
        ]
        mutation = client.delete("/api/v1/rules/missing")

    assert me.status_code == 200
    assert me.json()["username"] == "viewer"
    assert me.json()["is_superuser"] is False
    assert [response.status_code for response in reads] == [200] * len(reads)
    assert mutation.status_code == 403


def test_authenticated_admin_can_reach_a_protected_write_handler():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        assert client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "Admin@123456"},
        ).status_code == 200

        response = client.delete("/api/v1/rules/missing")

    assert response.status_code == 404


def test_production_settings_disable_auto_login_by_default(monkeypatch):
    monkeypatch.delenv("AUTO_LOGIN", raising=False)

    assert Settings(_env_file=None).auto_login is False
