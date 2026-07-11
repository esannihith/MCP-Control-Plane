# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# --- runtime stage ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    CP_HOST=0.0.0.0 \
    CP_DB_PATH=/data/control-plane.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Persistent data lives in /data — mount it (compose: ./data:/data; Railway:
# attach a Volume at /data). Railway forbids the VOLUME instruction itself.
EXPOSE 8720
# CLI inside the container: node dist/scripts/key.js list   (etc.)
CMD ["node", "dist/src/index.js"]
