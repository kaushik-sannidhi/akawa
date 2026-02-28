@echo off
cd backend
call ..\.venv\Scripts\activate.bat

set TUNNEL_ID=5c8d4af2-ebb7-46d7-a6bf-42d07eec17ec

echo Starting Cloudflare Tunnel...
if defined CLOUDFLARE_TUNNEL_TOKEN (
  start /b cloudflared tunnel run --token %CLOUDFLARE_TUNNEL_TOKEN%
) else (
  start /b cloudflared tunnel run %TUNNEL_ID%
)

echo Starting FastAPI Backend...
uvicorn main:app --reload --host 0.0.0.0 --port 8000
