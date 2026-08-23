from __future__ import annotations

import json
import time
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


def build_push_shell_task(task_code: int) -> dict[str, Any]:
    script = (
        "export SENTINEL_API_BASE_URL=\"$(tr '\\0' '\\n' </proc/1/environ | sed -n 's/^SENTINEL_API_BASE_URL=//p')\"\n"
        "export SENTINEL_INTERNAL_TOKEN=\"$(tr '\\0' '\\n' </proc/1/environ | sed -n 's/^SENTINEL_INTERNAL_TOKEN=//p')\"\n"
        'curl --fail-with-body --silent --show-error -X POST '
        '"$SENTINEL_API_BASE_URL/api/internal/anomaly-pushes/${push_job_id}/execute" '
        '-H "X-Internal-Token: $SENTINEL_INTERNAL_TOKEN"'
    )
    task = build_shell_task(task_code, "push")
    task["name"] = "send-anomaly-push"
    task["description"] = "调用 Sentinel 执行一条 Kafka 异常推送任务"
    task["taskParams"]["rawScript"] = script
    task["failRetryTimes"] = 1
    return task


class DolphinSchedulerClient:
    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.client = httpx.Client(base_url=settings.dolphinscheduler_url.rstrip("/"), timeout=20, transport=transport)

    def close(self):
        self.client.close()

    def _call(self, method: str, path: str, *, _allow_reauth: bool = True, **kwargs):
        response = self.client.request(method, path, **kwargs)
        if response.status_code == 401 and _allow_reauth and path != "/login":
            self.login()
            response = self.client.request(method, path, **kwargs)
        response.raise_for_status()
        body = response.json()
        if body.get("code") != 0:
            raise DolphinSchedulerError(f"{method} {path}: {body.get('msg') or body}")
        return body.get("data")

    def login(self):
        self._call(
            "POST",
            "/login",
            params={
                "userName": self.settings.dolphinscheduler_username,
                "userPassword": self.settings.dolphinscheduler_password,
            },
            _allow_reauth=False,
        )

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

    def _push_workflow_payload(self, task_code: int) -> dict:
        task = build_push_shell_task(task_code)
        relation = [{
            "name": "", "preTaskCode": 0, "preTaskVersion": 0,
            "postTaskCode": task_code, "postTaskVersion": 1,
            "conditionType": "NONE", "conditionParams": {},
        }]
        return {
            "name": "sentinel-anomaly-push",
            "description": "Kafka 异常推送共享工作流",
            "globalParams": "[]",
            "locations": json.dumps([{"taskCode": task_code, "x": 220, "y": 120}]),
            "timeout": 0,
            "taskRelationJson": json.dumps(relation),
            "taskDefinitionJson": json.dumps([task]),
            "executionType": "PARALLEL",
        }

    def ensure_push_workflow(self, project_code: int) -> int:
        name = "sentinel-anomaly-push"
        listing = self._call(
            "GET", f"/projects/{project_code}/workflow-definition",
            params={"pageNo": 1, "pageSize": 100, "searchVal": name},
        )
        existing = next((item for item in self._items(listing) if item.get("name") == name), None)
        if existing:
            workflow_code = int(existing["code"])
            self._call(
                "POST", f"/projects/{project_code}/workflow-definition/{workflow_code}/release",
                params={"releaseState": "OFFLINE"},
            )
            detail = self._call(
                "GET", f"/projects/{project_code}/workflow-definition/{workflow_code}",
            )
            task_list = detail.get("taskDefinitionList", []) if isinstance(detail, dict) else []
            task_code = int(task_list[0]["code"]) if task_list else self._task_code(project_code)
            self._call(
                "PUT", f"/projects/{project_code}/workflow-definition/{workflow_code}",
                params=self._push_workflow_payload(task_code),
            )
        else:
            task_code = self._task_code(project_code)
            created = self._call(
                "POST", f"/projects/{project_code}/workflow-definition",
                params=self._push_workflow_payload(task_code),
            )
            workflow_code = int(created["code"])
        self._call(
            "POST", f"/projects/{project_code}/workflow-definition/{workflow_code}/release",
            params={"releaseState": "ONLINE"},
        )
        self._push_project_code = project_code
        self._push_workflow_code = workflow_code
        return workflow_code

    def initialize_push_workflow(self) -> int:
        self.login()
        return self.ensure_push_workflow(self.ensure_project())

    def start_push_job(self, job_id: str) -> None:
        if not hasattr(self, "_push_workflow_code"):
            self.initialize_push_workflow()
        self._call(
            "POST", f"/projects/{self._push_project_code}/executors/start-workflow-instance",
            params={
                "workflowDefinitionCode": self._push_workflow_code,
                "scheduleTime": "",
                "failureStrategy": "END",
                "warningType": "NONE",
                "warningGroupId": 0,
                "execType": "START_PROCESS",
                "workflowInstancePriority": "MEDIUM",
                "workerGroup": "default",
                "tenantCode": self.settings.dolphinscheduler_tenant,
                "environmentCode": -1,
                "timeout": 0,
                "startParams": json.dumps({"push_job_id": job_id}),
            },
        )

    def _push_instances(self) -> list[dict]:
        if not hasattr(self, "_push_workflow_code"):
            self.initialize_push_workflow()
        instances: list[dict] = []
        for page in range(1, 101):
            data = self._call(
                "GET", f"/projects/{self._push_project_code}/workflow-instances",
                params={
                    "pageNo": page,
                    "pageSize": 100,
                    "processDefinitionCode": self._push_workflow_code,
                },
            )
            items = [
                item for item in self._items(data)
                if int(item.get("processDefinitionCode", self._push_workflow_code)) == self._push_workflow_code
            ]
            instances.extend(items)
            if len(items) < 100:
                break
        return instances

    def clear_push_instances(
        self,
        *,
        timeout: float = 20,
        poll_interval: float = 0.25,
    ) -> tuple[int, int]:
        terminal = {"SUCCESS", "FAILURE", "STOP", "KILL", "PAUSE", "NEED_FAULT_TOLERANCE"}
        active = [item for item in self._push_instances() if item.get("state") not in terminal]
        for item in active:
            self._call(
                "POST", f"/projects/{self._push_project_code}/executors/execute",
                params={"processInstanceId": int(item["id"]), "executeType": "STOP"},
            )
        deadline = time.monotonic() + timeout
        pending = {int(item["id"]) for item in active}
        while pending and time.monotonic() <= deadline:
            for instance_id in list(pending):
                detail = self._call(
                    "GET",
                    f"/projects/{self._push_project_code}/workflow-instances/{instance_id}",
                )
                if detail.get("state") in terminal:
                    pending.remove(instance_id)
            if pending and poll_interval:
                time.sleep(poll_interval)
        if pending:
            raise DolphinSchedulerError(
                f"异常推送工作流实例未在限定时间内停止: {sorted(pending)}"
            )
        for item in active:
            self._call(
                "DELETE",
                f"/projects/{self._push_project_code}/workflow-instances/{int(item['id'])}",
            )
        return len(active), len(active)

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
