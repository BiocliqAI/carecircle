# Plain build for Railway (railway.json selects it). No BuildKit cache mounts, which Railway's builder has failed to
# mount ("failed to solve: mount source: overlay ... cachemounts ... invalid argument").
FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run clinic:build
ENV NODE_ENV=production
EXPOSE 3100
# clinic:start listens on $PORT (Railway sets it), else 3100. The database lives at $CARECIRCLE_DB (the /data volume).
CMD ["npm", "run", "clinic:start"]
