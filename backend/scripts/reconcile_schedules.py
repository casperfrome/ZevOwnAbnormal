from __future__ import annotations

import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

def main() -> None:
    from app.config import get_settings
    from app.database import make_session_factory
    from app.scheduler_service import reconcile_enabled_rules

    settings = get_settings()
    engine, factory = make_session_factory(settings.database_url)
    try:
        with factory() as session:
            result = reconcile_enabled_rules(session, settings)
        print(f"reconcile complete: total={result['total']} synced={result['synced']} failed={result['failed']}")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
