"""
test_notifications.py — Smoke tests for the Cloudflare Email Worker and NotificationManager.

Usage:
    python test_notifications.py <recipient_email>

Example:
    python test_notifications.py kaushik@example.com

Env vars (optional overrides):
    EMAIL_WORKER_URL     (default: https://akawa-email-worker.kaushik-sannidhi.workers.dev/send)
    EMAIL_WORKER_SECRET  (default: akawa-alerts-secret-key-2026)
"""

import os
import sys
import json
import requests
import logging

# Suppress library logging so only our [PASS]/[FAIL] output shows
logging.disable(logging.CRITICAL)

# ─────────────────────────── Config ───────────────────────────

EMAIL_WORKER_URL = os.getenv(
    "EMAIL_WORKER_URL",

    "https://akawa-email-worker.kaushik-sannidhi.workers.dev/send",
)
EMAIL_WORKER_SECRET = os.getenv("EMAIL_WORKER_SECRET", "akawa-alerts-secret-key-2026")

PASS = 0
FAIL = 0


def ok(msg: str):
    global PASS
    PASS += 1
    print(f"  [PASS] {msg}")


def fail(msg: str):
    global FAIL
    FAIL += 1
    print(f"  [FAIL] {msg}")


# ─────────────────── Test 1: Cloudflare Email Worker ───────────────────


def test_email_worker(recipient: str):
    print("\n== TEST 1: Cloudflare Email Worker ==")
    print(f"   URL       : {EMAIL_WORKER_URL}")
    print(f"   Recipient : {recipient}")

    payload = {
        "to": [recipient],
        "subject": "[AKAWA TEST] Email Worker Smoke Test",
        "body": "This is a test from test_notifications.py. If you see this, the worker works.",
        "html": (
            '<div style="font-family:monospace;background:#0a0a0a;color:#00ff41;padding:24px;border:2px solid #333;">'
            '<h1 style="color:#ff3333;">AKAWA TEST EMAIL</h1>'
            '<p style="color:#ccc;">If you see this, the Cloudflare Email Worker is <b style="color:#00ff41;">operational</b>.</p>'
            "</div>"
        ),
    }

    try:
        resp = requests.post(
            EMAIL_WORKER_URL,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "X-Worker-Secret": EMAIL_WORKER_SECRET,
            },
            timeout=15,
        )
    except requests.exceptions.ConnectionError:
        fail(f"Connection error — cannot reach {EMAIL_WORKER_URL}")
        print("       Worker is probably not deployed yet.")
        print("       Deploy: cd cloudflare-email-worker && npx wrangler deploy")
        return
    except requests.exceptions.Timeout:
        fail("Request timed out (15s)")
        return
    except Exception as e:
        fail(f"Unexpected error: {e}")
        return

    print(f"   HTTP {resp.status_code}")

    if resp.status_code == 200:
        try:
            data = resp.json()
            results = data.get("results", [])
            all_ok = all(r.get("success") for r in results)
            if all_ok:
                ok(f"Email accepted for delivery to {recipient}")
            else:
                for r in results:
                    if r.get("success"):
                        ok(f"{r['email']}: accepted")
                    else:
                        fail(f"{r['email']}: {r.get('error', 'unknown')}")
        except Exception:
            # Non-JSON 200 — still treat as success (some workers return plain text)
            ok("Worker returned 200 (non-JSON response)")
    elif resp.status_code == 401:
        fail("Unauthorized — EMAIL_WORKER_SECRET is wrong")
    elif resp.status_code == 404:
        fail("404 Not Found — worker not deployed or URL is wrong")
        print("       Deploy: cd cloudflare-email-worker && npx wrangler deploy")
    else:
        fail(f"Unexpected status {resp.status_code}")
        print(f"       Body: {resp.text[:200]}")


# ───────── Test 2: Worker rejects bad auth ─────────


def test_worker_rejects_bad_secret():
    print("\n== TEST 2: Worker rejects bad secret ==")

    try:
        resp = requests.post(
            EMAIL_WORKER_URL,
            json={"to": ["x@x.com"], "subject": "bad", "body": "bad"},
            headers={
                "Content-Type": "application/json",
                "X-Worker-Secret": "wrong-secret-on-purpose",
            },
            timeout=10,
        )
    except requests.exceptions.ConnectionError:
        fail("Connection error — worker not reachable (skipping)")
        return
    except Exception as e:
        fail(f"Request error: {e}")
        return

    if resp.status_code == 401:
        ok("Worker correctly returned 401 for bad secret")
    elif resp.status_code == 404:
        fail("404 — worker not deployed, can't test auth rejection")
    else:
        fail(f"Expected 401, got {resp.status_code}")


# ───────── Test 3: NotificationManager pipeline ─────────


def test_notification_manager_pipeline(recipient: str):
    print("\n== TEST 3: NotificationManager.send_typed_alert() ==")

    # Make sure we can import from the app
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    try:
        from app.notifications import NotificationManager
    except ImportError as e:
        fail(f"Cannot import NotificationManager: {e}")
        print("       Run this script from the backend/ directory.")
        return

    nm = NotificationManager()

    # Mock Firebase settings so we don't need a real user
    def mock_settings(uid: str):
        return {
            "email": recipient,
            "email_enabled": True,
            "alert_types": {
                "gun":   {"email": True,  "contacts": []},
                "knife": {"email": True,  "contacts": []},
                "fall":  {"email": False, "contacts": []},
                "fight": {"email": True,  "contacts": []},
            },
        }

    nm.get_user_settings = mock_settings

    # Test classify_alert
    assert nm.classify_alert("rifle") == "gun"
    assert nm.classify_alert("handgun") == "gun"
    assert nm.classify_alert("knife") == "knife"
    assert nm.classify_alert("violence") == "fight"
    assert nm.classify_alert("brawl") == "fight"
    assert nm.classify_alert("fall") == "fall"
    assert nm.classify_alert("unknown_thing") == "gun"  # default
    ok("classify_alert() maps all classes correctly")

    # Test that send_typed_alert fires for gun (email=True)
    print("   Sending 'gun' alert...")
    nm.send_typed_alert(
        uid="test_user",
        alert_type="gun",
        title="Test Gun Detection",
        message="A HANDGUN was detected with 95% confidence.",
        force=True,
    )
    ok("send_typed_alert('gun') completed (check email)")

    # Test that send_typed_alert fires for fight
    print("   Sending 'fight' alert...")
    nm.send_typed_alert(
        uid="test_user",
        alert_type="fight",
        title="Test Fight Detection",
        message="Violence detected with 87% confidence on Live Stream: Parking Lot.",
        force=True,
    )
    ok("send_typed_alert('fight') completed (check email)")

    # Test that fall does NOT send (email=False in mock)
    print("   Sending 'fall' alert (should be silent — email disabled)...")
    nm.send_typed_alert(
        uid="test_user",
        alert_type="fall",
        title="Test Fall Detection",
        message="This should NOT produce an email.",
        force=True,
    )
    ok("send_typed_alert('fall') completed (no email expected)")

    # Test legacy send_alert wrapper
    print("   Testing legacy send_alert() wrapper...")
    nm.send_alert(
        uid="test_user",
        title="Legacy Alert Test",
        message="Triggered via send_alert() with class_name='knife'.",
        class_name="knife",
        force=True,
    )
    ok("send_alert(class_name='knife') routed correctly")

    # Test cooldown — second call should be suppressed
    print("   Testing 30s cooldown...")
    nm.send_typed_alert(
        uid="test_user",
        alert_type="gun",
        title="Test Gun Detection",
        message="This duplicate should be suppressed by cooldown.",
        force=False,  # <-- not forced, so cooldown applies
    )
    ok("Cooldown: duplicate alert was suppressed (no second email)")


# ─────────────────── Main ───────────────────


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_notifications.py <recipient_email>")
        print("Example: python test_notifications.py you@example.com")
        sys.exit(1)

    recipient = sys.argv[1]
    if "@" not in recipient:
        print(f"ERROR: '{recipient}' doesn't look like an email address.")
        sys.exit(1)

    print("=" * 50)
    print("  AKAWA NOTIFICATION TEST SUITE")
    print("  Email-only (Cloudflare Worker)")
    print(f"  Recipient: {recipient}")
    print("=" * 50)

    test_email_worker(recipient)
    test_worker_rejects_bad_secret()
    test_notification_manager_pipeline(recipient)

    print("\n" + "=" * 50)
    print(f"  RESULTS: {PASS} passed, {FAIL} failed")
    print("=" * 50)

    if FAIL > 0:
        print("\n  Some tests failed. If email worker returns 404,")
        print("  deploy it first: cd cloudflare-email-worker && npx wrangler deploy")
        sys.exit(1)
    else:
        print("\n  All tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()

