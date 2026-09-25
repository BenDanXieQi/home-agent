# syntax=docker/dockerfile:1
FROM golang:1.25.1-alpine3.22@sha256:b6ed3fd0452c0e9bcdef5597f29cc1418f61672e9d3a2f55bf02e7222c014abd AS build

# go2rtc v1.9.14; every build checks the exact source revision before applying
# the committed patch and additional source files. Dependencies use go.sum.
WORKDIR /src
RUN apk add --no-cache git
RUN git init . \
 && git remote add origin https://github.com/AlexxIT/go2rtc.git \
 && git fetch --depth 1 origin b5948cfb25404cc5cb37b166ecaa2dca20b11d4b \
 && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = b5948cfb25404cc5cb37b166ecaa2dca20b11d4b
COPY runtime.patch /tmp/runtime.patch
RUN git apply --check /tmp/runtime.patch && git apply /tmp/runtime.patch
COPY overlay/ ./
RUN go mod download

FROM build AS native-build
ARG NATIVE_OS
ARG NATIVE_ARCH
RUN CGO_ENABLED=0 GOOS=$NATIVE_OS GOARCH=$NATIVE_ARCH go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/go2rtc .

FROM scratch AS native
COPY --from=native-build /out/go2rtc /go2rtc
COPY LICENSE /LICENSE

FROM build AS runtime-build
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/go2rtc .

# Keep the existing go2rtc runtime, tools, ports and startup behavior.
FROM alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae
COPY --from=runtime-build /out/go2rtc /usr/local/bin/go2rtc
COPY LICENSE /usr/share/licenses/go2rtc/LICENSE
LABEL org.opencontainers.image.source="https://github.com/AlexxIT/go2rtc" \
      org.opencontainers.image.revision="b5948cfb25404cc5cb37b166ecaa2dca20b11d4b" \
      org.opencontainers.image.version="1.9.14-home-agent" \
      org.opencontainers.image.licenses="MIT"
