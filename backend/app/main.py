import asyncio
from contextlib import asynccontextmanager
from contextlib import suppress
import logging
from pathlib import Path
import threading

import bcrypt
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .api import get_current_user, internal_router, router
from .config import SESSION_COOKIE, Settings, get_settings
from .database import Base, make_session_factory
from .models import User
from .scheduler_service import reconcile_enabled_rules
from .validation_service import deliver_validation_requests, expire_due_anomalies, reconcile_validation_cards


TEST_SESSION_SECRET = "test-session-secret-that-is-long-enough"
logger = logging.getLogger(__name__)


def run_validation_maintenance_cycle(
    session_factory,
    settings: Settings,
    stop_event: threading.Event | None = None,
) -> None:
    should_stop = stop_event.is_set if stop_event is not None else None
    with session_factory() as session:
        expire_due_anomalies(
            session,
            limit=settings.validation_maintenance_batch_size,
            should_stop=should_stop,
        )
        if should_stop is not None and should_stop():
            logger.warning("异常验证维护已取消，初始投递与卡片收敛留待下一轮")
            return
        deliver_validation_requests(
            session,
            settings,
            limit=settings.validation_maintenance_batch_size,
            should_stop=should_stop,
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
    while True:
        stop_event = threading.Event()
        cycle = asyncio.create_task(asyncio.to_thread(
            run_validation_maintenance_cycle,
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
        await asyncio.sleep(settings.validation_timeout_scan_interval_seconds)


def create_app(testing: bool = False) -> FastAPI:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        datasource_encryption_key="y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y=",
        session_secret=TEST_SESSION_SECRET,
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
            if not testing and settings.reconcile_on_startup:
                reconcile_enabled_rules(session, settings)
        maintenance_task = None
        if not testing:
            maintenance_task = asyncio.create_task(
                validation_maintenance_loop(session_factory, settings),
                name="validation-maintenance",
            )
        app_instance.state.validation_maintenance_task = maintenance_task
        try:
            yield
        finally:
            if maintenance_task is not None:
                maintenance_task.cancel()
                with suppress(asyncio.CancelledError):
                    await maintenance_task
            engine.dispose()

    app = FastAPI(title="Sentinel 数据异常监控平台", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.validation_maintenance_task = None
    app.include_router(router)
    app.include_router(internal_router)

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/auth/me")
    def me(response: Response, user: User = Depends(get_current_user)) -> dict[str, object]:
        if settings.auto_login:
            token = jwt.encode(
                {"sub": user.username, "role": "superadmin" if user.is_superuser else "user"},
                settings.session_secret,
                algorithm="HS256",
            )
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
            token = jwt.encode({"sub": user.username, "role": "superadmin" if user.is_superuser else "user"}, settings.session_secret, algorithm="HS256")
            response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", secure=False, max_age=86400)
            return {"id": user.id, "username": user.username, "is_superuser": user.is_superuser}

    @app.post("/api/internal/rules/{rule_id}/execute")
    def internal_execute(rule_id: str, x_internal_token: str = Header(default="")):
        if x_internal_token != settings.internal_execution_token:
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
