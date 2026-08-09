from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .dolphinscheduler import DolphinSchedulerClient
from .models import Rule


def sync_rule_record(
    rule: Rule,
    settings: Settings,
    session: Session,
    client_factory: Callable[[Settings], DolphinSchedulerClient] = DolphinSchedulerClient,
) -> bool:
    """Synchronize one rule and persist the result without leaking credentials."""
    client = client_factory(settings)
    try:
        workflow_code, schedule_id = client.sync_rule(rule)
        rule.ds_workflow_code = str(workflow_code)
        rule.ds_schedule_id = schedule_id
        rule.sync_status = "synced"
        rule.sync_error = None
        success = True
    except Exception as exc:
        rule.enabled = False
        rule.sync_status = "sync_error"
        rule.sync_error = str(exc)[:2000]
        success = False
    finally:
        client.close()
        session.commit()
    return success


def reconcile_enabled_rules(session: Session, settings: Settings) -> dict[str, int]:
    rules = list(
        session.scalars(
            select(Rule).where(Rule.enabled.is_(True), Rule.deleted_at.is_(None)).order_by(Rule.created_at)
        )
    )
    synced = sum(sync_rule_record(rule, settings, session) for rule in rules)
    return {"total": len(rules), "synced": synced, "failed": len(rules) - synced}
