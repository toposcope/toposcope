# syntax=docker/dockerfile:1
# The dqlite C library is built from source here, so nothing is installed on
# the host. Builds for linux/amd64 and linux/arm64.
FROM golang:1.26-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      autoconf automake libtool make pkg-config git ca-certificates \
      libuv1-dev libsqlite3-dev liblz4-dev \
    && rm -rf /var/lib/apt/lists/*
ARG DQLITE_VERSION=v1.18.7
RUN git clone --depth 1 --branch ${DQLITE_VERSION} https://github.com/canonical/dqlite /src/dqlite \
    && cd /src/dqlite && autoreconf -i \
    && ./configure --enable-build-raft --disable-backtrace --prefix=/usr/local \
    && make -j"$(nproc)" && make install && ldconfig
WORKDIR /src/proof
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=1 go build -tags libsqlite3 -o /bin/ctl ./cmd/ctl \
    && CGO_ENABLED=0 go build -o /bin/runner ./cmd/runner

# One self-signed certificate shared by every member, for peer TLS.
RUN mkdir -p /etc/dqproof && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=dqproof -addext subjectAltName=DNS:dqproof \
      -keyout /etc/dqproof/key.pem -out /etc/dqproof/cert.pem 2>/dev/null

# Bun is here only for the auth benchmark, as the real caller of the socket.
FROM oven/bun:1.3
RUN apt-get update && apt-get install -y --no-install-recommends \
      libuv1t64 libsqlite3-0 liblz4-1 iptables procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/libdqlite.so* /usr/local/lib/
RUN ldconfig
COPY --from=build /etc/dqproof /etc/dqproof
COPY --from=build /bin/ctl /bin/runner /usr/local/bin/
COPY bench /bench
ENTRYPOINT ["/usr/local/bin/ctl"]
