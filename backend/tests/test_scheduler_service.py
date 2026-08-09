from app.config import Settings
from app.models import Rule
from app.scheduler_service import reconcile_enabled_rules, sync_rule_record


class FakeClient:
    def __init__(self, settings):
        self.settings = settings
        self.closed = False

    def sync_rule(self, rule):
        return 123456, 77

    def close(self):
        self.closed = True


def test_sync_rule_record_persists_scheduler_identifiers(db_session):
    rule = Rule(
        name="rule", dataset_id="dataset", conditions=[], anomaly_key_fields=["id"],
        schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-09"},
        notification_targets=[], enabled=True,
    )

    sync_rule_record(rule, Settings(), db_session, client_factory=FakeClient)

    assert rule.sync_status == "synced"
    assert rule.ds_workflow_code == "123456"
    assert rule.ds_schedule_id == 77
    assert rule.enabled is True


def test_reconcile_only_processes_enabled_non_deleted_rules(db_session, monkeypatch):
    active = Rule(
        name="active", dataset_id="dataset", conditions=[], anomaly_key_fields=["id"],
        schedule={}, notification_targets=[], enabled=True,
    )
    disabled = Rule(
        name="disabled", dataset_id="dataset", conditions=[], anomaly_key_fields=["id"],
        schedule={}, notification_targets=[], enabled=False,
    )
    db_session.add_all([active, disabled])
    db_session.commit()
    seen = []
    def remember(rule, *_args, **_kwargs):
        seen.append(rule.id)
        return True

    monkeypatch.setattr("app.scheduler_service.sync_rule_record", remember)

    result = reconcile_enabled_rules(db_session, Settings())

    assert seen == [active.id]
    assert result == {"total": 1, "synced": 1, "failed": 0}
