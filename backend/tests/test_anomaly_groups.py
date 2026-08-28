from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.anomaly_group_service import (
    GroupWebhookDeliveryError,
    GroupWebhookDeliveryUncertainError,
    create_anomaly_group,
    deliver_group_broadcasts,
)
from app.anomaly_service import persist_matches
from app.config import Settings
from app.models import (
    AnomalyGroupBroadcastDelivery,
    AnomalyEvent,
    AnomalyPushJob,
    AnomalyRecordGroup,
    AnomalyRecordGroupMember,
    Dataset,
    Datasource,
    Rule,
    RuleRun,
)
from app.rule_engine import EvaluationMatch
from app.main import create_app
from app.push_pipeline import (
    abort_pending_pushes,
    execute_push_job,
    queue_due_group_broadcast_push_jobs,
    reconcile_completed_push_jobs,
)


DETECTED_AT = datetime(2026, 8, 23, 9, 30, 0)


def _group_rule(session, settings, *, mention_targets):
    datasource = Datasource(
        name="group-ads", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(
        name="group-daily", datasource=datasource, sql="SELECT 1",
        fields=[
            {"name": "store_id", "type": "INTEGER"},
            {"name": "gmv", "type": "DECIMAL"},
            {"name": "owner_user_id", "type": "VARCHAR"},
        ],
    )
    rule = Rule(
        name="群播规则", dataset=dataset, severity="high", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 1}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[
            {"receive_id_type": "open_id", "source": "literal", "value": "ordinary-target"},
        ],
        group_broadcast_enabled=True,
        group_webhook_url=(
            "https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555"
        ),
        group_mention_targets=mention_targets,
    )
    session.add(rule)
    session.commit()
    return rule


def _matches(count):
    return [
        EvaluationMatch(
            row={"store_id": index, "gmv": 99, "owner_user_id": f"owner-{index % 2}"},
            business_key={"store_id": index},
            matched_conditions=[{"field": "gmv", "operator": "gt", "actual": 99}],
        )
        for index in range(count)
    ]


def test_group_creation_deduplicates_members_chunks_messages_and_mentions_first_part(db_session):
    """A missing member, wrong chunk boundary, or repeated mentions must fail this test."""
    settings = Settings(_env_file=None, sentinel_public_base_url="https://sentinel.example")
    rule = _group_rule(db_session, settings, mention_targets=[
        {"source": "literal", "value": "fixed-user"},
        {"source": "field", "field": "owner_user_id"},
    ])
    matches = _matches(21)
    persisted = persist_matches(db_session, rule, matches + [matches[0]])
    run = RuleRun(
        id="run-group-1", rule_id=rule.id, trigger_source="manual", status="success",
        scanned_rows=22, matched_rows=22, new_anomalies=persisted.new_count,
        started_at=DETECTED_AT, finished_at=DETECTED_AT,
    )
    db_session.add(run)
    db_session.commit()

    group = create_anomaly_group(
        db_session, settings, rule, run, persisted.records, matches + [matches[0]],
    )
    db_session.commit()

    assert group.rule_id == rule.id
    assert group.detected_at == DETECTED_AT
    assert group.run_id == "run-group-1"
    assert len(list(db_session.scalars(select(AnomalyRecordGroupMember)))) == 21
    deliveries = list(db_session.scalars(
        select(AnomalyGroupBroadcastDelivery).order_by(AnomalyGroupBroadcastDelivery.part_index)
    ))
    assert [(item.part_index, item.total_parts) for item in deliveries] == [(1, 2), (2, 2)]
    first_lines = deliveries[0].payload["content"]["post"]["zh-CN"]["content"]
    second_lines = deliveries[1].payload["content"]["post"]["zh-CN"]["content"]
    assert [node["user_id"] for line in first_lines for node in line if node.get("tag") == "at"] == [
        "fixed-user", "owner-0", "owner-1",
    ]
    assert not [node for line in second_lines for node in line if node.get("tag") == "at"]
    assert sum(
        node.get("href", "").startswith("https://sentinel.example/#records/")
        for delivery in deliveries
        for line in delivery.payload["content"]["post"]["zh-CN"]["content"]
        for node in line
    ) == 21
    assert len(list(db_session.scalars(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    )))) == 2


def test_custom_group_template_renders_each_chunk_list_and_keeps_first_part_mentions(db_session):
    """Aggregating all chunks together or losing rich links and mentions must fail."""
    settings = Settings(_env_file=None, sentinel_public_base_url="https://sentinel.example")
    rule = _group_rule(
        db_session, settings,
        mention_targets=[{"source": "literal", "value": "fixed-user"}],
    )
    rule.group_message_template = (
        "异常记录组：{store_id列表}\n"
        "[查看记录组]({异常记录组链接})\n"
        "[值班手册](https://docs.example/on-call)"
    )
    matches = _matches(21)
    persisted = persist_matches(db_session, rule, matches)
    run = RuleRun(
        id="run-template", rule_id=rule.id, trigger_source="manual", status="success",
        scanned_rows=21, matched_rows=21, new_anomalies=persisted.new_count,
        started_at=DETECTED_AT, finished_at=DETECTED_AT,
    )
    db_session.add(run)
    db_session.commit()

    create_anomaly_group(db_session, settings, rule, run, persisted.records, matches)
    db_session.commit()
    deliveries = list(db_session.scalars(
        select(AnomalyGroupBroadcastDelivery).order_by(AnomalyGroupBroadcastDelivery.part_index)
    ))

    assert len(deliveries) == 2
    first = deliveries[0].payload["content"]["post"]["zh-CN"]["content"]
    second = deliveries[1].payload["content"]["post"]["zh-CN"]["content"]
    assert first[0] == [{"tag": "text", "text": "异常记录组：0、1、2、3、4、5、6、7、8、9、10、11、12、13、14、15、16、17、18、19"}]
    assert second[0] == [{"tag": "text", "text": "异常记录组：20"}]
    assert first[1] == [{
        "tag": "a", "text": "查看记录组",
        "href": "https://sentinel.example/#anomaly-groups/run-template",
    }]
    assert first[2] == [{
        "tag": "a", "text": "值班手册", "href": "https://docs.example/on-call",
    }]
    assert [node["user_id"] for line in first for node in line if node.get("tag") == "at"] == [
        "fixed-user",
    ]
    assert not [node for line in second for node in line if node.get("tag") == "at"]


def test_zero_match_group_is_retained_without_broadcast(db_session):
    settings = Settings(_env_file=None, sentinel_public_base_url="https://sentinel.example")
    rule = _group_rule(
        db_session, settings,
        mention_targets=[{"source": "field", "field": "owner_user_id"}],
    )
    run = RuleRun(
        id="run-empty", rule_id=rule.id, trigger_source="dolphinscheduler", status="success",
        scanned_rows=10, matched_rows=0, new_anomalies=0,
        started_at=DETECTED_AT, finished_at=DETECTED_AT,
    )
    db_session.add(run)
    db_session.commit()

    group = create_anomaly_group(db_session, settings, rule, run, [], [])
    db_session.commit()
    delivery = db_session.scalar(select(AnomalyGroupBroadcastDelivery))

    assert isinstance(group, AnomalyRecordGroup)
    assert delivery is None


def _empty_group_delivery(session, settings):
    rule = _group_rule(
        session, settings,
        mention_targets=[{"source": "literal", "value": "owner"}],
    )
    run = RuleRun(
        id="run-delivery", rule_id=rule.id, trigger_source="manual", status="success",
        scanned_rows=1, matched_rows=1, new_anomalies=1,
        started_at=DETECTED_AT, finished_at=DETECTED_AT,
    )
    session.add(run)
    session.commit()
    matches = _matches(1)
    from app.models import AnomalyRecord
    record = AnomalyRecord(rule_id=rule.id, rule_name=rule.name, dataset_name=rule.dataset.name,
        severity="high", fingerprint="f" * 64, active_fingerprint="f" * 64,
        business_key={"store_id": 0}, row_details=matches[0].row, matched_conditions=[])
    session.add(record)
    session.flush()
    create_anomaly_group(session, settings, rule, run, [record], matches)
    session.commit()
    return session.scalar(select(AnomalyGroupBroadcastDelivery))


def test_only_new_members_get_situation_and_timeout_broadcasts(db_session):
    from datetime import timedelta
    from app.anomaly_group_service import queue_due_timeout_broadcasts
    from app.api import _group_summaries
    from app.models import AnomalyRecord
    settings = Settings(_env_file=None, sentinel_public_base_url="https://sentinel.example")
    rule = _group_rule(db_session, settings, mention_targets=[])
    rule.validation_enabled = True
    rule.validation_targets = [{"source": "field", "field": "owner_user_id"}]
    rule.timeout_broadcast_enabled = True
    rule.timeout_mention_targets = [{"source": "literal", "value": "supervisor"}]
    rule.timeout_message_template = "超时记录：{store_id列表}"
    db_session.commit()
    matches = _matches(22)
    persisted = persist_matches(db_session, rule, matches)
    first_run = RuleRun(rule_id=rule.id, trigger_source="manual", status="success", started_at=DETECTED_AT,
                        scanned_rows=22, matched_rows=22, new_anomalies=22)
    db_session.add(first_run)
    db_session.flush()
    group = create_anomaly_group(db_session, settings, rule, first_run, persisted.records, matches,
                                 new_record_ids=persisted.new_record_ids)
    second = persist_matches(db_session, rule, matches)
    second_run = RuleRun(rule_id=rule.id, trigger_source="manual", status="success",
                         started_at=DETECTED_AT + timedelta(minutes=1), scanned_rows=22, matched_rows=22, new_anomalies=0)
    db_session.add(second_run)
    db_session.flush()
    second_group = create_anomaly_group(db_session, settings, rule, second_run, second.records, matches,
                                        new_record_ids=second.new_record_ids)
    # Changing a rule must not retarget already-created timeout obligations.
    rule.timeout_mention_targets = [{"source": "literal", "value": "new-supervisor"}]
    rule.timeout_message_template = "CHANGED"
    records = list(db_session.scalars(select(AnomalyRecord).order_by(AnomalyRecord.id)))
    records[0].status = "resolved"
    deadline = records[1].validation_deadline
    db_session.commit()
    assert _group_summaries(db_session, [group])[0]["timeout_broadcast_status"] == "waiting"
    assert queue_due_timeout_broadcasts(db_session, settings, now=deadline - timedelta(seconds=1), limit=1) == 0
    assert queue_due_timeout_broadcasts(db_session, settings, now=deadline, limit=1) == 1
    assert queue_due_timeout_broadcasts(db_session, settings, now=deadline, limit=1) == 0
    timeouts = list(db_session.scalars(select(AnomalyGroupBroadcastDelivery).where(
        AnomalyGroupBroadcastDelivery.broadcast_kind == "timeout").order_by(AnomalyGroupBroadcastDelivery.part_index)))
    assert len(timeouts) == 2
    assert all(item.detected_at == DETECTED_AT for item in timeouts)
    nodes = [node for line in timeouts[0].payload["content"]["post"]["zh-CN"]["content"] for node in line]
    assert {node["user_id"] for node in nodes if node.get("tag") == "at"} == {"owner-0", "owner-1", "supervisor"}
    assert "超时记录" in str(timeouts[0].payload)
    assert sum(record.status == "timed_out" for record in records) == 21
    assert len(list(db_session.scalars(select(AnomalyGroupBroadcastDelivery)))) == 4
    assert _group_summaries(db_session, [second_group])[0]["situation_broadcast_status"] == "skipped"


def test_repeated_detections_at_identical_time_keep_independent_batches(db_session, monkeypatch):
    from datetime import timedelta
    from app.anomaly_group_service import queue_due_timeout_broadcasts
    from app.models import AnomalyValidationRequest

    settings = Settings(_env_file=None)
    rule = _group_rule(db_session, settings, mention_targets=[])
    rule.repeat_push_enabled = True
    rule.validation_enabled = True
    rule.validation_targets = [{"source": "literal", "value": "handler"}]
    rule.timeout_broadcast_enabled = True
    db_session.commit()
    monkeypatch.setattr("app.anomaly_service.utcnow", lambda: DETECTED_AT)
    groups = []
    for index in range(3):
        matches = _matches(1)
        persisted = persist_matches(db_session, rule, matches, commit=False)
        run = RuleRun(id=f"same-time-{index}", rule_id=rule.id, trigger_source="manual", status="success",
                      scanned_rows=1, matched_rows=1, new_anomalies=1, started_at=DETECTED_AT)
        db_session.add(run)
        groups.append(create_anomaly_group(db_session, settings, rule, run, persisted.records, matches,
                                          new_record_ids=persisted.new_record_ids))
        db_session.commit()
        assert run.started_at == DETECTED_AT
        assert persisted.records[0].first_seen_at == DETECTED_AT
    assert len({group.detected_at for group in groups}) == 3
    assert len(list(db_session.scalars(select(AnomalyValidationRequest)))) == 3
    assert queue_due_timeout_broadcasts(db_session, settings, now=DETECTED_AT + timedelta(days=2)) == 3
    deliveries = list(db_session.scalars(select(AnomalyGroupBroadcastDelivery)))
    assert len(deliveries) == 6
    assert {(delivery.detected_at, delivery.broadcast_kind) for delivery in deliveries} == {
        (group.detected_at, kind) for group in groups for kind in ("situation", "timeout")
    }


def test_timeout_scan_observes_abort_between_groups_without_consuming_second_group(db_session):
    from datetime import timedelta
    from sqlalchemy import update
    from sqlalchemy.orm import Session
    from app.anomaly_group_service import queue_due_timeout_broadcasts
    from app.models import AnomalyPushPipelineState, utcnow
    settings = Settings(_env_file=None)
    rule = _group_rule(db_session, settings, mention_targets=[])
    rule.group_broadcast_enabled = False
    rule.repeat_push_enabled = True
    rule.validation_enabled = True
    rule.validation_targets = [{"source": "literal", "value": "handler"}]
    rule.timeout_broadcast_enabled = True
    db_session.commit()
    groups = []
    for index in range(2):
        matches = _matches(1)
        persisted = persist_matches(db_session, rule, matches)
        run = RuleRun(rule_id=rule.id, trigger_source="manual", started_at=DETECTED_AT + timedelta(minutes=index),
                      status="success", scanned_rows=1, matched_rows=1, new_anomalies=1)
        db_session.add(run)
        db_session.flush()
        groups.append(create_anomaly_group(db_session, settings, rule, run, persisted.records, matches,
                                           new_record_ids=persisted.new_record_ids))
        db_session.commit()
    pipeline = db_session.get(AnomalyPushPipelineState, 1)
    assert pipeline.generation == 1
    calls = 0
    def should_stop():
        nonlocal calls
        calls += 1
        if calls == 2:
            with Session(db_session.get_bind()) as another:
                another.execute(update(AnomalyPushPipelineState).values(generation=2, abort_in_progress=True))
                another.commit()
        return False
    assert queue_due_timeout_broadcasts(db_session, settings, now=utcnow() + timedelta(days=2),
                                        should_stop=should_stop) == 1
    db_session.refresh(groups[1])
    assert groups[1].timeout_processed_at is None
    assert len(list(db_session.scalars(select(AnomalyGroupBroadcastDelivery)))) == 1


def test_group_webhook_delivery_validates_feishu_response_and_marks_success(db_session):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, json={"code": 0, "msg": "success"}, request=request,
    ))

    failures = deliver_group_broadcasts(
        db_session, settings, [delivery.id], transport=transport,
    )

    assert failures == 0
    assert delivery.status == "sent"
    assert delivery.attempts == 1
    assert delivery.delivered_at is not None


def test_group_webhook_read_failure_becomes_terminal_uncertain_without_secret_leak(db_session):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)

    def lose_response(request):
        raise httpx.ReadTimeout("response lost", request=request)

    with pytest.raises(GroupWebhookDeliveryUncertainError, match="发送结果未知") as caught:
        deliver_group_broadcasts(
            db_session, settings, [delivery.id], transport=httpx.MockTransport(lose_response),
        )

    assert delivery.status == "uncertain"
    assert delivery.attempts == 1
    assert "open.feishu.cn" not in str(caught.value)


def test_group_webhook_business_rejection_is_retryable_failure(db_session):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, json={"code": 19001, "msg": "invalid signature"}, request=request,
    ))

    with pytest.raises(GroupWebhookDeliveryError, match="飞书拒绝"):
        deliver_group_broadcasts(db_session, settings, [delivery.id], transport=transport)

    assert delivery.status == "failed"
    assert delivery.attempts == 1


def test_push_pipeline_dispatches_group_jobs_and_marks_them_sent(db_session, monkeypatch):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    ))

    def deliver(session, _settings, delivery_ids):
        assert delivery_ids == [delivery.id]
        delivery.status = "sent"
        session.commit()
        return 0

    monkeypatch.setattr("app.push_pipeline.deliver_group_broadcasts", deliver)

    assert execute_push_job(db_session, settings, job.id) == "sent"
    assert job.status == "sent"


def test_uncertain_group_job_is_terminal_and_never_requeued(db_session, monkeypatch):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    ))

    def uncertain(session, _settings, delivery_ids):
        assert delivery_ids == [delivery.id]
        delivery.status = "uncertain"
        delivery.last_error = "飞书 webhook 发送结果未知"
        session.commit()
        raise GroupWebhookDeliveryUncertainError(delivery.last_error)

    monkeypatch.setattr("app.push_pipeline.deliver_group_broadcasts", uncertain)

    with pytest.raises(GroupWebhookDeliveryUncertainError):
        execute_push_job(db_session, settings, job.id)
    db_session.refresh(job)
    assert job.status == "uncertain"
    uncertainty_reason = job.last_error
    assert execute_push_job(db_session, settings, job.id) == "already_terminal"
    assert queue_due_group_broadcast_push_jobs(db_session) == 0
    assert reconcile_completed_push_jobs(db_session) == 0
    db_session.refresh(job)
    assert job.last_error == uncertainty_reason


def test_failed_group_job_is_requeued_when_due(db_session, monkeypatch):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    ))

    def rejected(session, _settings, delivery_ids):
        assert delivery_ids == [delivery.id]
        delivery.status = "failed"
        delivery.attempts = 1
        delivery.last_error = "飞书拒绝群聊播报"
        session.commit()
        raise GroupWebhookDeliveryError(delivery.last_error)

    monkeypatch.setattr("app.push_pipeline.deliver_group_broadcasts", rejected)

    with pytest.raises(GroupWebhookDeliveryError):
        execute_push_job(db_session, settings, job.id)
    db_session.refresh(job)
    assert job.status == "failed"
    assert job.next_attempt_at is not None
    job.next_attempt_at = datetime(2020, 1, 1)
    db_session.commit()

    assert queue_due_group_broadcast_push_jobs(db_session) == 1
    assert job.status == "pending_publish"


def test_scheduler_failure_requeues_group_job_while_delivery_is_still_pending(db_session):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    ))
    job.status = "failed"
    job.next_attempt_at = datetime(2020, 1, 1)
    job.last_error = "401 Unauthorized"
    db_session.commit()

    assert delivery.status == "pending"
    assert queue_due_group_broadcast_push_jobs(db_session) == 1
    assert job.status == "pending_publish"


def test_member_anomaly_detail_includes_group_broadcast_push_diagnostics():
    app = create_app(testing=True)
    with TestClient(app) as client:
        with app.state.session_factory() as session:
            settings = app.state.settings
            rule = _group_rule(session, settings, mention_targets=[])
            matches = _matches(1)
            persisted = persist_matches(session, rule, matches)
            run = RuleRun(
                id="run-detail-diagnostics", rule_id=rule.id,
                trigger_source="manual", status="success",
                scanned_rows=1, matched_rows=1, new_anomalies=1,
                started_at=DETECTED_AT, finished_at=DETECTED_AT,
            )
            session.add(run)
            session.commit()
            create_anomaly_group(session, settings, rule, run, persisted.records, matches)
            session.commit()
            anomaly_id = persisted.records[0].id
            group_job = session.scalar(select(AnomalyPushJob).where(
                AnomalyPushJob.kind == "group_broadcast"
            ))
            group_job.status = "failed"
            group_job.last_error = "401 Unauthorized"
            session.commit()
            group_job_id = group_job.id

        detail = client.get(f"/api/v1/anomalies/{anomaly_id}")

    assert detail.status_code == 200
    diagnostics = {job["id"]: job for job in detail.json()["push_jobs"]}
    assert diagnostics[group_job_id]["kind"] == "group_broadcast"
    assert diagnostics[group_job_id]["last_error"] == "401 Unauthorized"


def test_abort_counts_group_broadcast_without_creating_anomaly_event(db_session):
    settings = Settings(_env_file=None)
    delivery = _empty_group_delivery(db_session, settings)
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "group_broadcast"
    ))

    result = abort_pending_pushes(
        db_session, settings,
        type("Admin", (), {"clear_pending": lambda self: 1})(),
        type("Scheduler", (), {"clear_push_instances": lambda self: (0, 0)})(),
        wait_seconds=0,
    )

    assert result["aborted_group_broadcasts"] == 1
    assert result["aborted_jobs"] == 1
    assert (job.status, delivery.status) == ("aborted", "aborted")
    assert list(db_session.scalars(select(AnomalyEvent))) == []


def test_group_list_and_detail_return_live_status_counts_pagination_and_partial_delivery():
    """Stale record snapshots or an incorrect part aggregate must fail this API test."""
    with TestClient(create_app(testing=True)) as client:
        settings = client.app.state.settings
        with client.app.state.session_factory() as session:
            rule = _group_rule(session, settings, mention_targets=[
                {"source": "literal", "value": "owner"},
            ])
            matches = _matches(2)
            persisted = persist_matches(session, rule, matches)
            persisted.records[1].status = "resolved"
            run = RuleRun(
                id="run-api", rule_id=rule.id, trigger_source="manual", status="success",
                scanned_rows=3, matched_rows=2, new_anomalies=2,
                started_at=DETECTED_AT, finished_at=DETECTED_AT,
            )
            session.add(run)
            session.commit()
            group = create_anomaly_group(session, settings, rule, run, persisted.records, matches)
            session.flush()
            first_delivery = session.scalar(select(AnomalyGroupBroadcastDelivery))
            first_delivery_id = first_delivery.id
            first_delivery.status = "failed"
            session.add(AnomalyGroupBroadcastDelivery(
                rule_id=group.rule_id,
                detected_at=group.detected_at,
                part_index=2,
                total_parts=2,
                webhook_url=rule.group_webhook_url,
                payload={"msg_type": "post", "content": {}},
                status="sent",
            ))
            session.commit()

        listed = client.get("/api/v1/anomaly-groups", params={"search": "群播规则"})
        assert listed.status_code == 200
        assert listed.json()["total"] == 1
        summary = listed.json()["items"][0]
        assert summary["group_id"] == "run-api"
        assert summary["status_counts"] == {
            "pending": 1, "processing": 0, "timed_out": 0, "resolved": 1,
        }
        assert summary["broadcast_status"] == "partial_failed"

        detail = client.get("/api/v1/anomaly-groups/run-api", params={"page": 1, "page_size": 1})
        assert detail.status_code == 200
        body = detail.json()
        assert body["group"]["rule_name"] == "群播规则"
        assert body["total"] == 2
        assert body["page_size"] == 1
        assert body["items"][0]["status"] == "pending"
        assert body["items"][0]["id"]

        with client.app.state.session_factory() as session:
            failed_delivery = session.get(AnomalyGroupBroadcastDelivery, first_delivery_id)
            failed_delivery.status = "aborted"
            session.commit()
        aborted_mix = client.get("/api/v1/anomaly-groups/run-api")
        assert aborted_mix.json()["group"]["broadcast_status"] == "partial_failed"

        assert client.get("/api/v1/anomaly-groups/missing").status_code == 404
