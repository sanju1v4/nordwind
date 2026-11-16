# syntax=docker/dockerfile:1
# The React app as static files, served by nginx as a non-root user on port 8080.
# API calls (/trpc, /auth, /api) are routed to the API by the Kubernetes Ingress, not by nginx.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
# The web app imports the API's TYPES for end-to-end type safety, so the API source is needed to type-check.
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
