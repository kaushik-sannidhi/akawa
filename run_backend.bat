@echo off
cd backend
call ..\.venv\Scripts\activate.bat

echo Starting FastAPI Backend...
uvicorn main:app --reload --host 0.0.0.0 --port 8000
