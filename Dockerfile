# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM python:3.13-alpine AS black
ARG BLACK_VERSION=26.10.1
# Source install avoids ABI-specific wheels; the runtime uses Alpine's python3.
RUN python -m pip install --no-cache-dir --no-compile --no-binary=black --target /opt/black "black==${BLACK_VERSION}"

FROM node:24-alpine
ENV NODE_ENV=production \
    PRETTIER_PLUGIN_AUTO_INSTALL=true \
    PRETTIER_PLUGIN_CACHE=/var/cache/prettier-plugins \
    PRETTIER_PLUGIN_INSTALL_TIMEOUT=30000 \
    PYTHONPATH=/opt/black \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=black /opt/black /opt/black
COPY package.json ./

RUN apk add --no-cache python3 \
 && printf '%s\n' '#!/bin/sh' 'exec /usr/bin/python3 -m black "$@"' > /usr/local/bin/black \
 && chmod +x /usr/local/bin/black \
 && addgroup -S -g 10001 app \
 && adduser -S -u 10001 -G app app \
 && mkdir -p /var/cache/prettier-plugins \
 && chown -R app:app /var/cache/prettier-plugins

USER 10001:10001
VOLUME ["/var/cache/prettier-plugins"]
EXPOSE 3072

ENTRYPOINT ["node", "/app/dist/server.js"]
