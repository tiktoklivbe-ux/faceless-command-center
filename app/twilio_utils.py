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

from .config import APP_BASE_URL


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
