import bcrypt
import jwt
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from app.config import Settings
from app.main import create_app
from app.models import User


def test_me_auto_logs_in_superadmin():
    with TestClient(create_app(testing=True)) as client:
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


def test_session_cookie_has_24_hour_claims_and_rejects_legacy_no_exp_token():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        claims = jwt.decode(login.cookies.get("sentinel_session"), app.state.settings.session_secret, algorithms=["HS256"])
        assert {"sub", "role", "iat", "exp"} <= claims.keys()
        assert claims["exp"] - claims["iat"] == 86400
        client.cookies.delete("sentinel_session")
        client.cookies.set("sentinel_session", jwt.encode({"sub": "admin", "role": "superadmin"}, app.state.settings.session_secret, algorithm="HS256"))
        assert client.get("/api/v1/auth/me").status_code == 401


def test_current_user_can_update_profile_and_credentials_while_other_session_is_revoked():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as first, TestClient(app) as second:
        assert first.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"}).status_code == 200
        assert second.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"}).status_code == 200

        profile = first.patch("/api/v1/account/profile", json={"display_name": "  沈一鸣  ", "job_title": " 数据工程师 "})
        credentials = first.patch("/api/v1/account/credentials", json={"login_name": "sentinel-admin", "password": "new-password"})

        assert profile.status_code == 200
        assert profile.json()["display_name"] == "沈一鸣"
        assert profile.json()["job_title"] == "数据工程师"
        assert credentials.status_code == 200
        assert credentials.json()["login_name"] == "sentinel-admin"
        assert first.get("/api/v1/auth/me").status_code == 200
        assert second.get("/api/v1/auth/me").status_code == 401
        assert first.post("/api/v1/auth/logout").status_code == 204
        assert first.get("/api/v1/auth/me").status_code == 401
        assert first.post("/api/v1/auth/login", json={"username": "sentinel-admin", "password": "new-password"}).status_code == 200


def test_admin_can_manage_complete_account_lifecycle_without_exposing_password_hashes():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"}).status_code == 200
        created = client.post("/api/v1/accounts", json={
            "display_name": " 王小明 ", "job_title": "分析师", "login_name": " analyst ",
            "password": "temporary", "is_superuser": False,
        })
        assert created.status_code == 201
        account_id = created.json()["id"]
        assert created.json() == {
            "id": account_id, "display_name": "王小明", "job_title": "分析师",
            "login_name": "analyst", "is_superuser": False, "is_active": True,
            "created_at": created.json()["created_at"], "updated_at": created.json()["updated_at"],
        }
        assert "password_hash" not in client.get("/api/v1/accounts").text

        updated = client.patch(f"/api/v1/accounts/{account_id}", json={
            "display_name": "王明", "job_title": "高级分析师", "is_superuser": True, "is_active": False,
        })
        assert updated.status_code == 200
        assert updated.json()["is_superuser"] is True
        assert updated.json()["is_active"] is False
        assert client.post("/api/v1/auth/login", json={"username": "analyst", "password": "temporary"}).status_code == 401

        assert client.post(f"/api/v1/accounts/{account_id}/password", json={"password": "reset"}).status_code == 204
        assert client.delete(f"/api/v1/accounts/{account_id}").status_code == 204
        assert all(item["id"] != account_id for item in client.get("/api/v1/accounts").json())


def test_account_management_rejects_duplicates_empty_passwords_and_non_admins():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"}).status_code == 200
        duplicate = client.post("/api/v1/accounts", json={
            "display_name": "Duplicate", "job_title": "", "login_name": " admin ",
            "password": "valid", "is_superuser": False,
        })
        empty_password = client.patch("/api/v1/account/credentials", json={"password": ""})
        assert duplicate.status_code == 409
        assert empty_password.status_code == 422

        with app.state.session_factory() as session:
            session.add(User(
                username="viewer", password_hash=bcrypt.hashpw(b"viewer-password", bcrypt.gensalt()).decode(),
                is_superuser=False,
            ))
            session.commit()
        client.cookies.clear()
        assert client.post("/api/v1/auth/login", json={"username": "viewer", "password": "viewer-password"}).status_code == 200
        assert client.get("/api/v1/accounts").status_code == 403


def test_admin_cannot_disable_demote_or_delete_self_or_remove_the_last_active_admin():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        admin_id = login.json()["id"]

        assert client.patch(f"/api/v1/accounts/{admin_id}", json={"is_active": False}).status_code == 409
        assert client.patch(f"/api/v1/accounts/{admin_id}", json={"is_superuser": False}).status_code == 409
        assert client.delete(f"/api/v1/accounts/{admin_id}").status_code == 409


def test_admin_editing_own_login_name_renews_the_current_session_only_for_real_changes():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        admin_id = login.json()["id"]
        original_cookie = client.cookies.get("sentinel_session")

        unchanged = client.patch(f"/api/v1/accounts/{admin_id}", json={"login_name": "admin"})
        assert unchanged.status_code == 200
        assert client.cookies.get("sentinel_session") == original_cookie

        changed = client.patch(f"/api/v1/accounts/{admin_id}", json={"login_name": "renamed-admin"})
        assert changed.status_code == 200
        assert client.cookies.get("sentinel_session") != original_cookie
        assert client.get("/api/v1/auth/me").json()["login_name"] == "renamed-admin"


def test_disabled_or_version_stale_session_is_rejected():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"})
        claims = jwt.decode(login.cookies.get("sentinel_session"), app.state.settings.session_secret, algorithms=["HS256"])
        assert claims["sub"] == login.json()["id"]
        assert claims["session_version"] == 0
        with app.state.session_factory() as session:
            user = session.get(User, login.json()["id"])
            user.session_version += 1
            session.commit()
        assert client.get("/api/v1/auth/me").status_code == 401
