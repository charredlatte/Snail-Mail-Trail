FROM node:22-alpine

WORKDIR /app

# Copy manifests first so this layer is cached until dependencies change.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# node:22-alpine ships an unprivileged `node` user. Use it.
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
