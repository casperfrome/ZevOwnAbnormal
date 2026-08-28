from fastapi.testclient import TestClient

from app.main import create_app
from app.models import Datasource


def test_datasource_password_is_write_only():
    with TestClient(create_app(testing=True)) as client:
        response = client.post(
            "/api/v1/datasources",
            json={
                "name": "订单库",
                "type": "mysql",
                "host": "localhost",
                "port": 3306,
                "database": "orders",
                "username": "reader",
                "password": "top-secret",
                "ssl": False,
            },
        )

        assert response.status_code == 201
        body = response.json()
        assert body["has_password"] is True
        assert "password" not in body

        listed = client.get("/api/v1/datasources").json()
        assert listed[0]["has_password"] is True
        assert "password" not in listed[0]


def test_referenced_datasource_cannot_be_deleted():
    with TestClient(create_app(testing=True)) as client:
        datasource = client.post(
            "/api/v1/datasources",
            json={
                "name": "ADS",
                "type": "starrocks",
                "host": "localhost",
                "port": 9030,
                "database": "tastien_ads",
                "username": "root",
                "password": "",
                "ssl": False,
            },
        ).json()
        dataset = client.post(
            "/api/v1/datasets",
            json={
                "name": "门店经营日报",
                "datasource_id": datasource["id"],
                "description": "demo",
                "sql": "SELECT store_id, metric_date, gmv FROM ads_store_daily_operation",
            },
        )

        assert dataset.status_code == 201
        response = client.delete(f"/api/v1/datasources/{datasource['id']}")
        assert response.status_code == 409


def test_dataset_rejects_mutating_sql():
    with TestClient(create_app(testing=True)) as client:
        datasource = client.post(
            "/api/v1/datasources",
            json={
                "name": "订单库",
                "type": "mysql",
                "host": "localhost",
                "port": 3306,
                "database": "orders",
                "username": "reader",
                "password": "pw",
                "ssl": False,
            },
        ).json()

        response = client.post(
            "/api/v1/datasets",
            json={"name": "bad", "datasource_id": datasource["id"], "sql": "DROP TABLE orders"},
        )

        assert response.status_code == 422


def _audit_datasource(name="source", **changes):
    return {"name": name, "type": "mysql", "host": "localhost", "port": 3306,
            "database": "app", "username": "reader", "password": "secret", **changes}


def test_datasource_dataset_names_and_patch_values_are_normalized():
    with TestClient(create_app(testing=True)) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource("  source  "))
        assert source.status_code == 201 and source.json()["name"] == "source"
        dataset = client.post("/api/v1/datasets", json={"name": "  dataset  ", "datasource_id": source.json()["id"], "sql": "SELECT 1"})
        assert dataset.status_code == 201 and dataset.json()["name"] == "dataset"
        assert client.patch(f"/api/v1/datasources/{source.json()['id']}", json={"host": None}).status_code == 422
        assert client.patch(f"/api/v1/datasets/{dataset.json()['id']}", json={"sql": None}).status_code == 422


def test_dataset_datasource_updates_validate_references_and_conflicts():
    with TestClient(create_app(testing=True)) as client:
        first = client.post("/api/v1/datasources", json=_audit_datasource("one")).json()
        second = client.post("/api/v1/datasources", json=_audit_datasource("two")).json()
        assert client.patch(f"/api/v1/datasources/{second['id']}", json={"name": "one"}).status_code == 409
        first_dataset = client.post("/api/v1/datasets", json={"name": "one-dataset", "datasource_id": first["id"], "sql": "SELECT 1"}).json()
        second_dataset = client.post("/api/v1/datasets", json={"name": "two-dataset", "datasource_id": first["id"], "sql": "SELECT 1"}).json()
        assert client.patch(f"/api/v1/datasets/{second_dataset['id']}", json={"name": "one-dataset"}).status_code == 409
        assert client.patch(f"/api/v1/datasets/{first_dataset['id']}", json={"datasource_id": "missing"}).status_code == 404


def test_dataset_execute_and_validate_reject_malformed_sql_payloads():
    with TestClient(create_app(testing=True)) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource()).json()
        assert client.post("/api/v1/datasets/execute", json={"datasource_id": source["id"], "sql": []}).status_code == 422
        assert client.post("/api/v1/datasets/validate", json={"sql": []}).status_code == 422
        assert client.post("/api/v1/datasets/validate", json={"sql": "SELECT 1 INTO audit_copy"}).status_code == 422


def test_datasource_test_preserves_saved_password_and_closes_connections(monkeypatch):
    connections = []
    class Cursor:
        def execute(self, *_args): pass
        def fetchone(self): return {"ok": 1}
        def __enter__(self): return self
        def __exit__(self, *_args): return False
    class Connection:
        def __init__(self): self.closed = False
        def cursor(self): return Cursor()
        def close(self): self.closed = True
    def connect(item, password):
        connection = Connection(); connections.append((item, password, connection)); return connection
    monkeypatch.setattr("app.api.connect_to_datasource", connect)
    with TestClient(create_app(testing=True)) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource()).json()
        assert client.post("/api/v1/datasources/test", json=_audit_datasource("check")).status_code == 200
        assert client.post("/api/v1/datasources/test", json={"datasource_id": source["id"], "host": "changed"}).status_code == 200
    assert all(connection.closed for _, _, connection in connections)
    assert connections[1][1] == "secret" and connections[1][0].host == "changed"


def test_failed_saved_datasource_test_updates_check_time_and_closes(monkeypatch):
    class Connection:
        closed = False
        def cursor(self): raise RuntimeError("bad cursor")
        def close(self): self.closed = True
    connection = Connection()
    monkeypatch.setattr("app.api.connect_to_datasource", lambda *_args: connection)
    app = create_app(testing=True)
    with TestClient(app) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource()).json()
        response = client.post(f"/api/v1/datasources/{source['id']}/test")
        with app.state.session_factory() as session:
            stored = session.get(Datasource, source["id"])
            assert stored.status == "error" and stored.last_checked is not None
    assert response.status_code == 502 and connection.closed is True


def test_dataset_execute_endpoints_close_connections(monkeypatch):
    connections = []
    class Cursor:
        description = (("value", 3),)
        def execute(self, *_args): pass
        def fetchall(self): return [{"value": 1}]
        def __enter__(self): return self
        def __exit__(self, *_args): return False
    class Connection:
        def __init__(self): self.closed = False
        def cursor(self): return Cursor()
        def close(self): self.closed = True
    def connect(*_args):
        connection = Connection(); connections.append(connection); return connection
    monkeypatch.setattr("app.api.connect_to_datasource", connect)
    with TestClient(create_app(testing=True)) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource()).json()
        dataset = client.post("/api/v1/datasets", json={"name": "close-check", "datasource_id": source["id"], "sql": "SELECT 1"}).json()
        assert client.post(f"/api/v1/datasets/{dataset['id']}/execute").status_code == 200
        assert client.post("/api/v1/datasets/execute", json={"datasource_id": source["id"], "sql": "SELECT 1"}).status_code == 200
    assert all(connection.closed for connection in connections)


def test_datasource_text_fields_enforce_database_backed_lengths_on_all_requests():
    fields = {"host": 255, "database": 150, "username": 150}
    with TestClient(create_app(testing=True)) as client:
        source = client.post("/api/v1/datasources", json=_audit_datasource()).json()
        for field, maximum in fields.items():
            oversized = "x" * (maximum + 1)
            assert client.post("/api/v1/datasources", json=_audit_datasource(f"length-{field}", **{field: oversized})).status_code == 422
            assert client.patch(f"/api/v1/datasources/{source['id']}", json={field: oversized}).status_code == 422
            assert client.post("/api/v1/datasources/test", json=_audit_datasource(**{field: oversized})).status_code == 422
            assert client.post("/api/v1/datasources/test", json={"datasource_id": source["id"], field: oversized}).status_code == 422
