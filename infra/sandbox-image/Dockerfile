# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS base
ARG PAIR_VERSION=dev
COPY . /tmp/pair-image/
RUN PAIR_VERSION="$PAIR_VERSION" /tmp/pair-image/provision.sh && rm -rf /tmp/pair-image
COPY pair-bootstrap.sh /usr/local/bin/pair-bootstrap
LABEL org.opencontainers.image.version="$PAIR_VERSION"
# -g: signal the whole group, since pair-bootstrap runs the runner as a child (exit 75 retry)
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/pair-bootstrap"]

FROM base AS with-runner
COPY --from=runner . /opt/pair-runner/
