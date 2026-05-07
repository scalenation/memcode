FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --frozen-lockfile
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --production --frozen-lockfile
COPY --from=builder /app/dist ./dist
# Copy landing page static files if present
COPY --from=builder /app/../landing ./landing 2>/dev/null || true
EXPOSE 3000
CMD ["node", "dist/index.js"]
