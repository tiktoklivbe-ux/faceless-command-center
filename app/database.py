from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import DATABASE_URL

# busy_timeout makes concurrent writers wait-and-retry instead of failing
# immediately; WAL mode lets Chronos's background loop, the web requests, and
# a running video job all touch the database at the same time without
# blocking each other on reads. Without this, a background auto-generated
# job and someone browsing the Jobs panel at the same moment can produce
# "database is locked" errors under SQLite's default rollback-journal mode.
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401 -- ensure models are registered
    Base.metadata.create_all(bind=engine)
