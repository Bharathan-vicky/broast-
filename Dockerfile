# ---- Delta Paper Trader backend ----
# Multi-stage not needed: keep image small for Fly free tier (256MB).
FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

# Copy the backend application
COPY backend /app

EXPOSE 8000

# The uvicorn app object is named `app` in server.py -> module is "server:app"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
