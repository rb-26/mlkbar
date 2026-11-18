FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY public/ /app/public/
COPY server.py /app/server.py

RUN mkdir -p /app/data

# Single worker: SQLite + in-memory login throttle assume one process.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:80", "--access-logfile", "-", "server:app"]
