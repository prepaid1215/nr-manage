FROM mcr.microsoft.com/playwright/python:v1.61.0-noble

WORKDIR /app
COPY v2/cloud-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY v2/cloud-worker/cloud_service.py ./cloud_service.py
COPY v2/sync-client/scraper.py ./scraper.py

ENV PYTHONUNBUFFERED=1
CMD ["gunicorn", "--bind", "0.0.0.0:10000", "--workers", "1", "--threads", "4", "--timeout", "900", "cloud_service:app"]
