from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings
from .models import Rule


class DolphinSchedulerError(RuntimeError):
    pass


def build_crontab(schedule: dict) -> str:
    frequency = schedule["frequency"]
    interval = int(schedule.get("interval", 1))
    if frequency == "min":
        return f"0 0/{interval} * * * ?"
    if frequency == "hour":
        return f"0 0 0/{interval} * * ?"
    hour, minute = (schedule.get("time") or "00:00").split(":")
    return f"0 {int(minute)} {int(hour)} * * ?"


def build_shell_task(task_code: int, rule_id: str) -> dict[str, Any]:
    script = (
        "export SENTINEL_API_BASE_URL=\"$(tr '\\0' '\\n' </proc/1/environ | sed -n 's/^SENTINEL_API_BASE_URL=//p')\"\n"
        "export SENTINEL_INTERNAL_TOKEN=\"$(tr '\\0' '\\n' </proc/1/environ | sed -n 's/^SENTINEL_INTERNAL_TOKEN=//p')\"\n"
        'curl --fail-with-body --silent --show-error -X POST '
        '"$SENTINEL_API_BASE_URL/api/internal/rules/' + rule_id + '/execute" '
        '-H "X-Internal-Token: $SENTINEL_INTERNAL_TOKEN"'
    )
    return {
        "code": task_code,
        "name": f"detect-{rule_id[:8]}",
        "version": 1,
        "description": "调用 Sentinel FastAPI 执行异常检测",
        "delayTime": 0,
        "taskType": "SHELL",
        "taskParams": {
            "resourceList": [],
            "localParams": [],
            "rawScript": script,
            "dependence": {},
            "conditionResult": {"successNode": [""], "failedNode": [""]},
            "waitStartTimeout": {},
            "switchResult": {},
        },
        "flag": "YES",
        "taskPriority": "MEDIUM",
        "workerGroup": "default",
        "failRetryTimes": 1,
        "failRetryInterval": 1,
        "timeoutFlag": "OPEN",
        "timeoutNotifyStrategy": "WARN",
        "timeout": 300,
        "environmentCode": None,
    }


class DolphinSchedulerClient:
    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.client = httpx.Client(base_url=settings.dolphinscheduler_url.rstrip("/"), timeout=20, transport=transport)

    def close(self):
        self.client.close()

    def _call(self, method: str, path: str, **kwargs):
        response = self.client.request(method, path, **kwargs)
        response.raise_for_status()
        body = response.json()
        if body.get("code") != 0:
            raise DolphinSchedulerError(f"{method} {path}: {body.get('msg') or body}")
        return body.get("data")

    def login(self):
        self._call("POST", "/login", params={"userName": self.settings.dolphinscheduler_username, "userPassword": self.settings.dolphinscheduler_password})

    @staticmethod
    def _items(data):
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("totalList") or data.get("records") or data.get("data") or []
        return []

    def ensure_project(self) -> int:
        data = self._call("GET", "/projects", params={"pageNo": 1, "pageSize": 100, "searchVal": self.settings.dolphinscheduler_project})
        for project in self._items(data):
            if project.get("name") == self.settings.dolphinscheduler_project:
                return int(project["code"])
        created = self._call("POST", "/projects", params={"projectName": self.settings.dolphinscheduler_project, "description": "Sentinel MVP 自动创建"})
        return int(created["code"])

    def _task_code(self, project_code: int) -> int:
        data = self._call("GET", f"/projects/{project_code}/task-definition/gen-task-codes", params={"genNum": 1})
        codes = data if isinstance(data, list) else data.get("codes", data)
        return int(codes[0])

    def _workflow_payload(self, task_code: int, rule: Rule) -> dict:
        task = build_shell_task(task_code, rule.id)
        relation = [{
            "name": "", "preTaskCode": 0, "preTaskVersion": 0,
            "postTaskCode": task_code, "postTaskVersion": 1,
            "conditionType": "NONE", "conditionParams": {},
        }]
        return {
            "name": f"sentinel-rule-{rule.id}",
            "description": rule.description or rule.name,
            "globalParams": "[]",
            "locations": json.dumps([{"taskCode": task_code, "x": 220, "y": 120}]),
            "timeout": 0,
            "taskRelationJson": json.dumps(relation),
            "taskDefinitionJson": json.dumps([task]),
            "executionType": "SERIAL_DISCARD",
        }

    def ensure_workflow(self, project_code: int, rule: Rule) -> int:
        name = f"sentinel-rule-{rule.id}"
        listing = self._call("GET", f"/projects/{project_code}/workflow-definition", params={"pageNo": 1, "pageSize": 100, "searchVal": name})
        existing = next((item for item in self._items(listing) if item.get("name") == name), None)
        if existing:
            workflow_code = int(existing["code"])
            self._call("POST", f"/projects/{project_code}/workflow-definition/{workflow_code}/release", params={"releaseState": "OFFLINE"})
            detail = self._call("GET", f"/projects/{project_code}/workflow-definition/{workflow_code}")
            task_list = detail.get("taskDefinitionList", []) if isinstance(detail, dict) else []
            task_code = int(task_list[0]["code"]) if task_list else self._task_code(project_code)
            self._call("PUT", f"/projects/{project_code}/workflow-definition/{workflow_code}", params=self._workflow_payload(task_code, rule))
        else:
            task_code = self._task_code(project_code)
            created = self._call("POST", f"/projects/{project_code}/workflow-definition", params=self._workflow_payload(task_code, rule))
            workflow_code = int(created["code"])
        self._call("POST", f"/projects/{project_code}/workflow-definition/{workflow_code}/release", params={"releaseState": "ONLINE"})
        return workflow_code

    def ensure_schedule(self, project_code: int, workflow_code: int, rule: Rule) -> int:
        listing = self._call("GET", f"/projects/{project_code}/schedules", params={"workflowDefinitionCode": workflow_code, "pageNo": 1, "pageSize": 20})
        schedules = self._items(listing)
        start = rule.schedule["start_date"] + " 00:00:00"
        end = (rule.schedule.get("end_date") or "2099-12-31") + " 23:59:59"
        schedule_json = json.dumps({"startTime": start, "endTime": end, "crontab": build_crontab(rule.schedule), "timezoneId": self.settings.timezone})
        common = {
            "workflowDefinitionCode": workflow_code,
            "schedule": schedule_json,
            "warningType": "NONE",
            "warningGroupId": 0,
            "failureStrategy": "END",
            "workerGroup": "default",
            "tenantCode": self.settings.dolphinscheduler_tenant,
            "workflowInstancePriority": "MEDIUM",
        }
        if schedules:
            schedule_id = int(schedules[0]["id"])
            self._call("PUT", f"/projects/{project_code}/schedules/update/{workflow_code}", params=common)
        else:
            created = self._call("POST", f"/projects/{project_code}/schedules", params=common)
            schedule_id = int(created["id"])
        return schedule_id

    def set_schedule_online(self, project_code: int, schedule_id: int, online: bool):
        action = "online" if online else "offline"
        self._call("POST", f"/projects/{project_code}/schedules/{schedule_id}/{action}")

    def sync_rule(self, rule: Rule) -> tuple[int, int]:
        self.login()
        project_code = self.ensure_project()
        workflow_code = self.ensure_workflow(project_code, rule)
        schedule_id = self.ensure_schedule(project_code, workflow_code, rule)
        self.set_schedule_online(project_code, schedule_id, rule.enabled)
        return workflow_code, schedule_id
