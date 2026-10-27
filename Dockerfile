FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer python3-uno fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production HOST=0.0.0.0 LIBREOFFICE_PATH=/usr/bin/soffice
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.js"]
