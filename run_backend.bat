@echo off
setlocal

cd backend
call ..\.venv\Scripts\activate.bat

echo Cleaning up port 9001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9001') do taskkill /f /pid %%a 2>nul

echo Starting FastAPI Backend...
uvicorn main:app --reload --host 0.0.0.0 --port 8000
