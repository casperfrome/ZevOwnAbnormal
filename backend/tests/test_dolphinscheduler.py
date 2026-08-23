import httpx
import pytest

from app.config import Settings
from app.dolphinscheduler import (
    DolphinSchedulerClient,
    DolphinSchedulerError,
    build_crontab,
    build_push_shell_task,
    build_shell_task,
)
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


def test_authenticated_call_relogs_and_replays_once_after_session_401():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if len(calls) == 1:
            return httpx.Response(401)
        if request.url.path.endswith("/login"):
            return httpx.Response(200, json={"code": 0, "data": {"sessionId": "fresh"}})
        return httpx.Response(200, json={"code": 0, "data": {"totalList": []}})

    client = DolphinSchedulerClient(
        Settings(_env_file=None), transport=httpx.MockTransport(handler),
    )

    assert client._call("GET", "/projects") == {"totalList": []}
    assert calls == [
        ("GET", "/dolphinscheduler/projects"),
        ("POST", "/dolphinscheduler/login"),
        ("GET", "/dolphinscheduler/projects"),
    ]


def test_authenticated_call_does_not_loop_when_replay_is_still_401():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path.endswith("/login"):
            return httpx.Response(200, json={"code": 0, "data": {"sessionId": "fresh"}})
        return httpx.Response(401)

    client = DolphinSchedulerClient(
        Settings(_env_file=None), transport=httpx.MockTransport(handler),
    )

    with pytest.raises(httpx.HTTPStatusError):
        client._call("GET", "/projects")
    assert calls == [
        ("GET", "/dolphinscheduler/projects"),
        ("POST", "/dolphinscheduler/login"),
        ("GET", "/dolphinscheduler/projects"),
    ]


def test_authenticated_call_does_not_recurse_when_relogin_fails():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        return httpx.Response(401)

    client = DolphinSchedulerClient(
        Settings(_env_file=None), transport=httpx.MockTransport(handler),
    )

    with pytest.raises(httpx.HTTPStatusError):
        client._call("GET", "/projects")
    assert calls == [
        ("GET", "/dolphinscheduler/projects"),
        ("POST", "/dolphinscheduler/login"),
    ]


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


def test_push_shell_task_uses_job_parameter_and_internal_token():
    task = build_push_shell_task(12345)
    script = task["taskParams"]["rawScript"]

    assert "${push_job_id}" in script
    assert "/api/internal/anomaly-pushes/" in script
    assert "$SENTINEL_INTERNAL_TOKEN" in script
    assert task["name"] == "send-anomaly-push"


def test_push_job_start_passes_only_job_id_as_start_parameter():
    client = DolphinSchedulerClient(Settings())
    calls = []
    client._push_project_code = 88
    client._push_workflow_code = 999
    client._call = lambda method, path, **kwargs: calls.append((method, path, kwargs["params"])) or {}

    client.start_push_job("job-1")

    method, path, params = calls[0]
    assert (method, path) == ("POST", "/projects/88/executors/start-workflow-instance")
    assert params["workflowDefinitionCode"] == 999
    assert params["scheduleTime"] == ""
    assert params["workflowInstancePriority"] == "MEDIUM"
    assert params["startParams"] == '{"push_job_id": "job-1"}'


def test_existing_push_workflow_is_taken_offline_and_updated():
    client = DolphinSchedulerClient(Settings())
    calls = []

    def fake_call(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params", {})))
        if method == "GET" and path.endswith("/workflow-definition"):
            return {"totalList": [{"name": "sentinel-anomaly-push", "code": 999}]}
        if method == "GET" and path.endswith("/999"):
            return {"taskDefinitionList": [{"code": 123}]}
        return {}

    client._call = fake_call
    assert client.ensure_push_workflow(88) == 999

    offline = next(i for i, call in enumerate(calls) if call[2].get("releaseState") == "OFFLINE")
    update = next(i for i, call in enumerate(calls) if call[0] == "PUT")
    online = next(i for i, call in enumerate(calls) if call[2].get("releaseState") == "ONLINE")
    assert offline < update < online
    assert "${push_job_id}" in calls[update][2]["taskDefinitionJson"]


def test_clear_push_instances_stops_then_deletes_nonterminal_instances():
    client = DolphinSchedulerClient(Settings())
    client._push_project_code = 88
    client._push_workflow_code = 999
    calls = []

    def fake_call(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params", {})))
        if method == "GET" and path.endswith("/workflow-instances"):
            return {"totalList": [{"id": 41, "processDefinitionCode": 999, "state": "RUNNING_EXECUTION"}]}
        if method == "GET" and path.endswith("/workflow-instances/41"):
            return {"id": 41, "state": "STOP"}
        return {}

    client._call = fake_call

    assert client.clear_push_instances(poll_interval=0) == (1, 1)
    stop_index = next(i for i, call in enumerate(calls) if call[0] == "POST" and call[1].endswith("/executors/execute"))
    delete_index = next(i for i, call in enumerate(calls) if call[0] == "DELETE")
    assert calls[stop_index][2]["executeType"] == "STOP"
    assert stop_index < delete_index
