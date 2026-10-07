# Both bun stages run on the builder's own platform, so no image is built under
# emulation. Production dependencies are still resolved for the target.
FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS deps
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN cpu="$TARGETARCH"; [ "$cpu" != "amd64" ] || cpu="x64"; \
    bun install --frozen-lockfile --production ${cpu:+--os=linux --cpu=$cpu}

FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:ui

FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
