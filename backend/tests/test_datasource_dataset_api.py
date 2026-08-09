from fastapi.testclient import TestClient

from app.main import create_app


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
