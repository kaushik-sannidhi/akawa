import subprocess
import re
import time
import sys

proc = subprocess.Popen(
    ['npx.cmd', 'cloudflared', 'tunnel', '--url', 'http://127.0.0.1:8000'],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding='utf-8',
    bufsize=1
)

start_time = time.time()
url = None

while time.time() - start_time < 30:
    line = proc.stdout.readline()
    if not line:
        time.sleep(0.1)
        continue
    print(line, end='')
    
    match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
    if match:
        url = match.group(0)
        break

if url:
    with open('cloudflare_url.txt', 'w') as f:
        f.write(url)
    print("\nSUCCESS_URL:", url)
else:
    print("\nFAILED TO FIND URL")
    proc.terminate()
