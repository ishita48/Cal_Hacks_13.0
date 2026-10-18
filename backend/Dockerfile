# HAVEN world-state service — Railway / any container host.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY haven ./haven
COPY tools ./tools
RUN uv sync --frozen --no-dev

# The event log lives here; mount a volume at /app/data to keep runs across deploys.
ENV HAVEN_DB=/app/data/haven.db
VOLUME ["/app/data"]

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "haven.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
