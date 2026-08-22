from datetime import datetime

import pytest
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from app.api import anomaly_dict, rule_dict
from app.database import Base, make_session_factory
from app.models import (
    AnomalyRecord,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    Dataset,
    Datasource,
    Rule,
)
from app.schemas import FeishuCardActionCallback, RuleValidationConfig, ValidationTarget


def build_session():
    engine, factory = make_session_factory("sqlite+pysqlite:///:memory:", testing=True)
    Base.metadata.create_all(engine)
    session = factory()
    datasource = Datasource(
        name="validation-source", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="validation-dataset", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="validation-rule", dataset=dataset, conditions=[{"field": "gmv", "operator": "gt", "value": 1}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"}, notification_targets=[],
    )
    session.add(rule)
    session.commit()
    return engine, session, rule


def make_anomaly(rule: Rule) -> AnomalyRecord:
    return AnomalyRecord(
        rule_id=rule.id, rule_name=rule.name, dataset_name=rule.dataset.name, severity="high",
        fingerprint="f" * 64, active_fingerprint="f" * 64, business_key={"store_id": "S1"},
        row_details={"owner": "u_1"}, matched_conditions=[],
    )


def test_validation_models_persist_defaults_and_enforce_first_submission():
    """Removing validation defaults or either uniqueness constraint must fail this test."""
    engine, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.commit()

        assert rule.validation_enabled is False
        assert rule.validation_targets == []
        assert rule.validation_timeout_minutes == 1440
        assert rule.validation_method == "pseudo"
        assert rule.sql_validation_config is None
        assert anomaly.description == ""
        assert anomaly.validation_deadline is None
        assert anomaly.timed_out_at is None
        assert anomaly.resolution_source is None
        assert anomaly.resolved_by_user_id is None
        assert anomaly.validation_method_snapshot is None
        assert anomaly.validation_config_snapshot == {}

        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="u_1")
        session.add(request)
        session.commit()
        assert request.send_started_at is None
        submission = AnomalyValidationSubmission(
            anomaly_id=anomaly.id, request_id=request.id, submitted_by_user_id="u_1",
            submitted_text="accepted text", validator_type="pseudo", result="passed",
        )
        session.add(submission)
        session.commit()
        assert submission.submitted_at is not None
        assert submission.result_detail == {}

        session.add(AnomalyValidationSubmission(
            anomaly_id=anomaly.id, request_id=request.id, submitted_by_user_id="u_2",
            submitted_text="second", validator_type="pseudo", result="passed",
        ))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

        session.add(AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="u_1"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
    finally:
        session.close()
        engine.dispose()


def test_validation_schema_requires_complete_enabled_target_configuration():
    """Missing configured targets, literal values, or field names must be rejected."""
    assert RuleValidationConfig(validation_enabled=False).model_dump() == {
        "validation_enabled": False, "validation_targets": [], "validation_timeout_minutes": 1440,
        "validation_method": "pseudo", "sql_validation_config": None,
    }
    assert RuleValidationConfig(
        validation_enabled=True,
        validation_targets=[{"source": "literal", "value": " user_1 "}],
        validation_timeout_minutes=43200,
    ).validation_targets[0].value == "user_1"
    assert ValidationTarget(source="field", field="owner_id").field == "owner_id"

    for payload in (
        {"validation_enabled": True},
        {"validation_targets": [{"source": "literal"}]},
        {"validation_targets": [{"source": "field"}]},
        {"validation_timeout_minutes": 0},
        {"validation_timeout_minutes": 43201},
    ):
        with pytest.raises(ValidationError):
            RuleValidationConfig(**payload)


def test_validation_schema_enforces_exactly_one_validation_method_configuration():
    """Allowing pseudo and SQL validation configuration on one rule must fail this test."""
    sql_config = {
        "query_template": "SELECT status FROM test_table WHERE id='{目标ID}'",
        "parameters": [{"name": "目标ID", "field": "target_id"}],
        "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
    }
    configured = RuleValidationConfig(
        validation_enabled=True,
        validation_targets=[{"source": "literal", "value": "validator-1"}],
        validation_method="sql",
        sql_validation_config=sql_config,
    )
    assert configured.sql_validation_config.query_template.startswith("SELECT status")

    for payload in (
        {"validation_method": "pseudo", "sql_validation_config": sql_config},
        {"validation_method": "sql"},
        {"validation_method": "unknown"},
    ):
        with pytest.raises(ValidationError):
            RuleValidationConfig(**payload)


def test_card_action_callback_trims_submission_text_and_requires_identifiers():
    """A missing callback identifier or untrimmed accepted text must not cross the API boundary."""
    callback = FeishuCardActionCallback(
        anomaly_id="anomaly-1", operator_user_id="user-1", message_id="om_1",
        action="submit_validation", validation_text="  confirmed  ",
    )
    assert callback.validation_text == "confirmed"

    sql_callback_without_text = FeishuCardActionCallback(
        anomaly_id="anomaly-1", operator_user_id="user-1", message_id="om_1",
        action="run_sql_validation",
    )
    sql_callback_with_blank_text = FeishuCardActionCallback(
        anomaly_id="anomaly-1", operator_user_id="user-1", message_id="om_1",
        action="run_sql_validation", validation_text="   ",
    )
    assert sql_callback_without_text.validation_text == ""
    assert sql_callback_with_blank_text.validation_text == ""

    with pytest.raises(ValidationError):
        FeishuCardActionCallback(anomaly_id="anomaly-1", operator_user_id="user-1", action="submit_validation")

    with pytest.raises(ValidationError):
        FeishuCardActionCallback(
            anomaly_id="anomaly-1", operator_user_id="user-1", message_id="om_1",
            action="run_sql_validation", validation_text=123,
        )


def test_rule_and_anomaly_serializers_keep_existing_fields_and_add_validation_fields():
    """Dropping a legacy key or a validation key from either public serializer must fail this test."""
    engine, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        rule.validation_timeout_minutes = 30
        rule.validation_method = "sql"
        rule.sql_validation_config = {
            "query_template": "SELECT status FROM t WHERE id='{目标ID}'",
            "parameters": [{"name": "目标ID", "field": "store_id"}],
            "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
        }
        anomaly = make_anomaly(rule)
        anomaly.description = "GMV anomaly"
        anomaly.validation_deadline = datetime(2026, 8, 22, 10, 0, 0)
        anomaly.timed_out_at = datetime(2026, 8, 22, 10, 30, 0)
        anomaly.resolution_source = "validation"
        anomaly.resolved_by_user_id = "user-1"
        session.add(anomaly)
        session.commit()

        rule_body = rule_dict(rule)
        assert rule_body["notification_targets"] == []
        assert rule_body["validation_enabled"] is True
        assert rule_body["validation_targets"] == [{"source": "literal", "value": "user-1"}]
        assert rule_body["validation_timeout_minutes"] == 30
        assert rule_body["validation_method"] == "sql"
        assert rule_body["sql_validation_config"]["parameters"][0]["field"] == "store_id"

        anomaly_body = anomaly_dict(anomaly)
        assert anomaly_body["status"] == "pending"
        assert anomaly_body["description"] == "GMV anomaly"
        assert anomaly_body["validation_deadline"] == datetime(2026, 8, 22, 10, 0, 0)
        assert anomaly_body["timed_out_at"] == datetime(2026, 8, 22, 10, 30, 0)
        assert anomaly_body["resolution_source"] == "validation"
        assert anomaly_body["resolved_by_user_id"] == "user-1"
        assert anomaly_body["validation_method"] is None
    finally:
        session.close()
        engine.dispose()
