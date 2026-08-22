import csv
import io

import httpx
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import feishu as feishu_gateway
from .config import SESSION_COOKIE, Settings
from .execution_service import RuleExecutionConflict, execute_rule
from .models import (
    AnomalyEvent,
    AnomalyRecord,
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
from .validation_service import (
    InvalidValidationTransition,
    ValidationRecipientError,
    ValidationTextError,
    build_validation_card,
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


def get_current_admin(
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
) -> str:
    if settings.auto_login:
        return settings.superadmin_username
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
    if not user.is_superuser:
        raise HTTPException(403, "需要超级管理员权限")
    return user.username


@router.post("/tests/feishu-message")
def test_feishu_message(
    payload: FeishuMessageTestRequest,
    settings: Settings = Depends(get_app_settings),
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
    return {
        "toast": {"type": toast_type, "content": content},
        "card": build_validation_card(anomaly, settings.sentinel_public_base_url),
    }


@internal_router.post("/feishu/card-actions")
def feishu_card_action(
    payload: FeishuCardActionCallback,
    x_internal_token: str = Header(default=""),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
):
    if x_internal_token != settings.internal_execution_token:
        raise HTTPException(401, "内部令牌无效")
    if payload.action != "submit_validation":
        raise HTTPException(400, "不支持的飞书卡片操作")

    anomaly_id = session.scalar(select(AnomalyRecord.id).where(AnomalyRecord.id == payload.anomaly_id))
    if anomaly_id is None:
        raise HTTPException(404, "异常记录不存在")
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

    try:
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
    except Exception as exc:
        session.rollback()
        raise HTTPException(500, "处理飞书回调失败") from exc

    if result.outcome == "accepted":
        return _card_action_result("success", "验证已提交，异常已解决", anomaly_id, session, settings)
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
        "schedule": item.schedule,
        "notification_targets": item.notification_targets,
        "validation_enabled": item.validation_enabled,
        "validation_targets": item.validation_targets,
        "validation_timeout_minutes": item.validation_timeout_minutes,
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


def run_dict(item: RuleRun) -> dict:
    return {
        "id": item.id, "rule_id": item.rule_id, "trigger_source": item.trigger_source,
        "status": item.status, "scanned_rows": item.scanned_rows, "matched_rows": item.matched_rows,
        "new_anomalies": item.new_anomalies, "error_message": item.error_message,
        "started_at": item.started_at, "finished_at": item.finished_at,
    }


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
        "delivery_status": delivery_status or "none",
    }


@router.get("/datasources")
def list_datasources(session: Session = Depends(get_session)):
    return [datasource_dict(item) for item in session.scalars(select(Datasource).order_by(Datasource.created_at.desc()))]


@router.post("/datasources", status_code=status.HTTP_201_CREATED)
def create_datasource(payload: DatasourceCreate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def test_datasource_config(payload: DatasourceCreate):
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
def get_datasource(datasource_id: str, session: Session = Depends(get_session)):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    return datasource_dict(item)


@router.patch("/datasources/{datasource_id}")
def update_datasource(datasource_id: str, payload: DatasourceUpdate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def delete_datasource(datasource_id: str, session: Session = Depends(get_session)):
    item = session.get(Datasource, datasource_id)
    if not item:
        raise HTTPException(404, "数据源不存在")
    if item.datasets:
        raise HTTPException(409, "数据源已被数据集引用")
    session.delete(item)
    session.commit()


@router.post("/datasources/{datasource_id}/test")
def test_datasource(datasource_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def list_datasets(session: Session = Depends(get_session)):
    return [dataset_dict(item) for item in session.scalars(select(Dataset).order_by(Dataset.created_at.desc()))]


@router.post("/datasets", status_code=status.HTTP_201_CREATED)
def create_dataset(payload: DatasetCreate, session: Session = Depends(get_session)):
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
def get_dataset(dataset_id: str, session: Session = Depends(get_session)):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    return dataset_dict(item)


@router.patch("/datasets/{dataset_id}")
def update_dataset(dataset_id: str, payload: DatasetUpdate, session: Session = Depends(get_session)):
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
def delete_dataset(dataset_id: str, session: Session = Depends(get_session)):
    item = session.get(Dataset, dataset_id)
    if not item:
        raise HTTPException(404, "数据集不存在")
    if item.rules:
        raise HTTPException(409, "数据集已被规则引用")
    session.delete(item)
    session.commit()


@router.post("/datasets/{dataset_id}/execute")
def execute_saved_dataset(dataset_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def execute_ad_hoc_dataset(payload: dict, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def list_rules(session: Session = Depends(get_session)):
    query = select(Rule).where(Rule.deleted_at.is_(None)).order_by(Rule.created_at.desc())
    return [rule_dict(item) for item in session.scalars(query)]


@router.post("/rules", status_code=201)
def create_rule(payload: RuleCreate, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
    dataset = session.get(Dataset, payload.dataset_id)
    if not dataset:
        raise HTTPException(404, "数据集不存在")
    item = Rule(**payload.model_dump(mode="json", exclude={"enabled"}), sync_status="pending", enabled=False)
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
def get_rule(rule_id: str, session: Session = Depends(get_session)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    return rule_dict(item)


@router.put("/rules/{rule_id}")
def update_rule(rule_id: str, payload: RuleCreate, session: Session = Depends(get_session)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    for key, value in payload.model_dump(mode="json", exclude={"enabled"}).items():
        setattr(item, key, value)
    item.sync_status = "pending"
    item.sync_error = None
    session.commit()
    return rule_dict(item)


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    item.enabled = False
    if item.ds_schedule_id:
        _sync_rule(item, settings, session)
    item.deleted_at = utcnow()
    session.commit()


@router.post("/rules/{rule_id}/execute")
def execute_rule_manually(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def sync_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    _sync_rule(item, settings, session)
    if item.sync_status == "sync_error":
        raise HTTPException(502, item.sync_error)
    return rule_dict(item)


@router.post("/rules/{rule_id}/enable")
def enable_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
    item = session.get(Rule, rule_id)
    if not item or item.deleted_at:
        raise HTTPException(404, "规则不存在")
    item.enabled = True
    _sync_rule(item, settings, session)
    if not item.enabled:
        raise HTTPException(502, item.sync_error or "调度同步失败")
    return rule_dict(item)


@router.post("/rules/{rule_id}/disable")
def disable_rule(rule_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_app_settings)):
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
def get_rule_run(run_id: str, session: Session = Depends(get_session)):
    item = session.get(RuleRun, run_id)
    if not item:
        raise HTTPException(404, "执行批次不存在")
    return run_dict(item)


@router.get("/anomalies")
def list_anomalies(
    page: int = 1,
    page_size: int = 20,
    status_filter: str | None = None,
    severity: str | None = None,
    rule_id: str | None = None,
    search: str | None = None,
    session: Session = Depends(get_session),
):
    query = select(AnomalyRecord).order_by(AnomalyRecord.last_seen_at.desc())
    if status_filter:
        query = query.where(AnomalyRecord.status == status_filter)
    if severity:
        query = query.where(AnomalyRecord.severity == severity)
    if rule_id:
        query = query.where(AnomalyRecord.rule_id == rule_id)
    if search:
        query = query.where(AnomalyRecord.rule_name.contains(search))
    all_items = list(session.scalars(query))
    start = max(page - 1, 0) * min(max(page_size, 1), 100)
    size = min(max(page_size, 1), 100)
    items = []
    for item in all_items[start:start + size]:
        statuses = list(session.scalars(select(NotificationDelivery.status).where(NotificationDelivery.anomaly_id == item.id)))
        delivery = "failed" if "failed" in statuses else "sent" if statuses and all(s == "sent" for s in statuses) else "pending" if statuses else "none"
        items.append(anomaly_dict(item, delivery))
    return {"items": items, "total": len(all_items), "page": page, "page_size": size}


@router.get("/anomalies/export")
def export_anomalies(session: Session = Depends(get_session)):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "rule_name", "dataset_name", "severity", "status", "business_key", "first_seen_at", "last_seen_at", "hit_count"])
    for item in session.scalars(select(AnomalyRecord).order_by(AnomalyRecord.last_seen_at.desc())):
        writer.writerow([item.id, item.rule_name, item.dataset_name, item.severity, item.status, item.business_key, item.first_seen_at, item.last_seen_at, item.hit_count])
    return Response(output.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=anomalies.csv"})


@router.get("/anomalies/{anomaly_id}")
def get_anomaly(anomaly_id: str, session: Session = Depends(get_session)):
    item = session.get(AnomalyRecord, anomaly_id)
    if not item:
        raise HTTPException(404, "异常记录不存在")
    body = anomaly_dict(item)
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
    submission = session.scalar(
        select(AnomalyValidationSubmission).where(AnomalyValidationSubmission.anomaly_id == item.id)
    )
    body["validation_submission"] = None if submission is None else {
        "submitted_by_user_id": submission.submitted_by_user_id,
        "submitted_text": submission.submitted_text,
        "validator_type": submission.validator_type,
        "result": submission.result,
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
def overview(session: Session = Depends(get_session)):
    anomalies = list(session.scalars(select(AnomalyRecord)))
    rules = list(session.scalars(select(Rule).where(Rule.deleted_at.is_(None))))
    datasources = list(session.scalars(select(Datasource)))
    datasets = list(session.scalars(select(Dataset)))
    return {
        "stats": {
            "pending_records": sum(a.status == "pending" for a in anomalies),
            "processing_records": sum(a.status == "processing" for a in anomalies),
            "timed_out_records": sum(a.status == "timed_out" for a in anomalies),
            "resolved_records": sum(a.status == "resolved" for a in anomalies),
            "critical_anomalies": sum(a.severity == "critical" and a.status != "resolved" for a in anomalies),
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
