import subprocess
import time
import urllib.request
import os

TUNNEL_ID = "5c8d4af2-ebb7-46d7-a6bf-42d07eec17ec"
PUBLIC_URL = "https://backend.ingeniumstem.org"
TUNNEL_TOKEN = os.getenv("CLOUDFLARE_TUNNEL_TOKEN", "").strip()

# Named tunnel with token: `cloudflared tunnel run --token <TOKEN>`
# The URL mapping (http://127.0.0.1:8000) is configured in the Cloudflare
# Zero-Trust dashboard, not on the CLI — passing --url to a named tunnel
# causes cloudflared to fail silently or start a quick tunnel instead.
if TUNNEL_TOKEN:
    cmd = ["cloudflared", "tunnel", "run", "--token", TUNNEL_TOKEN]
else:
    # Fallback: run the named tunnel by ID (requires local config/cert)
    cmd = ["cloudflared", "tunnel", "run", TUNNEL_ID]

print(f"[tunnel] Starting: {' '.join(cmd)}")

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding="utf-8",
    bufsize=1,
)

start_time = time.time()
ready = False

while time.time() - start_time < 40:
    line = proc.stdout.readline()
    if line:
        print(line, end="")
    else:
        time.sleep(0.1)

    if line and ("Registered tunnel connection" in line
                 or ("Connection" in line and "registered" in line.lower())):
        ready = True
        break

if not ready:
    print("\nFAILED_TO_START_NAMED_TUNNEL")
    proc.terminate()
else:
    print(f"\nTUNNEL_STARTED: {TUNNEL_ID}")
    print(f"EXPECTED_PUBLIC_URL: {PUBLIC_URL}")

    try:
        # Verify the domain resolves to an active service.
        with urllib.request.urlopen(f"{PUBLIC_URL}/api/health", timeout=10) as response:
            print(f"HEALTHCHECK_STATUS: {response.status}")
    except Exception as exc:
        print(f"HEALTHCHECK_FAILED: {exc}")
