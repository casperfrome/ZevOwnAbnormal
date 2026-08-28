from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app import api
from app.main import create_app
from app.models import AnomalyRecord, Dataset, Datasource, Rule


def _seed_overview(app):
    with app.state.session_factory() as session:
        source = Datasource(name="overview-source", type="mysql", host="h", port=1, database="d", username="u")
        session.add(source); session.flush()
        dataset = Dataset(name="overview-dataset", datasource_id=source.id, sql="SELECT 1")
        session.add(dataset); session.flush()
        rule = Rule(name="overview-rule", dataset_id=dataset.id, conditions=[], anomaly_key_fields=[], schedule={}, notification_targets=[], enabled=True)
        session.add(rule); session.flush()
        base = datetime(2026, 8, 20, 18, tzinfo=timezone.utc).replace(tzinfo=None)
        for index, seen in enumerate((base, base + timedelta(days=2))):
            session.add(AnomalyRecord(
                id=f"overview-{index}", rule_id=rule.id, rule_name=rule.name, dataset_name=dataset.name,
                severity="high", status="pending", description="", fingerprint=str(index) * 64,
                active_fingerprint=str(index) * 64, business_key={}, row_details={}, matched_conditions=[],
                first_seen_at=seen, last_seen_at=seen,
            ))
        session.commit()


def test_overview_has_beijing_zero_filled_trend_and_limited_rankings(monkeypatch):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 8, 28, 12, tzinfo=tz)

    monkeypatch.setattr(api, "datetime", FrozenDatetime)
    app = create_app(testing=True)
    with TestClient(app) as client:
        empty = client.get("/api/v1/overview")
        assert empty.status_code == 200
        assert empty.json()["days"] == 14 and len(empty.json()["trend"]) == 14
        assert all(point["count"] == 0 for point in empty.json()["trend"])
        _seed_overview(app)
        response = client.get("/api/v1/overview", params={"days": 14})
        thirty = client.get("/api/v1/overview", params={"days": 30})
        ninety = client.get("/api/v1/overview", params={"days": 90})
        unsupported = client.get("/api/v1/overview", params={"days": 7})
    assert response.status_code == 200
    body = response.json()
    assert body["timezone"] == "Asia/Shanghai" and body["days"] == 14
    assert body["trend"] == sorted(body["trend"], key=lambda point: point["date"])
    assert any(point["count"] == 0 for point in body["trend"])
    assert {point["date"]: point["count"] for point in body["trend"]}["2026-08-21"] == 1
    assert {point["date"]: point["count"] for point in body["trend"]}["2026-08-23"] == 1
    assert len(thirty.json()["trend"]) == 30 and len(ninety.json()["trend"]) == 90
    assert unsupported.status_code == 422
    assert body["top_rules"] == [{"id": body["top_rules"][0]["id"], "name": "overview-rule", "dataset_name": "overview-dataset", "anomaly_count": 2}]


def test_overview_days_openapi_contract_uses_numeric_literal_values():
    app = create_app(testing=True)
    parameter = next(
        parameter for parameter in app.openapi()["paths"]["/api/v1/overview"]["get"]["parameters"]
        if parameter["name"] == "days"
    )
    assert parameter["schema"] == {"enum": [14, 30, 90], "type": "integer", "default": 14, "title": "Days"}
