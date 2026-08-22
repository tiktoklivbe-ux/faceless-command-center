from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, business_utils, business_search
from ..database import get_db

router = APIRouter(prefix="/api/prospects", tags=["prospects"])


@router.get("/search")
def search_businesses(location: str, term: str = "", db: Session = Depends(get_db)):
    """Free lead search (OpenStreetMap) -- see business_search.py. Term is
    optional now: leave it blank for 'find me really anything nearby' rather
    than requiring a specific category guess. Doesn't touch the Prospect
    table at all; results are added as prospects explicitly, one click at a
    time, from the frontend."""
    if not location.strip():
        raise HTTPException(400, "Need a location to search near.")
    try:
        return business_search.search_businesses(term.strip(), location.strip())
    except Exception as e:
        raise HTTPException(502, f"Search failed: {e}")


@router.get("/find-email")
def find_email(website: str):
    """Best-effort: check a business's own public website for a contact
    email. Returns '' if nothing found -- optional enrichment, not required."""
    return {"email": business_search.find_contact_email(website)}


@router.get("", response_model=list[schemas.ProspectOut])
def list_prospects(db: Session = Depends(get_db)):
    return db.query(models.Prospect).order_by(models.Prospect.created_at.desc()).all()


@router.post("", response_model=schemas.ProspectOut)
def create_prospect(payload: schemas.ProspectIn, db: Session = Depends(get_db)):
    p = models.Prospect(**payload.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.get("/{prospect_id}", response_model=schemas.ProspectOut)
def get_prospect(prospect_id: str, db: Session = Depends(get_db)):
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    return p


@router.patch("/{prospect_id}", response_model=schemas.ProspectOut)
def update_prospect(prospect_id: str, payload: schemas.ProspectIn, db: Session = Depends(get_db)):
    """Edit a prospect's own info -- exists specifically because search
    results often arrive with no email (OSM rarely has one): this is how you
    fill it in later once you actually find it (a phone call, their website,
    wherever), rather than being stuck with whatever was there at creation."""
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    for k, v in payload.model_dump().items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return p


@router.delete("/{prospect_id}")
def delete_prospect(prospect_id: str, db: Session = Depends(get_db)):
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


@router.post("/{prospect_id}/status", response_model=schemas.ProspectOut)
def set_status(prospect_id: str, payload: schemas.ProspectStatusIn, db: Session = Depends(get_db)):
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    valid = {"new", "drafted", "contacted", "replied", "won", "lost"}
    if payload.status not in valid:
        raise HTTPException(400, f"Status must be one of: {', '.join(sorted(valid))}")
    p.status = payload.status
    if payload.status == "contacted":
        p.contacted_at = datetime.utcnow()
    db.commit()
    db.refresh(p)
    return p


@router.post("/{prospect_id}/draft-outreach", response_model=schemas.ProspectOut)
def draft_outreach(prospect_id: str, db: Session = Depends(get_db)):
    """AI drafts a personalized first-outreach email. Never sends anything --
    the frontend turns this into a mailto: link the user opens and sends
    themselves from their own email client."""
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    try:
        draft = business_utils.draft_outreach_email(db, p)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Couldn't generate a draft: {e}")
    p.draft_subject = draft["subject"]
    p.draft_body = draft["body"]
    if p.status == "new":
        p.status = "drafted"
    db.commit()
    db.refresh(p)
    return p


@router.post("/{prospect_id}/draft-reply", response_model=schemas.ProspectOut)
def draft_reply(prospect_id: str, payload: schemas.ProspectReplyIn, db: Session = Depends(get_db)):
    """Paste in what the prospect wrote back; AI drafts a response that
    actually addresses it. Same mailto:-only send path as outreach."""
    p = db.get(models.Prospect, prospect_id)
    if not p:
        raise HTTPException(404, "Prospect not found")
    if not payload.reply_text.strip():
        raise HTTPException(400, "Paste in what they actually wrote back first.")
    try:
        draft = business_utils.draft_reply_response(db, p, payload.reply_text)
    except Exception as e:
        raise HTTPException(502, f"Couldn't generate a draft: {e}")
    p.last_reply_text = payload.reply_text
    p.response_draft = draft["body"]
    p.status = "replied"
    db.commit()
    db.refresh(p)
    return p
