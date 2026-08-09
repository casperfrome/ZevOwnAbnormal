import pytest
from sqlalchemy import select

from app.config import Settings
from app.execution_service import execute_rule
from app.models import Dataset, Datasource, Rule, RuleRun


def test_same_rule_cannot_start_while_database_lock_is_held(db_session, monkeypatch):
    datasource = Datasource(
        name="ADS", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="daily", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="GMV3500", dataset=dataset, severity="medium", logic="AND",
        conditions=[{"field": "gmv", "operator": "lt", "value": 3500}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
    )
    db_session.add(rule)
    db_session.commit()
    monkeypatch.setattr("app.execution_service._acquire_rule_lock", lambda *_args: False, raising=False)

    with pytest.raises(ValueError, match="正在执行"):
        execute_rule(db_session, Settings(), rule.id, "manual")

    assert list(db_session.scalars(select(RuleRun))) == []
