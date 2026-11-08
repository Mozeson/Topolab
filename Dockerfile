# Railway builds this instead of its auto-detected setup, which downloads its tool installer
# (mise) from GitHub on every build and failed there with 504s. Two stages: build the static
# site with Node, then serve dist/ with Caddy on the port Railway gives ($PORT).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
