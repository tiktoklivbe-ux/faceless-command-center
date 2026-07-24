FROM python:3.11-slim

# ffmpeg is a hard requirement for the Assembly Agent (Ken Burns clips, concat, subtitle burn-in).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway/Render inject PORT at runtime; run.py already reads it.
CMD ["python", "run.py"]
