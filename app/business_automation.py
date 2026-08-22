"""
Runs the Business pipeline's daily automation, called from scheduler._tick()
every 5 minutes (same pattern as check_and_send_alerts) but only actually
acts once per day, tracked via a stored last-run date. Off by default --
opt-in via business_auto_enabled, with a hard daily cap on how many new
prospects it creates (each one is a real AI-drafted email, i.e. real API
spend, so this is deliberately bounded rather than unlimited "search and
draft everything it finds").

Never sends anything. Same reasoning as the rest of the Business module:
this gets prospects found and drafts ready, the send is always the user's
own click.
"""
import logging
from datetime import datetime

from . import models, business_search, business_utils, ntfy_utils
from .settings_store import get_setting, set_setting

log = logging.getLogger("business_automation")


def check_business_automation(db) -> None:
    if get_setting(db, "business_auto_enabled", "") != "true":
        return

    today = datetime.utcnow().date().isoformat()
    if get_setting(db, "business_auto_last_run_date", "") == today:
        return  # already ran today

    location = get_setting(db, "business_auto_location", "").strip()
    if not location:
        return  # nothing to search near -- needs to be configured first

    # Marked as run BEFORE doing the actual work, not after -- so a crash or
    # timeout partway through doesn't leave it retrying every 5 minutes for
    # the rest of the day (the same watchdog-retry trap that caused the
    # YouTube-token-expiry credit waste earlier tonight, applied here too).
    set_setting(db, "business_auto_last_run_date", today, is_secret=False)

    term = get_setting(db, "business_auto_term", "").strip()
    try:
        daily_limit = max(1, min(int(get_setting(db, "business_auto_daily_limit", "5") or 5), 20))
    except ValueError:
        daily_limit = 5

    try:
        data = business_search.search_businesses(term, location)
    except Exception as e:
        log.exception("Business automation: search failed")
        return
    if data.get("error"):
        log.warning("Business automation: search error: %s", data["error"])
        return

    existing_names = {n.lower() for (n,) in db.query(models.Prospect.business_name).all()}
    added = []
    for r in data.get("results", []):
        if len(added) >= daily_limit:
            break
        name = (r.get("name") or "").strip()
        if not name or name.lower() in existing_names:
            continue
        p = models.Prospect(
            business_name=name,
            phone=r.get("phone", ""),
            website=r.get("website", ""),
            notes=f"Auto-found via daily search" + (f" ({r['category']})" if r.get("category") else ""),
        )
        db.add(p)
        db.commit()
        db.refresh(p)
        added.append(p)
        existing_names.add(name.lower())

    drafted = 0
    for p in added:
        try:
            draft = business_utils.draft_outreach_email(db, p)
            p.draft_subject, p.draft_body, p.status = draft["subject"], draft["body"], "drafted"
            db.commit()
            drafted += 1
        except Exception:
            log.exception("Business automation: draft failed for %s", p.business_name)

    if not added:
        return  # nothing new found -- no notification, avoids a daily "nothing happened" ping

    ntfy_topic = get_setting(db, "ntfy_topic", "")
    if ntfy_topic:
        msg = f"Found {len(added)} new prospect{'s' if len(added) != 1 else ''}, drafted {drafted} outreach email{'s' if drafted != 1 else ''}. Check the Business tab."
        try:
            ntfy_utils.send_ntfy_message(ntfy_topic, msg, title="Business search")
        except Exception:
            log.exception("Business automation: notification failed")
