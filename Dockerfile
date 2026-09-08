# syntax=docker/dockerfile:1
#
# Ledger — one image that serves the API and the built web app.
#
#   docker compose up -d
#
# The database lives in the /data volume, never inside the image, so
# rebuilding or upgrading the image cannot touch your records.

# ---------- stage 1: build the web bundle ----------
# The runtime image has no Node.js. Building here is what lets a restaurant
# owner run Ledger without installing a toolchain.
FROM node:22-slim AS web

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build


# ---------- stage 2: runtime ----------
FROM python:3.13-slim

# tesseract powers the optional "scan a bill" feature. Without it the app
# still runs and returns a clear message instead of failing.
RUN apt-get update \
 && apt-get install --no-install-recommends -y tesseract-ocr curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt \
 && pip install --no-cache-dir pytesseract==0.3.13 pillow==11.0.0

COPY server/ ./server/
COPY --from=web /web/dist ./web/dist

# Tests and caches are developer artefacts; shipping them would only add
# weight and widen the attack surface.
RUN rm -rf server/tests server/data && \
    find . -name __pycache__ -type d -prune -exec rm -rf {} + || true

ENV LEDGER_DATA_DIR=/data \
    LEDGER_WEB_DIST=/app/web/dist \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Running as root would make every file the container writes root-owned on the
# host bind mount, which the owner then cannot back up or delete.
RUN useradd --system --create-home --uid 10001 ledger \
 && mkdir -p /data && chown -R ledger:ledger /data /app
USER ledger

VOLUME ["/data"]
EXPOSE 8080

# Binding 0.0.0.0 is correct *inside* a container: the published port on the
# host is what actually decides who can reach Ledger.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

WORKDIR /app/server
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
