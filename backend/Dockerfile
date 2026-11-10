# Build context is the repository root (see docker-compose.yml).
FROM node:22-alpine AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./
COPY database /app/database
ENV MIGRATIONS_DIR=/app/database/migrations
USER node
# One image, three roles. docker-compose.yml overrides CMD for the worker, receiver and migrate jobs.
CMD ["node", "dist/api/server.js"]
