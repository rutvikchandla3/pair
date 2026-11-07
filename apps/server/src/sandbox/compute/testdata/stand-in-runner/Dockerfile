# The compute driver contract image: tini runs the stand-in runner; iptables serves the egress helper.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables tini \
  && rm -rf /var/lib/apt/lists/*
COPY stand-in-runner.mjs /stand-in-runner.mjs
ENTRYPOINT ["tini", "--", "node", "/stand-in-runner.mjs"]
