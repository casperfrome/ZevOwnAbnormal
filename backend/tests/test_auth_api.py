from fastapi.testclient import TestClient

from app.main import create_app


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
