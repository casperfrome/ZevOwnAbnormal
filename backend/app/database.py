from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


def make_session_factory(database_url: str, testing: bool = False):
    kwargs = {"pool_pre_ping": True}
    if testing:
        kwargs.update({"connect_args": {"check_same_thread": False}, "poolclass": StaticPool})
    engine = create_engine(database_url, **kwargs)
    return engine, sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
