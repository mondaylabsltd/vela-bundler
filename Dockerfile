# syntax=docker/dockerfile:1

FROM rust:1.97-bookworm AS builder

WORKDIR /build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        cmake \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release --locked


FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
    && groupadd --gid 10001 vela \
    && useradd --uid 10001 --gid vela --create-home --shell /usr/sbin/nologin vela \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/vela-relay /usr/local/bin/vela-relay

USER vela

ENV VELA_RELAY_LISTEN_ADDR=0.0.0.0:4567

EXPOSE 4567

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:4567/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/vela-relay"]
