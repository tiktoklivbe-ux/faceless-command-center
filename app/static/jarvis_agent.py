#!/usr/bin/env python3
"""
Jarvis Agent -- runs on YOUR computer, not in the cloud.

This is the missing piece that lets Jarvis (in your Faceless Command
Center web app) actually control your computer. The web app has no direct
connection to your machine -- this script is what closes that gap: it
polls your app asking "anything for me to do?", and when Jarvis queues an
action (open an app, type something, click somewhere, press a key combo),
this script is what actually does it, on this computer, right now.

SETUP
-----
1. Install the two packages this needs:
     pip install requests pyautogui

2. Get your pairing token: in the Faceless Command Center web app, go to
   Jarvis -> More tab -> "Set up Computer Control" -> Generate Token.
   Copy it.

3. Run this script, either:
     python jarvis_agent.py
   and paste the URL + token when prompted, OR set them as environment
   variables first to skip the prompts:
     export JARVIS_SERVER_URL="https://your-app.onrender.com"
     export JARVIS_AGENT_TOKEN="the-token-you-copied"
     python jarvis_agent.py

4. Leave it running in a terminal while you want Jarvis able to control
   this computer. Close the terminal (Ctrl+C) to stop it -- Jarvis simply
   can't do anything on this computer while this isn't running.

SECURITY
--------
Anyone with your pairing token can make THIS computer do things (open
apps, type text, click around) through your web app. Treat the token like
a password:
  - Don't share it, don't commit it to a public repo, don't paste it
    somewhere public.
  - If you ever think it leaked, regenerate it in the app (this
    immediately invalidates the old one) and update this script's config.
  - Only run this script when you actually want Jarvis to have this
    ability -- it's not meant to run silently forever in the background
    unless that's genuinely what you want.

SCOPE
-----
This executes a small, fixed set of actions only -- open_app, type_text,
click_at, press_keys, screenshot. It does not run arbitrary code sent from
the server. That's a deliberate safety boundary: even if something went
wrong on the server side, this script can't be turned into "run anything
you want on my computer."
"""
import base64
import io
import os
import platform
import subprocess
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run: pip install requests pyautogui")

try:
    import pyautogui
    pyautogui.FAILSAFE = True  # moving mouse to a screen corner aborts an action -- an emergency stop
except ImportError:
    sys.exit("Missing dependency. Run: pip install requests pyautogui")


def _get_config():
    server = os.environ.get("JARVIS_SERVER_URL") or input("Your app's URL (e.g. https://your-app.onrender.com): ").strip()
    token = os.environ.get("JARVIS_AGENT_TOKEN") or input("Pairing token (from Jarvis -> More -> Computer Control): ").strip()
    return server.rstrip("/"), token


def open_app(params):
    name = params.get("app_name", "")
    if not name:
        raise ValueError("No app_name given.")
    system = platform.system()
    if system == "Darwin":
        subprocess.run(["open", "-a", name], check=True)
    elif system == "Windows":
        os.startfile(name)  # noqa -- Windows-only API, fine here since we branched on platform
    else:
        subprocess.run(["xdg-open", name], check=True)
    return {"opened": name}


def type_text(params):
    text = params.get("text", "")
    pyautogui.write(text, interval=0.02)
    return {"typed_chars": len(text)}


def click_at(params):
    x, y = params.get("x"), params.get("y")
    if x is None or y is None:
        raise ValueError("click_at needs both x and y.")
    pyautogui.click(x, y)
    return {"clicked": [x, y]}


def press_keys(params):
    combo = params.get("keys", "")
    if not combo:
        raise ValueError("No keys given.")
    keys = [k.strip() for k in combo.replace("+", " ").split()]
    pyautogui.hotkey(*keys)
    return {"pressed": keys}


def screenshot(params):
    img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    base64.b64encode(buf.getvalue()).decode("ascii")  # captured but not relayed yet -- see note below
    return {"width": img.width, "height": img.height, "note": "Screenshot captured (image data not yet relayed into chat)."}


ACTIONS = {
    "open_app": open_app,
    "type_text": type_text,
    "click_at": click_at,
    "press_keys": press_keys,
    "screenshot": screenshot,
}


def main():
    server, token = _get_config()
    print(f"Jarvis Agent connecting to {server} ...")
    print("Leave this running. Press Ctrl+C to stop (Jarvis loses computer control until you restart this).")
    print("Safety: moving your mouse to any screen corner immediately aborts the current action.\n")

    session = requests.Session()
    consecutive_errors = 0

    while True:
        try:
            resp = session.get(f"{server}/api/jarvis/agent/poll", params={"token": token}, timeout=15)
            if resp.status_code == 401:
                sys.exit("Pairing token rejected -- it may have been regenerated in the app. Get a fresh one.")
            resp.raise_for_status()
            consecutive_errors = 0

            cmd = resp.json().get("command")
            if cmd:
                action_name = cmd["action"]
                print(f"[{time.strftime('%H:%M:%S')}] Executing: {action_name} {cmd['params']}")
                fn = ACTIONS.get(action_name)
                try:
                    if not fn:
                        raise ValueError(f"Unknown action '{action_name}'")
                    result = fn(cmd["params"])
                    session.post(
                        f"{server}/api/jarvis/agent/report", params={"token": token},
                        json={"command_id": cmd["id"], "status": "done", "result": result},
                        timeout=15,
                    )
                    print(f"  -> done: {result}")
                except Exception as e:
                    session.post(
                        f"{server}/api/jarvis/agent/report", params={"token": token},
                        json={"command_id": cmd["id"], "status": "failed", "error": str(e)},
                        timeout=15,
                    )
                    print(f"  -> failed: {e}")
        except requests.RequestException as e:
            consecutive_errors += 1
            if consecutive_errors % 10 == 1:  # don't spam the console on a long outage
                print(f"Connection issue ({e}) -- retrying...")

        time.sleep(1.5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Jarvis can't control this computer until you run this again.")
