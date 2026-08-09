import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def db_session():
    from app.database import Base, make_session_factory

    engine, factory = make_session_factory("sqlite+pysqlite:///:memory:", testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        yield session
    engine.dispose()
