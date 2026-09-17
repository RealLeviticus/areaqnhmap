# The image carries its own Chromium because the app renders its own chart
# images. Debian's chromium package is used rather than letting Puppeteer
# download one, so the browser is patched by apt along with everything else.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      ca-certificates \
      curl \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a change to application code doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Rendered images and the render bookkeeping file live on a volume.
RUN mkdir -p /data/images && chown -R node:node /data
ENV DATA_DIR=/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# dumb-init reaps the zombie processes Chromium leaves behind when a render is
# interrupted; without it they accumulate as defunct children of PID 1.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
