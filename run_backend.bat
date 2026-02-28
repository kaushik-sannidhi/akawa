@echo off
cd backend
call ..\.venv\Scripts\activate.bat

echo Starting Cloudflare Tunnel...
start /b cloudflared tunnel run f9fe7361-fa3b-425b-acab-35209afc2aeb

echo Starting FastAPI Backend...
uvicorn main:app --reload --host 0.0.0.0 --port 8000
