# FireFun web server (firefun.xyz) — the Trebuchet launcher in web mode.
#
#   flyctl launch --no-deploy   # once, to create the app (uses fly.toml)
#   flyctl volumes create firefun_data --size 1
#   flyctl deploy
#
# State (launch wallets, journals, RPC prefs) lives under /data, which
# fly.toml mounts as a persistent volume. Keep that volume backed up: it
# holds the secret keys of launch wallets that are mid-flight.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TREBUCHET_CONFIG_DIR=/data
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
