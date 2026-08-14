import logging
import sqlite3 as _sqlite3
from pathlib import Path as _Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import DATABASE_URL

log = logging.getLogger("uvicorn.error")

# Filesystem path of the SQLite file, for the WAL self-heal below.
_DB_PATH = DATABASE_URL.replace("sqlite:///", "") if DATABASE_URL.startswith("sqlite:///") else ""


def heal_sqlite_if_needed():
    """Recover from corrupt SQLite WAL sidecar files before opening the engine.

    A hard stop mid-write -- a cancelled render, an OOM kill, a redeploy landing
    mid-transaction -- can leave the ``-wal``/``-shm`` sidecar files corrupt.
    After that, EVERY connection fails at ``PRAGMA journal_mode=WAL`` with
    "disk I/O error", and because that pragma runs on connect, the whole app
    crash-loops on boot (the 502 seen 2026-08-13). The main ``app.db`` is fine;
    only the sidecars are bad, and deleting them is safe -- SQLite regenerates
    them and the only loss is any transaction still sitting uncheckpointed in
    the WAL, an acceptable trade for the app actually starting.

    Does nothing if the database opens cleanly, so it's a no-op on a healthy
    boot. Only touches the sidecars when a real query genuinely fails.
    """
    if not _DB_PATH:
        return
    try:
        con = _sqlite3.connect(_DB_PATH, timeout=5)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("SELECT 1")
        con.close()
        return  # healthy -- leave everything alone
    except _sqlite3.Error as e:
        log.warning("SQLite failed to open (%s); clearing WAL sidecar files and retrying.", e)

    for suffix in ("-wal", "-shm"):
        p = _Path(_DB_PATH + suffix)
        try:
            if p.exists():
                p.unlink()
                log.warning("Removed possibly-corrupt SQLite sidecar %s", p.name)
        except OSError as e:
            log.warning("Couldn't remove %s: %s", p.name, e)

    # Best-effort: reopen in the plain rollback-journal mode (no sidecars needed)
    # to confirm it's healthy now. If this still fails, the problem is the disk
    # itself (full/unmounted), not the WAL, and no code change can fix that.
    try:
        con = _sqlite3.connect(_DB_PATH, timeout=5)
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("SELECT 1")
        con.close()
        log.warning("SQLite recovered after clearing sidecar files.")
    except _sqlite3.Error as e:
        log.error("SQLite STILL failing after sidecar cleanup (%s) -- likely a full or "
                  "unavailable disk, not WAL corruption.", e)

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
    # WAL needs healthy -wal/-shm sidecar files. If they're corrupt, setting WAL
    # raises "disk I/O error" -- and since this runs on EVERY connect, an
    # unguarded failure here crash-loops the whole app. heal_sqlite_if_needed()
    # clears bad sidecars at boot, but guard anyway so a single bad connection
    # degrades to the plain rollback journal instead of taking the app down.
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
    except Exception as e:
        log.warning("Could not enable WAL on this connection (%s); using rollback journal.", e)
        try:
            cursor.execute("PRAGMA journal_mode=DELETE")
        except Exception:
            pass
    try:
        cursor.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        # Keeps the WAL file from growing unbounded during a long render, which
        # otherwise makes every later read progressively slower.
        cursor.execute("PRAGMA wal_autocheckpoint=200")
    except Exception:
        pass
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
    # Clear any corrupt WAL sidecar files BEFORE the engine opens its first
    # connection, so a bad-sidecar boot self-heals instead of crash-looping.
    heal_sqlite_if_needed()
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
                if col.name not in existing:
                    col_type = col.type.compile(engine.dialect)
                    conn.exec_driver_sql(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}')
                # ALTER TABLE ADD COLUMN has no DEFAULT clause here, so every
                # EXISTING row gets NULL for the new column even when the
                # model itself declares a default (e.g. Channel.auto_longform_
                # per_day = 0) -- a real bug that took /api/channels down in
                # production the moment a column added this way actually
                # shipped: Pydantic's response schema types that field as a
                # plain int (not Optional), so it rejected the NULL and
                # 500'd on every pre-existing channel. This backfill runs
                # unconditionally, not only inside the "just added" branch
                # above -- a column that was added by an EARLIER deploy,
                # before this backfill step existed (exactly the state
                # production was actually left in), still has real NULLs
                # sitting in it that a "only touch brand new columns" version
                # of this fix would never reach. Only a genuinely scalar
                # default (0, False, ""), never a callable one (gen_id,
                # datetime.utcnow) -- applying the SAME generated value to
                # every affected row would be actively wrong for those.
                if col.default is not None and getattr(col.default, "is_scalar", False):
                    conn.exec_driver_sql(
                        f'UPDATE "{table.name}" SET "{col.name}" = ? WHERE "{col.name}" IS NULL',
                        (col.default.arg,),
                    )
        conn.commit()
