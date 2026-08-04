# One image, three places: Cloud Run, a local container, and a local k8s cluster.
# Nothing here is environment-specific — the store adapter, the port and the token
# all arrive as configuration, so the artefact that ran locally is the artefact
# that ships. See `src/bin.ts` for the wiring it expects.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached against dependency changes rather
# than every source edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that ships. Done here rather than by
# copying node_modules selectively, so the runtime tree is exactly what npm
# considers production for this lockfile.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run overrides PORT; the default keeps `docker run` with no flags working.
ENV PORT=8080

# node:alpine ships an unprivileged `node` user. Running as root buys nothing
# here — the process only listens on a socket and writes to its store.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

# No shell form: exec form makes node PID 1, so it receives SIGTERM directly.
# Cloud Run and k8s both stop a container by sending it, and `bin.ts` closes the
# listener on it so in-flight requests finish instead of being cut off.
CMD ["node", "dist/bin.js"]
