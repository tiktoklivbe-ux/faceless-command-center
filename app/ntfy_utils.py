"""
ntfy.sh -- a free, open-source push notification service. No account, no
signup, no card, ever: pick a topic name (anyone who knows it can push to
it AND read what's sent to it on the public server, so it's treated like a
secret here, the same as an API key -- a long random name is what actually
keeps it private, not any access control on ntfy's end), install the free
app, subscribe to that topic, done.

https://ntfy.sh/docs/publish/ -- publishing is just an HTTP POST with the
message as the body; no auth needed for the public instance.
"""
import logging

import requests

log = logging.getLogger("ntfy")

NTFY_URL = "https://ntfy.sh"


def send_ntfy_message(topic: str, message: str, title: str = "Jarvis") -> bool:
    """Returns False (and logs) on any failure rather than raising -- an
    alert that fails to send should never crash whatever triggered it."""
    topic = (topic or "").strip()
    if not topic or not message:
        return False
    try:
        resp = requests.post(
            f"{NTFY_URL}/{topic}",
            data=message[:2000].encode("utf-8"),
            headers={"Title": title, "Priority": "default"},
            timeout=15,
        )
        if resp.status_code >= 300:
            log.error("ntfy send failed (%s): %s", resp.status_code, resp.text[:300])
            return False
        return True
    except requests.RequestException as e:
        log.error("ntfy send failed: %s", e)
        return False
