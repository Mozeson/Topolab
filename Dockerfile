# Railway builds this (instead of its auto-detected setup, whose tool download from GitHub
# kept failing). Stage 1 builds the site; stage 2 runs server/server.js, which serves dist/
# and the team-navigation rooms (WebSocket /ws) on $PORT.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY src/team.js ./src/team.js
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/server.js"]
