FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app
ENV UV_HTTP_TIMEOUT=300 UV_HTTP_RETRIES=5
COPY services/agentscope/pyproject.toml services/agentscope/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/agentscope/src ./src
RUN uv sync --frozen --no-dev

ENV AGENTSCOPE_STATE_DIR=/data/agentscope-state
EXPOSE 8090
CMD ["uv", "run", "uvicorn", "workpal_agentscope.app:app", "--host", "0.0.0.0", "--port", "8090"]
