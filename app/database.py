import logging
import sqlite3 as _sqlite3
from pathlib import Path as _Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import DATABASE_URL

log = logging.getLogger("uvicorn.error")

# Filesystem path of the SQLite file, for the WAL self-heal below.
_DB_PATH = DATABASE_URL.replace("sqlite:///", "") if DATABASE_URL.startswith("sqlite:///") else ""


def _db_is_healthy(path: str) -> bool:
    """A real check, not a shallow one. ``SELECT 1`` doesn't read any table
    pages, so it happily passes on a database whose pages are corrupt -- which
    is exactly how a "database disk image is malformed" slipped past the first
    version of this heal and only blew up later inside create_all(). quick_check
    actually scans the pages, so it catches page-level corruption up front."""
    try:
        con = _sqlite3.connect(path, timeout=5)
        try:
            con.execute("PRAGMA journal_mode=WAL")  # surfaces bad -wal/-shm sidecars
            row = con.execute("PRAGMA quick_check").fetchone()
            return bool(row) and row[0] == "ok"
        finally:
            con.close()
    except _sqlite3.Error:
        return False


def _recover_corrupt_db(corrupt_path: str, dest_path: str) -> int:
    """Salvage what's readable from a malformed SQLite file into a fresh one.

    Dumps the old database as SQL and replays it into a brand-new file, skipping
    any statement that hits a corrupt page. iterdump walks sqlite_master then
    each table in turn, so even when one table's pages are damaged, the tables
    read before it -- crucially the small, early ``channels`` and ``settings``
    rows that hold the YouTube OAuth token, API keys and the posting schedule --
    are still recovered. Returns the number of statements successfully applied
    (0 means nothing could be salvaged)."""
    applied = 0
    src = _sqlite3.connect(corrupt_path, timeout=5)
    dst = _sqlite3.connect(dest_path, timeout=5)
    try:
        cur = dst.cursor()
        dump = src.iterdump()
        while True:
            try:
                stmt = next(dump)
            except StopIteration:
                break
            except _sqlite3.Error as e:
                # The dump generator hit a corrupt page -- stop, but keep
                # everything recovered up to this point.
                log.warning("Recovery stopped early at a corrupt page (%s); keeping %d statements.", e, applied)
                break
            try:
                cur.execute(stmt)
                applied += 1
            except _sqlite3.Error:
                continue  # skip one bad row/statement, keep going
        dst.commit()
    finally:
        src.close()
        dst.close()
    return applied


def heal_sqlite_if_needed():
    """Get the app booting again after SQLite corruption, preserving data.

    A hard stop mid-write -- a cancelled render, an OOM kill, a redeploy landing
    mid-transaction -- corrupted the database on 2026-08-13 and crash-looped the
    app (permanent 502). Two distinct failure modes, handled in order:

    1. Corrupt ``-wal``/``-shm`` sidecar files: every connect fails at
       ``PRAGMA journal_mode=WAL`` with "disk I/O error". The main file is fine;
       deleting the sidecars fixes it (SQLite regenerates them).
    2. The main ``app.db`` itself is malformed ("database disk image is
       malformed"): actual page corruption. Here we quarantine the bad file and
       rebuild a fresh one from whatever is still readable, so the channels
       (incl. the YouTube OAuth token) and settings survive rather than being
       lost to a from-scratch database.

    A no-op on a healthy boot.
    """
    if not _DB_PATH:
        return
    if not _Path(_DB_PATH).exists():
        return  # brand-new install; create_all will make it fresh
    if _db_is_healthy(_DB_PATH):
        return

    # --- stage 1: bad sidecars ------------------------------------------------
    for suffix in ("-wal", "-shm"):
        p = _Path(_DB_PATH + suffix)
        try:
            if p.exists():
                p.unlink()
                log.warning("Removed possibly-corrupt SQLite sidecar %s", p.name)
        except OSError as e:
            log.warning("Couldn't remove %s: %s", p.name, e)
    if _db_is_healthy(_DB_PATH):
        log.warning("SQLite recovered after clearing sidecar files.")
        return

    # --- stage 2: the main file is malformed ---------------------------------
    import time as _time
    quarantine = f"{_DB_PATH}.corrupt-{int(_time.time())}"
    recovered = f"{_DB_PATH}.recovered"
    try:
        _Path(_DB_PATH).rename(quarantine)
    except OSError as e:
        log.error("DB is malformed but couldn't be moved aside (%s) -- the disk may be "
                  "read-only or full; cannot auto-recover.", e)
        return
    for stale in (recovered, _DB_PATH + "-wal", _DB_PATH + "-shm"):
        try:
            _Path(stale).unlink()
        except OSError:
            pass

    log.error("SQLite main database was MALFORMED. Quarantined it as %s and attempting to "
              "salvage data into a fresh file.", _Path(quarantine).name)
    try:
        applied = _recover_corrupt_db(quarantine, recovered)
    except Exception as e:  # recovery must never itself crash the boot
        log.error("Recovery attempt failed outright (%s).", e)
        applied = 0

    if applied > 0 and _db_is_healthy(recovered):
        try:
            _Path(recovered).rename(_DB_PATH)
            log.warning("Recovered %d statements into a fresh, healthy database. "
                        "The corrupt original is kept at %s for inspection.", applied, _Path(quarantine).name)
            return
        except OSError as e:
            log.error("Couldn't swap the recovered database into place (%s).", e)

    # Salvage failed -- leave the quarantined corrupt file in place for a manual
    # `sqlite3 .recover` later, and let create_all() build a fresh empty DB so
    # the app at least boots. (Fresh DB = channels/settings/OAuth must be
    # re-entered; the quarantined file still holds the originals.)
    try:
        _Path(recovered).unlink()
    except OSError:
        pass
    log.error("Could not salvage the corrupt database. Booting with a FRESH empty database; "
              "the original is preserved at %s for manual recovery.", _Path(quarantine).name)

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
