"""
Verifies that an incoming webhook request genuinely came from Twilio, not
someone who found the URL and is pretending to be your phone.

Twilio's request-signing scheme (documented at twilio.com/docs/usage/security):
take the exact URL Twilio POSTed to, append every POST param's name+value
(sorted by name, no separator), HMAC-SHA1 the result with your Auth Token,
base64-encode it, and compare to the X-Twilio-Signature header.

The URL has to be reconstructed from APP_BASE_URL rather than trusted from
the request object -- Render (and most hosts) terminate TLS at a proxy in
front of the app, so the request the app actually sees often reports
plain http:// even though Twilio really POSTed to https://. Using the
wrong scheme makes every signature check fail, which looks exactly like
"someone's spoofing me" when it's really just a URL mismatch.
"""
import base64
import hashlib
import hmac
import logging

import requests

from .config import APP_BASE_URL

log = logging.getLogger("twilio")


def verify_twilio_signature(auth_token: str, path: str, form_params: dict, signature: str) -> bool:
    if not auth_token or not signature:
        return False
    url = APP_BASE_URL.rstrip("/") + path
    data = url
    for key in sorted(form_params.keys()):
        data += key + form_params[key]
    expected = base64.b64encode(
        hmac.new(auth_token.encode("utf-8"), data.encode("utf-8"), hashlib.sha1).digest()
    ).decode("utf-8")
    # Constant-time compare -- a plain == leaks timing information about how
    # many leading characters matched, which is exactly the kind of thing
    # that turns "probably fine" into an actual exploitable side channel for
    # an attacker with enough attempts.
    return hmac.compare_digest(expected, signature)


def send_whatsapp_message(account_sid: str, auth_token: str, from_number: str, to_number: str, body: str) -> bool:
    """Sends a WhatsApp message Jarvis initiated himself -- a proactive alert,
    not a reply to something you sent. Everything up to here (webhook
    verification, the phone allowlist) only guards INBOUND messages; this is
    the other direction, so misuse here would mean texting someone who isn't
    you, not someone impersonating you. That's why the caller is responsible
    for only ever passing an allowlisted number, not this function.

    Returns False (and logs) on any failure rather than raising -- an alert
    that fails to send should never crash whatever background check
    triggered it."""
    if not (account_sid and auth_token and from_number and to_number):
        log.warning("Jarvis proactive alert skipped: Twilio isn't fully configured.")
        return False
    try:
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
            auth=(account_sid, auth_token),
            data={"From": from_number, "To": to_number, "Body": body[:1500]},
            timeout=15,
        )
        if resp.status_code >= 300:
            log.error("Jarvis proactive alert failed (%s): %s", resp.status_code, resp.text[:500])
            return False
        return True
    except requests.RequestException as e:
        log.error("Jarvis proactive alert failed: %s", e)
        return False
