# --- build stage ---
# NOTE: no `# syntax=` line → use the BuildKit frontend bundled with Docker Desktop,
# avoiding an extra pull of docker/dockerfile:1 from Docker Hub.
FROM rust:stable-slim AS build
WORKDIR /build
COPY . .
RUN cargo build --release --bin orig-daemon --bin orig-tg

# --- runtime stage ---
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/orig-daemon /usr/local/bin/orig-daemon
COPY --from=build /build/target/release/orig-tg /usr/local/bin/orig-tg

# Data directory (downloads + TG session/db). Mount a volume here.
ENV ORIG_TG_DATA=/data/tg \
    SURGE_DOWNLOAD_DIR=/data/downloads \
    ORIG_DAEMON_HOST=0.0.0.0
VOLUME ["/data"]
# CWD=/data 使挂载的 download-engine.toml 被自动读取（无需改路径）。
WORKDIR /data
EXPOSE 19786
ENTRYPOINT ["/usr/local/bin/orig-daemon"]
