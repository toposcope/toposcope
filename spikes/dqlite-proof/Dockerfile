# syntax=docker/dockerfile:1
# The dqlite C library is built from source here, so nothing is installed on
# the host. Builds for linux/amd64 and linux/arm64. The same image carries
# both members: ctl (dqlite) and ctlr (which supervises rqlited).
FROM golang:1.26-trixie AS rqlite
ARG RQLITE_VERSION=v10.6.6
ARG TARGETARCH
RUN curl -fsSL -o /tmp/rq.tgz https://github.com/rqlite/rqlite/releases/download/${RQLITE_VERSION}/rqlite-${RQLITE_VERSION}-linux-${TARGETARCH}.tar.gz \
    && tar xzf /tmp/rq.tgz -C /tmp && cp /tmp/rqlite-${RQLITE_VERSION}-linux-${TARGETARCH}/rqlited /bin/rqlited \
    && /bin/rqlited -version

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
    && CGO_ENABLED=1 go build -tags libsqlite3 -o /bin/ctlr ./cmd/ctlr \
    && CGO_ENABLED=0 go build -o /bin/runner ./cmd/runner

# One self-signed certificate shared by every member, for peer TLS; and
# three more, one per installation (a: the original; b, c: two restores),
# for rqlite's installation-identity test (MTLS=1).
RUN mkdir -p /etc/dqproof && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=dqproof -addext subjectAltName=DNS:dqproof \
      -keyout /etc/dqproof/key.pem -out /etc/dqproof/cert.pem 2>/dev/null \
    && for s in a b c; do mkdir -p /etc/dqproof/$s && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=dqproof -addext subjectAltName=DNS:dqproof \
      -keyout /etc/dqproof/$s/key.pem -out /etc/dqproof/$s/cert.pem 2>/dev/null; done

# Bun is here only for the auth benchmark, as the real caller of the socket.
FROM oven/bun:1.3
RUN apt-get update && apt-get install -y --no-install-recommends \
      libuv1t64 libsqlite3-0 liblz4-1 iptables procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/libdqlite.so* /usr/local/lib/
RUN ldconfig
COPY --from=build /etc/dqproof /etc/dqproof
COPY --from=build /bin/ctl /bin/ctlr /bin/runner /usr/local/bin/
COPY --from=rqlite /bin/rqlited /usr/local/bin/
COPY bench /bench
ENTRYPOINT ["/usr/local/bin/ctl"]
