import csv
import io
import secrets
from typing import Literal

import httpx
import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import and_, case, exists, func, or_, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import feishu as feishu_gateway
from .config import SESSION_COOKIE, Settings
from .execution_service import RuleExecutionConflict, execute_rule
from .message_templates import MessageTemplateError, validate_message_template
from .models import (
    AnomalyEvent,
    AnomalyGroupBroadcastDelivery,
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyRecord,
    AnomalyRecordGroup,
    AnomalyRecordGroupMember,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    Dataset,
    Datasource,
    NotificationDelivery,
    Rule,
    RuleRun,
    User,
    utcnow,
)
from .query_service import connect_to_datasource, execute_readonly_query
from .push_pipeline import abort_pending_pushes, execute_push_job, recover_failed_push_jobs
from .schemas import (
    AnomalyStatusUpdate,
    BulkAnomalyStatusUpdate,
    DatasourceCreate,
    DatasourceUpdate,
    DatasetCreate,
    DatasetUpdate,
    FeishuCardActionCallback,
    FeishuMessageTestRequest,
    RuleCreate,
)
from .security import CredentialCipher
from .scheduler_service import sync_rule_record
from .sql_guard import SqlValidationError, validate_readonly_sql
from .sql_validation import SqlValidationConfigurationError, validate_sql_validation_config
from .validation_service import (
    InvalidValidationTransition,
    SqlValidationExecutionError,
    ValidationRecipientError,
    ValidationTextError,
    build_validation_card,
    refresh_validation_card,
    submit_sql_validation,
    submit_validation,
    transition_anomaly,
)


router = APIRouter(prefix="/api/v1")
internal_router = APIRouter(prefix="/api/internal")
FEISHU_TEST_MESSAGE = "【Sentinel 测试消息】飞书消息发送测试成功。"


def get_session(request: Request):
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_current_user(
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
) -> User:
    if settings.auto_login:
        return User(
            id="auto-login-superadmin",
            username=settings.superadmin_username,
            password_hash="",
            is_superuser=True,
        )
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(401, "未登录")
    try:
        claims = jwt.decode(token, settings.session_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "登录状态无效") from exc
    username = claims.get("sub")
    if not isinstance(username, str) or not username.strip():
        raise HTTPException(401, "登录状态无效")
    user = session.scalar(select(User).where(User.username == username))
    if user is None:
        raise HTTPException(401, "登录状态无效")
    return user


def get_current_admin(user: User = Depends(get_current_user)) -> str:
    if not user.is_superuser:
        raise HTTPException(403, "需要超级管理员权限")
    return user.username


def get_current_reader(user: User = Depends(get_current_user)) -> User:
    return user


@internal_router.post("/anomaly-pushes/{job_id}/execute")
def internal_execute_anomaly_push(
    job_id: str,
    x_internal_token: str = Header(default=""),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
):
    if not secrets.compare_digest(x_internal_token, settings.internal_execution_token):
        raise HTTPException(401, "内部令牌无效")
    try:
        outcome = execute_push_job(session, settings, job_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc
    if outcome == "failed":
        raise HTTPException(502, "异常推送失败")
    return {"job_id": job_id, "outcome": outcome}


@router.post("/anomaly-pushes/abort")
def abort_anomaly_pushes(
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
    _admin_username: str = Depends(get_current_admin),
):
    kafka = getattr(request.app.state, "kafka_gateway", None)
    scheduler = getattr(request.app.state, "push_scheduler", None)
    if kafka is None or scheduler is None:
        raise HTTPException(503, "异常推送管线尚未就绪")
    try:
        summary = abort_pending_pushes(session, settings, kafka, scheduler)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    if summary["status"] != "completed":
        return JSONResponse(status_code=502, content=summary)
    return summary


@router.post("/anomaly-pushes/recover")
def recover_anomaly_pushes(
    request: Request,
    session: Session = Depends(get_session),
    _admin_username: str = Depends(get_current_admin),
):
    kafka = getattr(request.app.state, "kafka_gateway", None)
    scheduler = getattr(request.app.state, "push_scheduler", None)
    if kafka is None or scheduler is None:
        raise HTTPException(503, "异常推送管线尚未就绪")

    checks = {"kafka": "healthy", "dolphinscheduler": "healthy"}
    errors = []
    for stage, check in (
        ("kafka", kafka.check_health),
        ("dolphinscheduler", scheduler.recover),
    ):
        try:
            check()
        except Exception as exc:
            checks[stage] = "unhealthy"
            errors.append({"stage": stage, "message": str(exc)[:2000]})
    if errors:
        return JSONResponse(status_code=502, content={
            "status": "partial_failed",
            "checks": checks,
            "requeued_jobs": 0,
            "requeued_by_kind": {
                "notification": 0, "validation": 0, "group_broadcast": 0,
            },
            "skipped_jobs": 0,
            "errors": errors,
        })

    summary = recover_failed_push_jobs(session)
    return {"status": "completed", "checks": checks, **summary, "errors": []}


@router.post("/tests/feishu-message")
def test_feishu_message(
    payload: FeishuMessageTestRequest,
    settings: Settings = Depends(get_app_settings),
    _admin_username: str = Depends(get_current_admin),
):
    try:
        message_id = feishu_gateway.send_configured_text(
            settings.feishu_app_id,
            settings.feishu_app_secret,
            payload.receive_id_type,
            payload.receive_id,
            FEISHU_TEST_MESSAGE,
        )
    except feishu_gateway.FeishuConfigurationError as exc:
        raise HTTPException(503, str(exc)) from exc
    except (feishu_gateway.FeishuError, httpx.HTTPError) as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"ok": True, "message_id": message_id}


def _card_action_result(
    toast_type: str,
    content: str,
    anomaly_id: str,
    session: Session,
    settings: Settings,
) -> dict:
    anomaly = session.scalar(
        select(AnomalyRecord).where(
            AnomalyRecord.id == anomaly_id
        ).execution_options(populate_existing=True)
    )
    if anomaly is None:
        raise HTTPException(404, "异常记录不存在")
    result = {
        "toast": {"type": toast_type, "content": content},
        "card": build_validation_card(anomaly, settings.sentinel_public_base_url),
    }
    if anomaly.validation_method_snapshot == "sql":
        # The snapshot remains available to internal callers, but the gateway
        # must not apply it: a delayed callback can overwrite a newer PATCH.
        result["card_update_mode"] = "versioned"
    return result


@internal_router.post("/feishu/card-actions")
def feishu_card_action(
    payload: FeishuCardActionCallback,
    background_tasks: BackgroundTasks,
    http_request: Request,
    x_internal_token: str = Header(default=""),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
):
    if x_internal_token != settings.internal_execution_token:
        raise HTTPException(401, "内部令牌无效")
    if payload.action not in {"submit_validation", "run_sql_validation"}:
        raise HTTPException(400, "不支持的飞书卡片操作")

    anomaly = session.get(AnomalyRecord, payload.anomaly_id)
    if anomaly is None:
        raise HTTPException(404, "异常记录不存在")
    anomaly_id = anomaly.id
    request = session.scalar(select(AnomalyValidationRequest).where(
        AnomalyValidationRequest.anomaly_id == anomaly_id,
        AnomalyValidationRequest.message_id == payload.message_id,
    ))
    if request is None:
        raise HTTPException(404, "飞书消息不存在")
    if request.recipient_user_id != payload.operator_user_id:
        return _card_action_result(
            "error", "当前用户无权提交该异常验证", anomaly_id, session, settings,
        )

    validation_method = anomaly.validation_method_snapshot or "pseudo"
    expected_action = "run_sql_validation" if validation_method == "sql" else "submit_validation"
    if payload.action != expected_action:
        raise HTTPException(400, "卡片操作与异常校验方式不匹配")

    if validation_method == "sql":
        background_tasks.add_task(refresh_validation_card, http_request.app.state.session_factory,
                                   settings, request.id)

    try:
        if validation_method == "sql":
            result = submit_sql_validation(
                session,
                settings,
                anomaly_id,
                payload.operator_user_id,
            )
        else:
            result = submit_validation(
                session,
                anomaly_id,
                payload.operator_user_id,
                payload.validation_text,
            )
    except ValidationTextError as exc:
        return _card_action_result("error", str(exc), anomaly_id, session, settings)
    except ValidationRecipientError:
        return _card_action_result(
            "error", "当前用户无权提交该异常验证", anomaly_id, session, settings,
        )
    except InvalidValidationTransition:
        session.rollback()
        return _card_action_result(
            "error", "当前异常状态不允许实时验证", anomaly_id, session, settings,
        )
    except SqlValidationExecutionError as exc:
        return _card_action_result("error", str(exc), anomaly_id, session, settings)
    except Exception as exc:
        session.rollback()
        raise HTTPException(500, "处理飞书回调失败") from exc

    if result.outcome == "accepted":
        content = "SQL 校验通过，异常已解决" if validation_method == "sql" else "验证已提交，异常已解决"
        return _card_action_result("success", content, anomaly_id, session, settings)
    if result.outcome == "failed":
        reason_messages = {
            "no_rows": "SQL 校验未通过：查询未返回数据",
            "multiple_rows": "SQL 校验未通过：查询返回多行",
            "missing_field": "SQL 校验未通过：结果缺少配置字段",
            "invalid_comparison": "SQL 校验未通过：比较值类型不兼容",
        }
        if result.reason in reason_messages:
            content = reason_messages[result.reason]
        else:
            detail = result.result_detail or {}
            content = (
                f"SQL 校验未通过：{detail.get('field', '-')} 实际值 "
                f"{detail.get('actual')}，期望 {detail.get('operator', '-')} {detail.get('resolved_value', detail.get('value'))}"
            )
        return _card_action_result("warning", content, anomaly_id, session, settings)
    if result.outcome == "duplicate":
        return _card_action_result("warning", "该验证已提交，无需重复操作", anomaly_id, session, settings)
    return _card_action_result("warning", "该异常已由其他验证人解决", anomaly_id, session, settings)


def datasource_dict(item: Datasource) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "type": item.type,
        "host": item.host,
        "port": item.port,
        "database": item.database,
        "username": item.username,
        "ssl": item.ssl,
        "description": item.description,
        "status": item.status,
        "last_checked": item.last_checked,
        "error_message": item.error_message,
        "has_password": bool(item.password_encrypted),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def dataset_dict(item: Dataset) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "description": item.description,
        "datasource_id": item.datasource_id,
        "datasource_name": item.datasource.name if item.datasource else "",
        "sql": item.sql,
        "fields": item.fields,
        "row_count": item.row_count,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _datasource_password(item: Datasource, settings: Settings) -> str:
    if not item.password_encrypted:
        return ""
    return CredentialCipher(settings.datasource_encryption_key).decrypt(item.password_encrypted)


def rule_dict(item: Rule) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "description": item.description,
        "dataset_id": item.dataset_id,
        "dataset_name": item.dataset.name,
        "severity": item.severity,
        "logic": item.logic,
        "conditions": item.conditions,
        "anomaly_key_fields": item.anomaly_key_fields,
        "repeat_push_enabled": item.repeat_push_enabled,
        "schedule": item.schedule,
        "notification_targets": item.notification_targets,
        "private_message_template": item.private_message_template,
        "validation_enabled": item.validation_enabled,
        "validation_targets": item.validation_targets,
        "validation_timeout_minutes": item.validation_timeout_minutes,
        "validation_method": item.validation_method,
        "sql_validation_config": item.sql_validation_config,
        "group_broadcast": {
            "enabled": item.group_broadcast_enabled,
            "webhook_url": item.group_webhook_url,
            "mention_targets": item.group_mention_targets,
            "message_template": item.group_message_template,
            "situation": {
                "enabled": item.group_broadcast_enabled,
                "mention_targets": item.group_mention_targets,
                "message_template": item.group_message_template,
            },
            "timeout": {
                "enabled": item.timeout_broadcast_enabled,
                "mention_targets": item.timeout_mention_targets,
                "message_template": item.timeout_message_template,
            },
        },
        "enabled": item.enabled,
        "sync_status": item.sync_status,
        "sync_error": item.sync_error,
        "ds_workflow_code": item.ds_workflow_code,
        "ds_schedule_id": item.ds_schedule_id,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _sync_rule(item: Rule, settings: Settings, session: Session) -> None:
    sync_rule_record(item, settings, session)


def _validate_rule_sql_configuration(payload: RuleCreate, dataset: Dataset) -> None:
    fields = {str(field["name"]) for field in (dataset.fields or []) if field.get("name") is not None}
    if payload.repeat_push_enabled and {"__detected_at", "__occurrence_id"} & set(payload.anomaly_key_fields):
        raise HTTPException(422, "异常主键不能使用系统保留字段 __detected_at、__occurrence_id")
    for condition in payload.conditions:
        if condition.operator in {"is_null", "is_not_null"}:
            continue
        operands = ["value", "upper_value"] if condition.operator == "between" else ["value"]
        for name in operands:
            if getattr(condition, f"{name}_source") == "field" and getattr(condition, f"{name}_field") not in fields:
                raise HTTPException(422, f"比较目标字段不存在：{getattr(condition, f'{name}_field')}")
    if payload.validation_method != "sql" or payload.sql_validation_config is None:
        return
    fields = {
        str(field.get("name"))
        for field in (dataset.fields or [])
        if field.get("name") is not None
    }
    try:
        validate_sql_validation_config(
            payload.sql_validation_config.model_dump(mode="json"),
            fields,
        )
    except SqlValidationConfigurationError as exc:
        raise HTTPException(422, str(exc)) from exc


def _validate_group_broadcast_configuration(
    payload: RuleCreate,
    dataset: Dataset,
    *,
    existing_webhook: str | None = None,
    existing: Rule | None = None,
) -> None:
    config = payload.group_broadcast
    timeout_enabled = config.timeout.enabled if config.timeout is not None else bool(existing and existing.timeout_broadcast_enabled)
    if timeout_enabled and not payload.validation_enabled:
        raise HTTPException(422, "启用超时播报必须开启实时验证")
    if "group_broadcast" not in payload.model_fields_set:
        return
    webhook_was_supplied = "webhook_url" in config.model_fields_set
    effective_webhook = config.webhook_url if webhook_was_supplied else existing_webhook
    situation_supplied = "situation" in config.model_fields_set or bool({"enabled", "mention_targets", "message_template"} & config.model_fields_set)
    situation_enabled = config.situation.enabled if situation_supplied else bool(existing and existing.group_broadcast_enabled)
    if (situation_enabled or timeout_enabled) and not effective_webhook:
        raise HTTPException(422, "启用群聊播报时必须配置 webhook")
    fields = {
        str(field.get("name"))
        for field in (dataset.fields or [])
        if field.get("name") is not None
    }
    missing = sorted({
        target.field
        for mode in [config.situation, config.timeout] if mode is not None
        for target in mode.mention_targets
        if target.source == "field" and target.field not in fields
    })
    if missing:
        raise HTTPException(422, f"群聊播报数据集字段不存在：{'、'.join(missing)}")


def _validate_message_templates(payload: RuleCreate, dataset: Dataset) -> None:
    fields = {
        str(field.get("name"))
        for field in (dataset.fields or [])
        if field.get("name") is not None
    }
    templates = [(payload.private_message_template, "private")]
    if "group_broadcast" in payload.model_fields_set:
        templates.extend((mode.message_template, "group") for mode in
                         [payload.group_broadcast.situation, payload.group_broadcast.timeout] if mode is not None)
    for template, context in templates:
        if template is None:
            continue
        try:
            validate_message_template(template, fields, context)
        except MessageTemplateError as exc:
            raise HTTPException(422, str(exc)) from exc


def _apply_group_broadcast_configuration(
    item: Rule,
    payload: RuleCreate,
    settings: Settings,
) -> None:
    if "group_broadcast" not in payload.model_fields_set:
        return
    config = payload.group_broadcast
    if "situation" in config.model_fields_set or {"enabled", "mention_targets", "message_template"} & config.model_fields_set:
        mode = config.situation
        item.group_broadcast_enabled = mode.enabled
        item.group_mention_targets = [target.model_dump(mode="json", exclude_none=True) for target in mode.mention_targets]
        if "message_template" in mode.model_fields_set:
            item.group_message_template = mode.message_template
    if config.timeout is not None:
        mode = config.timeout
        item.timeout_broadcast_enabled = mode.enabled
        item.timeout_mention_targets = [target.model_dump(mode="json", exclude_none=True) for target in mode.mention_targets]
        if "message_template" in mode.model_fields_set:
            item.timeout_message_template = mode.message_template
    if "webhook_url" in config.model_fields_set:
        item.group_webhook_url = config.webhook_url


def run_dict(item: RuleRun) -> dict:
    return {
        "id": item.id, "rule_id": item.rule_id, "trigger_source": item.trigger_source,
        "status": item.status, "scanned_rows": item.scanned_rows, "matched_rows": item.matched_rows,
        "new_anomalies": item.new_anomalies, "error_message": item.error_message,
        "started_at": item.started_at, "finished_at": item.finished_at,
    }


def _group_broadcast_status(enabled: bool, statuses: list[str]) -> str:
    if not enabled:
        return "disabled"
    if not statuses:
        return "failed"
    if "uncertain" in statuses:
        return "uncertain"
    if all(status == "pending" for status in statuses):
        return "pending"
    if "sending" in statuses or "pending" in statuses:
        return "in_transit"
    if all(status == "sent" for status in statuses):
        return "sent"
    if all(status == "aborted" for status in statuses):
        return "aborted"
    if "sent" in statuses and ({"failed", "aborted"} & set(statuses)):
        return "partial_failed"
    if "failed" in statuses:
        return "failed"
    if "aborted" in statuses:
        return "aborted"
    return "in_transit"


def _group_summaries(session: Session, groups: list[AnomalyRecordGroup]) -> list[dict]:
    if not groups:
        return []
    keys = [(group.rule_id, group.detected_at) for group in groups]
    status_counts: dict[tuple[str, object], dict[str, int]] = {}
    for rule_id, detected_at, record_status, count in session.execute(
        select(
            AnomalyRecordGroupMember.rule_id,
            AnomalyRecordGroupMember.detected_at,
            AnomalyRecord.status,
            func.count(AnomalyRecord.id),
        )
        .join(AnomalyRecord, AnomalyRecord.id == AnomalyRecordGroupMember.anomaly_id)
        .where(tuple_(
            AnomalyRecordGroupMember.rule_id,
            AnomalyRecordGroupMember.detected_at,
        ).in_(keys))
        .group_by(
            AnomalyRecordGroupMember.rule_id,
            AnomalyRecordGroupMember.detected_at,
            AnomalyRecord.status,
        )
    ):
        status_counts.setdefault((rule_id, detected_at), {})[record_status] = count
    delivery_statuses: dict[tuple[str, object, str], list[str]] = {}
    for rule_id, detected_at, kind, delivery_status in session.execute(
        select(
            AnomalyGroupBroadcastDelivery.rule_id,
            AnomalyGroupBroadcastDelivery.detected_at,
            AnomalyGroupBroadcastDelivery.broadcast_kind,
            AnomalyGroupBroadcastDelivery.status,
        ).where(tuple_(
            AnomalyGroupBroadcastDelivery.rule_id,
            AnomalyGroupBroadcastDelivery.detected_at,
        ).in_(keys))
    ):
        delivery_statuses.setdefault((rule_id, detected_at, kind), []).append(delivery_status)
    result = []
    for group in groups:
        key = (group.rule_id, group.detected_at)
        counts = status_counts.get(key, {})
        situation_statuses = delivery_statuses.get((*key, "situation"), [])
        situation_status = ("skipped" if group.broadcast_enabled and group.new_anomalies == 0 and not situation_statuses
                            else _group_broadcast_status(group.broadcast_enabled, situation_statuses))
        timeout_statuses = delivery_statuses.get((*key, "timeout"), [])
        if not (group.timeout_broadcast_snapshot or {}).get("enabled"):
            timeout_status = "disabled"
        elif timeout_statuses:
            timeout_status = _group_broadcast_status(True, timeout_statuses)
        elif group.timeout_processed_at is not None or group.timeout_deadline is None:
            timeout_status = "skipped"
        else:
            timeout_status = "waiting"
        result.append({
            "group_id": group.run_id,
            "rule_id": group.rule_id,
            "rule_name": group.rule_name,
            "detected_at": group.detected_at,
            "scanned_rows": group.scanned_rows,
            "matched_rows": group.matched_rows,
            "new_anomalies": group.new_anomalies,
            "status_counts": {
                status: counts.get(status, 0)
                for status in ("pending", "processing", "timed_out", "resolved")
            },
            "broadcast_status": situation_status,
            "situation_broadcast_status": situation_status,
            "timeout_broadcast_status": timeout_status,
        })
    return result


def anomaly_dict(item: AnomalyRecord, delivery_status: str | None = None) -> dict:
    return {
        "id": item.id, "rule_id": item.rule_id, "rule_name": item.rule_name,
        "dataset_name": item.dataset_name, "severity": item.severity, "status": item.status,
        "business_key": item.business_key, "row_details": item.row_details,
        "matched_conditions": item.matched_conditions, "hit_count": item.hit_count,
        "first_seen_at": item.first_seen_at, "last_seen_at": item.last_seen_at,
        "resolved_at": item.resolved_at, "assignee": item.assignee,
        "description": item.description,
        "validation_deadline": item.validation_deadline,
        "timed_out_at": item.timed_out_at,
        "resolution_source": item.resolution_source,
        "resolved_by_user_id": item.resolved_by_user_id,
        "validation_method": item.validation_method_snapshot,
        "delivery_status": delivery_status or "none",
    }


@router.get("/datasources")
def list_datasources(
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    return [datasource_dict(item) for item in session.scalars(select(Datasource).order_by(Datasource.created_at.desc()))]


@router.post("/datasources", status_code=status.HTTP_201_CREATED)
def create_datasource(payload: DatasourceCreate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    cipher = CredentialCipher(settings.datasource_encryption_key)
    item = Datasource(
        **payload.model_dump(exclude={"password"}),
        password_encrypted=cipher.encrypt(payload.password) if payload.password else "",
    )
    session.add(item)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, "数据源名称已存在") from exc
    return datasource_dict(item)


@router.post("/datasources/test")
def test_datasource_config(payload: DatasourceCreate, _admin_username: str = Depends(get_current_admin)):
    item = Datasource(**payload.model_dump(exclude={"password"}), password_encrypted="")
    try:
        connection = connect_to_datasource(item, payload.password)
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 AS ok")
            cursor.fetchone()
        connection.close()
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(502, f"连接失败: {exc}") from exc


@router.get("/datasources/{datasource_id}")
def get_datasource(
    datasource_id: str,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    return datasource_dict(item)


@router.patch("/datasources/{datasource_id}")
def update_datasource(datasource_id: str, payload: DatasourceUpdate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    changes = payload.model_dump(exclude_unset=True)
    password = changes.pop("password", None)
    for key, value in changes.items():
        setattr(item, key, value)
    if password is not None:
        item.password_encrypted = CredentialCipher(settings.datasource_encryption_key).encrypt(password) if password else ""
    session.commit()
    return datasource_dict(item)


@router.delete("/datasources/{datasource_id}", status_code=204)
def delete_datasource(datasource_id: str, session: Session = Depends(get_session), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    if item.datasets:
        raise HTTPException(409, "数据源已被数据集引用")
    session.delete(item)
    session.commit()


@router.post("/datasources/{datasource_id}/test")
def test_datasource(datasource_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    try:
        connection = connect_to_datasource(item, _datasource_password(item, settings))
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 AS ok")
            cursor.fetchone()
        connection.close()
        item.status = "online"
        item.error_message = None
    except Exception as exc:
        item.status = "error"
        item.error_message = str(exc)[:1000]
        session.commit()
        raise HTTPException(502, f"连接失败: {exc}") from exc
    item.last_checked = utcnow()
    session.commit()
    return {"ok": True, "checked_at": item.last_checked}


@router.get("/datasets")
def list_datasets(
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    return [dataset_dict(item) for item in session.scalars(select(Dataset).order_by(Dataset.created_at.desc()))]


@router.post("/datasets", status_code=status.HTTP_201_CREATED)
def create_dataset(payload: DatasetCreate, session: Session = Depends(get_session), _admin_username: str = Depends(get_current_admin)):
    if not session.get(Datasource, payload.datasource_id):
        raise HTTPException(404, "数据源不存在")
    try:
        normalized = validate_readonly_sql(payload.sql)
    except SqlValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    item = Dataset(**payload.model_dump(exclude={"sql"}), sql=normalized)
    session.add(item)
    session.commit()
    session.refresh(item)
    return dataset_dict(item)


@router.get("/datasets/{dataset_id}")
def get_dataset(
    dataset_id: str,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    return dataset_dict(item)


@router.patch("/datasets/{dataset_id}")
def update_dataset(dataset_id: str, payload: DatasetUpdate, session: Session = Depends(get_session), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    changes = payload.model_dump(exclude_unset=True)
    if "sql" in changes:
        try:
            changes["sql"] = validate_readonly_sql(changes["sql"])
        except SqlValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
    for key, value in changes.items():
        setattr(item, key, value)
    session.commit()
    return dataset_dict(item)


@router.delete("/datasets/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: str, session: Session = Depends(get_session), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    if item.rules:
        raise HTTPException(409, "数据集已被规则引用")
    session.delete(item)
    session.commit()


@router.post("/datasets/{dataset_id}/execute")
def execute_saved_dataset(dataset_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    try:
        connection = connect_to_datasource(item.datasource, _datasource_password(item.datasource, settings))
        result = execute_readonly_query(connection, item.sql)
        connection.close()
    except SqlValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"查询执行失败: {exc}") from exc
    item.fields = result["fields"]
    item.row_count = result["row_count"]
    session.commit()
    return result


@router.post("/datasets/execute")
def execute_ad_hoc_dataset(payload: dict, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    datasource = session.get(Datasource, payload.get("datasource_id"))
    if not datasource:
        raise HTTPException(404, "数据源不存在")
    try:
        connection = connect_to_datasource(datasource, _datasource_password(datasource, settings))
        result = execute_readonly_query(connection, payload.get("sql", ""))
        connection.close()
        return result
    except SqlValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"查询执行失败: {exc}") from exc


@router.post("/datasets/validate")
def validate_dataset_sql(payload: dict):
    try:
        normalized = validate_readonly_sql(payload.get("sql", ""))
    except SqlValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"valid": True, "normalized_sql": normalized}


@router.get("/rules")
def list_rules(
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    query = select(Rule).where(Rule.deleted_at.is_(None)).order_by(Rule.created_at.desc())
    return [rule_dict(item) for item in session.scalars(query)]


@router.post("/rules", status_code=201)
def create_rule(payload: RuleCreate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    dataset = session.get(Dataset, payload.dataset_id)
    if not dataset:
        raise HTTPException(404, "数据集不存在")
    _validate_rule_sql_configuration(payload, dataset)
    _validate_group_broadcast_configuration(payload, dataset)
    _validate_message_templates(payload, dataset)
    item = Rule(**payload.model_dump(mode="json", exclude={"enabled", "group_broadcast"}), sync_status="pending", enabled=False)
    _apply_group_broadcast_configuration(item, payload, settings)
    session.add(item)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(409, "规则名称已存在") from exc
    if payload.enabled:
        item.enabled = True
        _sync_rule(item, settings, session)
    return rule_dict(item)


@router.get("/rules/{rule_id}")
def get_rule(
    rule_id: str,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    return rule_dict(item)


@router.put("/rules/{rule_id}")
def update_rule(rule_id: str, payload: RuleCreate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    dataset = session.get(Dataset, payload.dataset_id)
    if not dataset:
        raise HTTPException(404, "数据集不存在")
    _validate_rule_sql_configuration(payload, dataset)
    _validate_group_broadcast_configuration(
        payload, dataset, existing_webhook=item.group_webhook_url, existing=item,
    )
    _validate_message_templates(payload, dataset)
    for key, value in payload.model_dump(mode="json", exclude={"enabled", "group_broadcast"}).items():
        setattr(item, key, value)
    _apply_group_broadcast_configuration(item, payload, settings)
    item.sync_status = "pending"
    item.sync_error = None
    session.commit()
    return rule_dict(item)


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    item.enabled = False
    if item.ds_schedule_id:
        _sync_rule(item, settings, session)
    item.deleted_at = utcnow()
    session.commit()


@router.post("/rules/{rule_id}/execute")
def execute_rule_manually(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    try:
        run = execute_rule(session, settings, rule_id, "manual")
    except RuleExecutionConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    if run.status != "success":
        raise HTTPException(502, run.error_message or "规则执行失败")
    return run_dict(run)


@router.post("/rules/{rule_id}/sync")
def sync_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    _sync_rule(item, settings, session)
    if item.sync_status == "sync_error":
        raise HTTPException(502, item.sync_error)
    return rule_dict(item)


@router.post("/rules/{rule_id}/enable")
def enable_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    item.enabled = True
    _sync_rule(item, settings, session)
    if not item.enabled:
        raise HTTPException(502, item.sync_error or "调度同步失败")
    return rule_dict(item)


@router.post("/rules/{rule_id}/disable")
def disable_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings), _admin_username: str = Depends(get_current_admin)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    item.enabled = False
    if item.ds_schedule_id:
        _sync_rule(item, settings, session)
    else:
        session.commit()
    return rule_dict(item)


@router.get("/rule-runs/{run_id}")
def get_rule_run(
    run_id: str,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    item = session.get(RuleRun, run_id)
    if not item:
        raise HTTPException(404, "执行批次不存在")
    return run_dict(item)


@router.get("/anomaly-groups")
def list_anomaly_groups(
    page: int = 1,
    page_size: int = 20,
    search: str | None = None,
    rule_id: str | None = None,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    query = select(AnomalyRecordGroup)
    count_query = select(AnomalyRecordGroup.rule_id, AnomalyRecordGroup.detected_at)
    if search:
        query = query.where(AnomalyRecordGroup.rule_name.contains(search, autoescape=True))
        count_query = count_query.where(AnomalyRecordGroup.rule_name.contains(search, autoescape=True))
    if rule_id:
        query = query.where(AnomalyRecordGroup.rule_id == rule_id)
        count_query = count_query.where(AnomalyRecordGroup.rule_id == rule_id)
    size = min(max(page_size, 1), 100)
    start = max(page - 1, 0) * size
    total = session.scalar(select(func.count()).select_from(count_query.subquery())) or 0
    groups = list(session.scalars(
        query.order_by(
            AnomalyRecordGroup.detected_at.desc(), AnomalyRecordGroup.run_id.asc(),
        ).limit(size).offset(start)
    ))
    return {
        "items": _group_summaries(session, groups),
        "total": total,
        "page": page,
        "page_size": size,
    }


@router.get("/anomaly-groups/{run_id}")
def get_anomaly_group(
    run_id: str,
    page: int = 1,
    page_size: int = 20,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    group = session.scalar(select(AnomalyRecordGroup).where(
        AnomalyRecordGroup.run_id == run_id,
    ))
    if group is None:
        raise HTTPException(404, "异常记录组不存在")
    size = min(max(page_size, 1), 100)
    start = max(page - 1, 0) * size
    member_query = select(AnomalyRecord).join(
        AnomalyRecordGroupMember,
        AnomalyRecordGroupMember.anomaly_id == AnomalyRecord.id,
    ).where(
        AnomalyRecordGroupMember.rule_id == group.rule_id,
        AnomalyRecordGroupMember.detected_at == group.detected_at,
    )
    total = session.scalar(select(func.count()).select_from(member_query.subquery())) or 0
    items = list(session.scalars(
        member_query.order_by(AnomalyRecordGroupMember.position).limit(size).offset(start)
    ))
    return {
        "group": _group_summaries(session, [group])[0],
        "deliveries": [{"id": delivery.id, "broadcast_kind": delivery.broadcast_kind,
            "part_index": delivery.part_index, "total_parts": delivery.total_parts,
            "status": delivery.status, "attempts": delivery.attempts, "last_error": delivery.last_error,
            "delivered_at": delivery.delivered_at}
            for delivery in session.scalars(select(AnomalyGroupBroadcastDelivery).where(
                AnomalyGroupBroadcastDelivery.rule_id == group.rule_id,
                AnomalyGroupBroadcastDelivery.detected_at == group.detected_at,
            ).order_by(AnomalyGroupBroadcastDelivery.broadcast_kind, AnomalyGroupBroadcastDelivery.part_index))],
        "items": [anomaly_dict(item) for item in items],
        "total": total,
        "page": page,
        "page_size": size,
    }


def _anomaly_field_search_predicate(search: str, dialect_name: str):
    if dialect_name == "mysql":
        field_values = func.json_extract(AnomalyRecord.matched_conditions, "$[*].field")
        return func.json_contains(field_values, func.json_quote(search)) == 1

    conditions = func.json_each(AnomalyRecord.matched_conditions).table_valued("key", "value").alias("condition")
    return exists(
        select(1).select_from(conditions).where(func.json_extract(conditions.c.value, "$.field") == search)
    )


def _anomaly_search_predicate(search: str, dialect_name: str):
    return or_(
        AnomalyRecord.rule_name.contains(search, autoescape=True),
        AnomalyRecord.dataset_name.contains(search, autoescape=True),
        _anomaly_field_search_predicate(search, dialect_name),
    )


def _apply_anomaly_filters(
    query,
    *,
    status_filter: str | None,
    severity: str | None,
    rule_id: str | None,
    search: str | None,
    dialect_name: str,
):
    if status_filter:
        query = query.where(AnomalyRecord.status == status_filter)
    if severity:
        query = query.where(AnomalyRecord.severity == severity)
    if rule_id:
        query = query.where(AnomalyRecord.rule_id == rule_id)
    if search:
        query = query.where(_anomaly_search_predicate(search, dialect_name))
    return query


def _anomaly_ordering(sort_key: str, sort_order: str):
    severity_rank = case(
        (AnomalyRecord.severity == "critical", 4),
        (AnomalyRecord.severity == "high", 3),
        (AnomalyRecord.severity == "medium", 2),
        (AnomalyRecord.severity == "low", 1),
        else_=0,
    )
    sort_column = severity_rank if sort_key == "severity" else AnomalyRecord.first_seen_at
    return sort_column.asc() if sort_order == "asc" else sort_column.desc()


def _in_transit_anomaly_ids(session: Session):
    pipeline = session.get(AnomalyPushPipelineState, 1)
    query = (
        select(AnomalyPushJob.anomaly_id)
        .outerjoin(
            NotificationDelivery,
            and_(
                AnomalyPushJob.kind == "notification",
                NotificationDelivery.id == AnomalyPushJob.delivery_id,
            ),
        )
        .outerjoin(
            AnomalyValidationRequest,
            and_(
                AnomalyPushJob.kind == "validation",
                AnomalyValidationRequest.id == AnomalyPushJob.delivery_id,
            ),
        )
    )
    if pipeline is None:
        return query.where(AnomalyPushJob.id.is_(None))
    return query.where(
        AnomalyPushJob.generation == pipeline.generation,
        AnomalyPushJob.cancel_requested.is_(False),
        AnomalyPushJob.status.not_in(["sent", "aborted"]),
        or_(
            and_(
                AnomalyPushJob.kind == "notification",
                NotificationDelivery.status.in_(["pending", "failed", "sending", "uncertain"]),
            ),
            and_(
                AnomalyPushJob.kind == "validation",
                AnomalyValidationRequest.delivery_status.in_(["pending", "failed", "sending", "uncertain"]),
            ),
        ),
    ).distinct()


@router.get("/anomalies")
def list_anomalies(
    page: int = 1,
    page_size: int = 20,
    status_filter: str | None = None,
    severity: str | None = None,
    rule_id: str | None = None,
    search: str | None = None,
    push_status: Literal["in_transit"] | None = None,
    sort_key: Literal["occurredAt", "severity"] = "occurredAt",
    sort_order: Literal["asc", "desc"] = "desc",
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    ordering = _anomaly_ordering(sort_key, sort_order)
    dialect_name = session.get_bind().dialect.name
    query = _apply_anomaly_filters(
        select(AnomalyRecord),
        status_filter=status_filter,
        severity=severity,
        rule_id=rule_id,
        search=search,
        dialect_name=dialect_name,
    )
    count_query = _apply_anomaly_filters(
        select(AnomalyRecord.id),
        status_filter=status_filter,
        severity=severity,
        rule_id=rule_id,
        search=search,
        dialect_name=dialect_name,
    )
    if push_status == "in_transit":
        in_transit_ids = _in_transit_anomaly_ids(session)
        query = query.where(AnomalyRecord.id.in_(in_transit_ids))
        count_query = count_query.where(AnomalyRecord.id.in_(in_transit_ids))
    start = max(page - 1, 0) * min(max(page_size, 1), 100)
    size = min(max(page_size, 1), 100)
    total = session.scalar(select(func.count()).select_from(count_query.subquery())) or 0
    page_items = list(session.scalars(
        query.order_by(ordering, AnomalyRecord.id.asc()).limit(size).offset(start)
    ))
    statuses_by_anomaly: dict[str, list[str]] = {}
    if page_items:
        for anomaly_id, delivery_status, _count in session.execute(
            select(
                NotificationDelivery.anomaly_id,
                NotificationDelivery.status,
                func.count(NotificationDelivery.id),
            ).where(
                NotificationDelivery.anomaly_id.in_([item.id for item in page_items])
            ).group_by(NotificationDelivery.anomaly_id, NotificationDelivery.status)
        ):
            statuses_by_anomaly.setdefault(anomaly_id, []).append(delivery_status)
    items = []
    for item in page_items:
        statuses = statuses_by_anomaly.get(item.id, [])
        delivery = (
            "failed" if "failed" in statuses
            else "sent" if statuses and all(s in {"sent", "aborted"} for s in statuses) and "sent" in statuses
            else "aborted" if statuses and all(s == "aborted" for s in statuses)
            else "pending" if statuses else "none"
        )
        items.append(anomaly_dict(item, delivery))
    return {"items": items, "total": total, "page": page, "page_size": size}


@router.get("/anomalies/export")
def export_anomalies(
    status_filter: str | None = None,
    push_status: Literal["in_transit"] | None = None,
    severity: str | None = None,
    rule_id: str | None = None,
    search: str | None = None,
    sort_key: Literal["occurredAt", "severity"] = "occurredAt",
    sort_order: Literal["asc", "desc"] = "desc",
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "rule_name", "dataset_name", "severity", "status", "business_key", "first_seen_at", "last_seen_at", "hit_count"])
    query = _apply_anomaly_filters(
        select(AnomalyRecord),
        status_filter=status_filter,
        severity=severity,
        rule_id=rule_id,
        search=search,
        dialect_name=session.get_bind().dialect.name,
    )
    if push_status == "in_transit":
        query = query.where(AnomalyRecord.id.in_(_in_transit_anomaly_ids(session)))
    for item in session.scalars(query.order_by(
        _anomaly_ordering(sort_key, sort_order), AnomalyRecord.id.asc()
    )):
        writer.writerow([item.id, item.rule_name, item.dataset_name, item.severity, item.status, item.business_key, item.first_seen_at, item.last_seen_at, item.hit_count])
    return Response(output.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=anomalies.csv"})


@router.get("/anomalies/{anomaly_id}")
def get_anomaly(
    anomaly_id: str,
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    item = session.get(AnomalyRecord, anomaly_id)
    if not item:
        raise HTTPException(404, "异常记录不存在")
    body = anomaly_dict(item)
    body["last_sql_validation_result"] = item.last_sql_validation_result
    body["timeline"] = [
        {"type": event.event_type, "description": event.description, "created_at": event.created_at}
        for event in session.scalars(select(AnomalyEvent).where(AnomalyEvent.anomaly_id == item.id).order_by(AnomalyEvent.created_at))
    ]
    body["deliveries"] = [
        {"receive_id_type": d.receive_id_type, "recipient": d.recipient, "status": d.status, "attempts": d.attempts, "message_id": d.message_id, "last_error": d.last_error}
        for d in session.scalars(select(NotificationDelivery).where(NotificationDelivery.anomaly_id == item.id))
    ]
    body["validation_requests"] = [
        {
            "recipient_user_id": request.recipient_user_id,
            "delivery_status": request.delivery_status,
            "delivery_attempts": request.delivery_attempts,
            "message_id": request.message_id,
            "last_error": request.last_error,
            "delivered_at": request.delivered_at,
        }
        for request in session.scalars(
            select(AnomalyValidationRequest).where(AnomalyValidationRequest.anomaly_id == item.id)
        )
    ]
    group_delivery_ids = select(AnomalyGroupBroadcastDelivery.id).join(
        AnomalyRecordGroupMember,
        and_(
            AnomalyRecordGroupMember.rule_id == AnomalyGroupBroadcastDelivery.rule_id,
            AnomalyRecordGroupMember.detected_at == AnomalyGroupBroadcastDelivery.detected_at,
        ),
    ).where(AnomalyRecordGroupMember.anomaly_id == item.id)
    body["push_jobs"] = [
        {
            "id": job.id,
            "kind": job.kind,
            "status": job.status,
            "publish_attempts": job.publish_attempts,
            "dispatch_attempts": job.dispatch_attempts,
            "next_attempt_at": job.next_attempt_at,
            "last_error": job.last_error,
            "updated_at": job.updated_at,
        }
        for job in session.scalars(
            select(AnomalyPushJob)
            .where(or_(
                AnomalyPushJob.anomaly_id == item.id,
                and_(
                    AnomalyPushJob.kind == "group_broadcast",
                    AnomalyPushJob.delivery_id.in_(group_delivery_ids),
                ),
            ))
            .order_by(AnomalyPushJob.created_at, AnomalyPushJob.id)
        )
    ]
    submission = session.scalar(
        select(AnomalyValidationSubmission).where(AnomalyValidationSubmission.anomaly_id == item.id)
    )
    body["validation_submission"] = None if submission is None else {
        "submitted_by_user_id": submission.submitted_by_user_id,
        "submitted_text": submission.submitted_text,
        "validator_type": submission.validator_type,
        "result": submission.result,
        "result_detail": submission.result_detail,
        "submitted_at": submission.submitted_at,
    }
    return body


def _set_anomaly_status(
    item: AnomalyRecord,
    payload: AnomalyStatusUpdate,
    session: Session,
    resolver: str,
) -> bool:
    changed = transition_anomaly(
        session,
        item,
        payload.status,
        source="manual" if payload.status == "resolved" else None,
        user_id=resolver if payload.status == "resolved" else None,
    )
    if payload.assignee is not None:
        item.assignee = payload.assignee.strip() or None
    if changed:
        session.add(AnomalyEvent(
            anomaly_id=item.id,
            event_type="status_changed",
            description=f"状态更新为 {payload.status}",
        ))
    return changed


@router.patch("/anomalies/{anomaly_id}/status")
def update_anomaly_status(
    anomaly_id: str,
    payload: AnomalyStatusUpdate,
    session: Session = Depends(get_session),
    admin_username: str = Depends(get_current_admin),
):
    item = session.get(AnomalyRecord, anomaly_id)
    if not item:
        raise HTTPException(404, "异常记录不存在")
    try:
        _set_anomaly_status(item, payload, session, admin_username)
    except InvalidValidationTransition as exc:
        session.rollback()
        raise HTTPException(409, str(exc)) from exc
    session.commit()
    return anomaly_dict(item)


@router.post("/anomalies/bulk-status")
def bulk_anomaly_status(
    payload: BulkAnomalyStatusUpdate,
    session: Session = Depends(get_session),
    admin_username: str = Depends(get_current_admin),
):
    items = list(session.scalars(select(AnomalyRecord).where(AnomalyRecord.id.in_(payload.ids))))
    items_by_id = {item.id: item for item in items}
    missing_ids = list(dict.fromkeys(item_id for item_id in payload.ids if item_id not in items_by_id))
    if missing_ids:
        raise HTTPException(404, f"异常记录不存在: {', '.join(missing_ids)}")
    try:
        for item_id in dict.fromkeys(payload.ids):
            _set_anomaly_status(items_by_id[item_id], payload, session, admin_username)
    except InvalidValidationTransition as exc:
        session.rollback()
        raise HTTPException(409, str(exc)) from exc
    session.commit()
    return {"updated": len(items_by_id)}


@router.get("/overview")
def overview(
    session: Session = Depends(get_session),
    _reader: User = Depends(get_current_reader),
):
    anomalies = list(session.scalars(select(AnomalyRecord)))
    rules = list(session.scalars(select(Rule).where(Rule.deleted_at.is_(None))))
    datasources = list(session.scalars(select(Datasource)))
    datasets = list(session.scalars(select(Dataset)))
    push_in_transit_anomalies = session.scalar(
        select(func.count()).select_from(_in_transit_anomaly_ids(session).subquery())
    ) or 0
    return {
        "stats": {
            "pending_records": sum(a.status == "pending" for a in anomalies),
            "processing_records": sum(a.status == "processing" for a in anomalies),
            "timed_out_records": sum(a.status == "timed_out" for a in anomalies),
            "resolved_records": sum(a.status == "resolved" for a in anomalies),
            "critical_anomalies": sum(a.severity == "critical" and a.status != "resolved" for a in anomalies),
            "push_in_transit_anomalies": push_in_transit_anomalies,
            "active_rules": sum(r.enabled for r in rules), "total_rules": len(rules),
            "online_datasources": sum(d.status == "online" for d in datasources), "total_datasources": len(datasources),
            "total_datasets": len(datasets),
        },
        "recent_anomalies": [anomaly_dict(item) for item in sorted(anomalies, key=lambda a: a.last_seen_at, reverse=True)[:5]],
        "top_rules": [
            {"id": rule.id, "name": rule.name, "dataset_name": rule.dataset.name, "anomaly_count": sum(a.rule_id == rule.id for a in anomalies)}
            for rule in rules
        ],
    }
