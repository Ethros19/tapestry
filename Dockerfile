# syntax=docker/dockerfile:1
FROM python:3.13-slim

# git is needed to clone the repo
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone source directly — no local files needed
RUN git clone --depth=1 https://github.com/Ethros19/tapestry.git . \
    && pip install --no-cache-dir -r requirements.txt

# Data volume mount point (drawer.json, settings.json, mix-covers)
ENV TAPESTRY_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8085

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
