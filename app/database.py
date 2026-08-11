from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import DATABASE_URL

# busy_timeout makes concurrent writers wait-and-retry instead of failing
# immediately; WAL mode lets Chronos's background loop, the web requests, and
# a running video job all touch the database at the same time without
# blocking each other on reads. Without this, a background auto-generated
# job and someone browsing the Jobs panel at the same moment can produce
# "database is locked" errors under SQLite's default rollback-journal mode.
#
# The timeout is deliberately SHORT (5s, not 30s). A video render holds its
# session open for minutes and commits progress lines throughout; with a 30s
# busy_timeout, any Jarvis request landing during that window could stall for
# up to 30 seconds per query -- and since a single Jarvis turn makes several
# queries across its tool loop, that compounded into multi-minute waits. A
# short timeout means a contended write gives up and surfaces quickly instead
# of silently hanging the whole request.
_BUSY_TIMEOUT_MS = 5000
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False, "timeout": 5})


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
    # Keeps the WAL file from growing unbounded during a long render, which
    # otherwise makes every later read progressively slower.
    cursor.execute("PRAGMA wal_autocheckpoint=200")
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
    _migrate_add_missing_columns()


def _migrate_add_missing_columns():
    """Add any columns present on the models but missing from the actual
    on-disk table.

    create_all() only creates tables that don't exist yet -- it never alters
    an existing table, so adding a column to a model (like VideoJob.worker_pid)
    does nothing to a database file from before that column existed. Without
    this, the app would crash with "no such column" the moment it tried to
    read or write that field on an existing install, rather than picking the
    new column up automatically. There's no migration framework here (this is
    a single-table SQLite app, not worth Alembic), so this does the one thing
    that framework would be for: bring an old file's schema up to date.
    """
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info('{table.name}')")}
            for col in table.columns:
                if col.name in existing:
                    continue
                col_type = col.type.compile(engine.dialect)
                conn.exec_driver_sql(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}')
        conn.commit()
