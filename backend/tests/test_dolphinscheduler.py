import httpx
import pytest

from app.config import Settings
from app.dolphinscheduler import DolphinSchedulerClient, DolphinSchedulerError, build_crontab, build_shell_task
from app.models import Rule


def test_build_crontab_for_supported_schedules():
    assert build_crontab({"frequency": "min", "interval": 5}) == "0 0/5 * * * ?"
    assert build_crontab({"frequency": "hour", "interval": 2}) == "0 0 0/2 * * ?"
    assert build_crontab({"frequency": "day", "interval": 1, "time": "09:30"}) == "0 30 9 * * ?"


def test_shell_task_uses_environment_variables_without_embedding_secret():
    task = build_shell_task(12345, "rule-id")
    script = task["taskParams"]["rawScript"]

    assert "$SENTINEL_INTERNAL_TOKEN" in script
    assert "$SENTINEL_API_BASE_URL" in script
    assert "/proc/1/environ" in script
    assert "rule-id" in script
    assert task["taskType"] == "SHELL"


def test_client_error_identifies_failing_endpoint():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"code": 100, "msg": "invalid"}))
    client = DolphinSchedulerClient(Settings(), transport=transport)
    with pytest.raises(DolphinSchedulerError, match=r"GET /projects: invalid"):
        client._call("GET", "/projects")


def test_existing_online_workflow_is_released_offline_before_update():
    client = DolphinSchedulerClient(Settings())
    calls = []

    def fake_call(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params", {})))
        if method == "GET" and path.endswith("/workflow-definition"):
            return {"totalList": [{"name": "sentinel-rule-rule-1", "code": 999}]}
        if method == "GET" and path.endswith("/999"):
            return {"taskDefinitionList": [{"code": 123}]}
        return {"code": 999}

    client._call = fake_call
    rule = Rule(id="rule-1", name="rule", description="")
    client.ensure_workflow(88, rule)

    offline_index = next(i for i, call in enumerate(calls) if call[0] == "POST" and call[2].get("releaseState") == "OFFLINE")
    update_index = next(i for i, call in enumerate(calls) if call[0] == "PUT")
    assert offline_index < update_index


def test_schedule_update_supplies_required_zero_warning_group():
    client = DolphinSchedulerClient(Settings())
    calls = []
    client._call = lambda method, path, **kwargs: calls.append((method, path, kwargs.get("params", {}))) or ({"totalList": [{"id": 7}]} if method == "GET" else {})
    rule = Rule(id="rule-1", schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-09"})

    client.ensure_schedule(88, 999, rule)

    update = next(call for call in calls if call[0] == "PUT")
    assert update[2]["warningGroupId"] == 0
