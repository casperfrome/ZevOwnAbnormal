import asyncio
from contextlib import asynccontextmanager
from contextlib import suppress
import logging
import secrets
from pathlib import Path
import threading

import bcrypt
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .api import get_current_user, internal_router, router
from .anomaly_group_service import queue_due_timeout_broadcasts
from .config import SESSION_COOKIE, Settings, get_settings
from .database import Base, make_session_factory
from .models import AnomalyPushPipelineState, User
from .security import issue_session_token
from .push_pipeline import (
    ConfluentKafkaGateway,
    DolphinPushScheduler,
    consume_one,
    publish_pending_jobs,
    queue_due_group_broadcast_push_jobs,
    queue_due_notification_push_jobs,
    queue_due_validation_push_jobs,
    reconcile_completed_push_jobs,
    requeue_stale_push_jobs,
)
from .scheduler_service import reconcile_enabled_rules
from .validation_service import expire_due_anomalies, reconcile_validation_cards


TEST_SESSION_SECRET = "test-session-secret-that-is-long-enough"
logger = logging.getLogger(__name__)


def run_deadline_scan_cycle(
    session_factory,
    settings: Settings,
    stop_event: threading.Event | None = None,
) -> None:
    should_stop = stop_event.is_set if stop_event is not None else None
    with session_factory() as session:
        queue_due_timeout_broadcasts(session, settings, limit=settings.validation_maintenance_batch_size,
                                     should_stop=should_stop)
        expire_due_anomalies(
            session,
            limit=settings.validation_maintenance_batch_size,
            should_stop=should_stop,
        )


def run_validation_maintenance_cycle(session_factory, settings: Settings,
                                     stop_event: threading.Event | None = None) -> None:
    should_stop = stop_event.is_set if stop_event is not None else None
    with session_factory() as session:
        if should_stop is not None and should_stop():
            logger.warning("异常验证维护已取消，初始投递与卡片收敛留待下一轮")
            return
        queue_due_validation_push_jobs(
            session,
            limit=settings.validation_maintenance_batch_size,
        )
        if should_stop is not None and should_stop():
            logger.warning("异常验证维护已取消，终态卡片收敛留待下一轮")
            return
        reconcile_validation_cards(
            session,
            settings,
            limit=settings.validation_maintenance_batch_size,
            should_stop=should_stop,
        )


async def validation_maintenance_loop(session_factory, settings: Settings) -> None:
    await _maintenance_loop(session_factory, settings, run_validation_maintenance_cycle,
                            settings.validation_card_sync_interval_seconds)


async def deadline_scan_loop(session_factory, settings: Settings) -> None:
    await _maintenance_loop(session_factory, settings, run_deadline_scan_cycle,
                            settings.validation_timeout_scan_interval_seconds)


async def _maintenance_loop(session_factory, settings: Settings, run_cycle, interval: int) -> None:
    while True:
        stop_event = threading.Event()
        cycle = asyncio.create_task(asyncio.to_thread(
            run_cycle,
            session_factory,
            settings,
            stop_event,
        ))
        try:
            await asyncio.shield(cycle)
        except asyncio.CancelledError as cancelled:
            stop_event.set()
            try:
                await cycle
            except Exception:
                logger.exception("异常验证超时维护周期在关闭期间执行失败")
            raise cancelled
        except Exception:
            logger.exception("异常验证超时维护周期执行失败")
        await asyncio.sleep(interval)


def run_push_pipeline_cycle(session_factory, settings: Settings, app_state) -> None:
    if app_state.kafka_gateway is None:
        gateway = ConfluentKafkaGateway(settings)
        gateway.ensure_topic()
        app_state.kafka_gateway = gateway
    if app_state.push_scheduler is None:
        scheduler = DolphinPushScheduler(settings)
        scheduler.initialize()
        app_state.push_scheduler = scheduler
    with session_factory() as session:
        reconcile_completed_push_jobs(
            session, limit=settings.validation_maintenance_batch_size,
        )
        requeue_stale_push_jobs(
            session, settings, limit=settings.validation_maintenance_batch_size,
        )
        queue_due_validation_push_jobs(
            session, limit=settings.validation_maintenance_batch_size,
        )
        queue_due_notification_push_jobs(
            session, limit=settings.validation_maintenance_batch_size,
        )
        queue_due_group_broadcast_push_jobs(
            session, limit=settings.validation_maintenance_batch_size,
        )
        publish_pending_jobs(
            session, settings, app_state.kafka_gateway,
            limit=settings.validation_maintenance_batch_size,
        )
        consume_one(
            session, settings, app_state.kafka_gateway, app_state.push_scheduler,
            timeout=0.2,
        )


async def push_pipeline_loop(session_factory, settings: Settings, app_state) -> None:
    while True:
        cycle = asyncio.create_task(asyncio.to_thread(
            run_push_pipeline_cycle, session_factory, settings, app_state,
        ))
        try:
            await asyncio.shield(cycle)
        except asyncio.CancelledError as cancelled:
            try:
                await cycle
            except Exception:
                logger.exception("异常推送周期在关闭期间执行失败")
            raise cancelled
        except Exception:
            logger.exception("Kafka → DolphinScheduler 异常推送周期执行失败")
        await asyncio.sleep(1)


def create_app(testing: bool = False) -> FastAPI:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        datasource_encryption_key="y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y=",
        session_secret=TEST_SESSION_SECRET,
        internal_execution_token="change-this-internal-token",
        auto_login=True,
    ) if testing else get_settings()
    engine, session_factory = make_session_factory(settings.database_url, testing=testing)

    @asynccontextmanager
    async def lifespan(app_instance: FastAPI):
        Base.metadata.create_all(engine)
        with session_factory() as session:
            user = session.scalar(select(User).where(User.username == settings.superadmin_username))
            if not user:
                session.add(
                    User(
                        username=settings.superadmin_username,
                        password_hash=bcrypt.hashpw(settings.superadmin_password.encode(), bcrypt.gensalt()).decode(),
                        is_superuser=True,
                    )
                )
                session.commit()
            if session.get(AnomalyPushPipelineState, 1) is None:
                session.add(AnomalyPushPipelineState(id=1, generation=1))
                session.commit()
            if not testing and settings.reconcile_on_startup:
                reconcile_enabled_rules(session, settings)
        maintenance_task = None
        deadline_task = None
        push_pipeline_task = None
        if not testing:
            deadline_task = asyncio.create_task(deadline_scan_loop(session_factory, settings), name="deadline-scan")
            maintenance_task = asyncio.create_task(
                validation_maintenance_loop(session_factory, settings),
                name="validation-maintenance",
            )
            push_pipeline_task = asyncio.create_task(
                push_pipeline_loop(session_factory, settings, app_instance.state),
                name="anomaly-push-pipeline",
            )
        app_instance.state.validation_maintenance_task = maintenance_task
        app_instance.state.deadline_scan_task = deadline_task
        app_instance.state.push_pipeline_task = push_pipeline_task
        try:
            yield
        finally:
            if deadline_task is not None:
                deadline_task.cancel()
                with suppress(asyncio.CancelledError):
                    await deadline_task
            if maintenance_task is not None:
                maintenance_task.cancel()
                with suppress(asyncio.CancelledError):
                    await maintenance_task
            if push_pipeline_task is not None:
                push_pipeline_task.cancel()
                with suppress(asyncio.CancelledError):
                    await push_pipeline_task
            kafka_close = getattr(app_instance.state.kafka_gateway, "close", None)
            if callable(kafka_close):
                kafka_close()
            scheduler_close = getattr(app_instance.state.push_scheduler, "close", None)
            if callable(scheduler_close):
                scheduler_close()
            engine.dispose()

    app = FastAPI(title="Sentinel 数据异常监控平台", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.validation_maintenance_task = None
    app.state.push_pipeline_task = None
    app.state.kafka_gateway = None
    app.state.push_scheduler = None
    app.include_router(router)
    app.include_router(internal_router)

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    def me(response: Response, user: User = Depends(get_current_user)) -> dict[str, object]:
        if settings.auto_login:
            token = issue_session_token(user.username, user.is_superuser, settings.session_secret)
            response.set_cookie(
                SESSION_COOKIE,
                token,
                httponly=True,
                samesite="lax",
                secure=False,
                max_age=86400,
            )
        return {"id": user.id, "username": user.username, "is_superuser": user.is_superuser}

    @app.post("/api/v1/auth/login")
    def login(payload: dict, response: Response):
        with session_factory() as session:
            user = session.scalar(select(User).where(User.username == payload.get("username", "")))
            if not user or not bcrypt.checkpw(str(payload.get("password", "")).encode(), user.password_hash.encode()):
                raise HTTPException(401, "用户名或密码错误")
            token = issue_session_token(user.username, user.is_superuser, settings.session_secret)
            response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", secure=False, max_age=86400)
            return {"id": user.id, "username": user.username, "is_superuser": user.is_superuser}

    @app.post("/api/internal/rules/{rule_id}/execute")
    def internal_execute(rule_id: str, x_internal_token: str = Header(default="")):
        if not secrets.compare_digest(x_internal_token, settings.internal_execution_token):
            raise HTTPException(401, "内部令牌无效")
        from .execution_service import RuleExecutionConflict, execute_rule
        with session_factory() as session:
            try:
                run = execute_rule(session, settings, rule_id, "dolphinscheduler")
            except RuleExecutionConflict as exc:
                raise HTTPException(409, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(404, str(exc)) from exc
            if run.status != "success":
                raise HTTPException(502, run.error_message or "规则执行失败")
            return {"run_id": run.id, "status": run.status, "new_anomalies": run.new_anomalies}

    frontend = Path(__file__).resolve().parents[2] / "frontend"
    if frontend.exists() and not testing:
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


app = create_app()
