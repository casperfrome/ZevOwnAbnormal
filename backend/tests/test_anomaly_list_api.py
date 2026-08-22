from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import mysql

from app import api
from app.main import create_app
from app.models import AnomalyRecord


def seed_anomalies(client: TestClient) -> None:
    base = datetime(2026, 8, 22, 8, 0, 0)
    severities = ["low", "critical", "medium", "high"] * 3
    with client.app.state.session_factory() as session:
        for index, severity in enumerate(severities):
            rule_name = "Revenue check" if index == 0 else f"Rule {index:02d}"
            dataset_name = "Finance mart" if index == 1 else "Orders"
            field = "owner_id" if index == 2 else "amount"
            operator = "gt"
            actual = index
            if index == 3:
                rule_name = "Rate % check"
            elif index == 4:
                dataset_name = "under_score"
            elif index == 5:
                field = "%"
            elif index == 6:
                field = "_"
            elif index == 7:
                field = "ownerXid"
            elif index == 8:
                actual = "owner_id"
            elif index == 9:
                operator = "owner_id"
            session.add(AnomalyRecord(
                id=f"record-{index:02d}", rule_id=f"rule-{index:02d}",
                rule_name=rule_name, dataset_name=dataset_name,
                severity=severity, status="pending", description="",
                fingerprint=f"{index:064x}", active_fingerprint=f"{index:064x}",
                business_key={"order_id": index}, row_details={"amount": index},
                matched_conditions=[{"field": field, "operator": operator, "actual": actual}],
                first_seen_at=base + timedelta(minutes=index),
                last_seen_at=base + timedelta(minutes=index),
            ))
        session.commit()


def test_anomaly_sorting_is_global_before_pagination():
    with TestClient(create_app(testing=True)) as client:
        seed_anomalies(client)

        first = client.get("/api/v1/anomalies", params={
            "page": 1, "page_size": 5, "sort_key": "severity", "sort_order": "desc",
        })
        second = client.get("/api/v1/anomalies", params={
            "page": 2, "page_size": 5, "sort_key": "severity", "sort_order": "desc",
        })

    assert first.status_code == 200
    assert second.status_code == 200
    severities = [item["severity"] for item in first.json()["items"] + second.json()["items"]]
    rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    assert [rank[item] for item in severities] == sorted((rank[item] for item in severities), reverse=True)
    assert first.json()["total"] == 12


def test_anomaly_search_matches_rule_dataset_and_condition_field():
    with TestClient(create_app(testing=True)) as client:
        seed_anomalies(client)

        rule = client.get("/api/v1/anomalies", params={"search": "Revenue"})
        dataset = client.get("/api/v1/anomalies", params={"search": "Finance"})
        field = client.get("/api/v1/anomalies", params={"search": "owner_id"})

    assert [item["id"] for item in rule.json()["items"]] == ["record-00"]
    assert [item["id"] for item in dataset.json()["items"]] == ["record-01"]
    assert [item["id"] for item in field.json()["items"]] == ["record-02"]


def test_anomaly_field_search_is_exact_and_ignores_other_condition_properties():
    with TestClient(create_app(testing=True)) as client:
        seed_anomalies(client)

        response = client.get("/api/v1/anomalies", params={
            "search": "owner_id", "page": 1, "page_size": 1,
        })

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [item["id"] for item in response.json()["items"]] == ["record-02"]


def test_anomaly_search_treats_percent_and_underscore_as_literals():
    with TestClient(create_app(testing=True)) as client:
        seed_anomalies(client)

        percent = client.get("/api/v1/anomalies", params={"search": "%"})
        underscore = client.get("/api/v1/anomalies", params={"search": "_"})

    assert {item["id"] for item in percent.json()["items"]} == {"record-03", "record-05"}
    assert {item["id"] for item in underscore.json()["items"]} == {"record-04", "record-06"}
    assert percent.json()["total"] == 2
    assert underscore.json()["total"] == 2


def test_mysql_anomaly_search_compiles_json_field_only_with_bound_user_input():
    search = "owner_id' OR 1=1 --%_"
    predicate = getattr(api, "_anomaly_search_predicate", None)
    assert callable(predicate)
    statement = select(AnomalyRecord.id).where(predicate(search, "mysql"))

    compiled = statement.compile(dialect=mysql.dialect())
    sql = str(compiled)
    values = list(compiled.params.values())

    assert search not in sql
    assert "json_contains" in sql.lower()
    assert "json_extract" in sql.lower()
    assert "json_quote" in sql.lower()
    assert "matched_conditions" in sql
    assert "$[*].field" in values
    assert search in values
    assert any(value == "owner/_id' OR 1=1 --/%/_" for value in values)


def test_anomaly_sort_parameters_are_whitelisted():
    with TestClient(create_app(testing=True)) as client:
        assert client.get("/api/v1/anomalies", params={"sort_key": "description"}).status_code == 422
        assert client.get("/api/v1/anomalies", params={"sort_order": "sideways"}).status_code == 422
