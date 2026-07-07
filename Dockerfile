FROM node:24-alpine AS webbuild
WORKDIR /build
COPY web/package*.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

FROM node:24-alpine
ENV TZ=Asia/Shanghai NODE_ENV=production
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server/ ./server/
COPY --from=webbuild /build/dist ./web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server/index.js"]
