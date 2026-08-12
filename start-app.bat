@echo off
cd /d "%USERPROFILE%\faceless-command-center"
call .venv\Scripts\activate
python run.py
pause
