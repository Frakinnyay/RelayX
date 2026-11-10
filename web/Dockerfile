# Build context is the repository root (see docker-compose.yml)
FROM node:22-alpine AS build
WORKDIR /web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
# These URLs are used by the BROWSER, so they must be reachable from your machine, not from inside Docker.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_RECEIVER_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL VITE_RECEIVER_URL=$VITE_RECEIVER_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
