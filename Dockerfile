FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production \
    INTEGRATION_PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
