# 国内网络构建时可用镜像源加速（不传参数则走官方源，行为不变）：
#   NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine \
#   NPM_REGISTRY=https://registry.npmmirror.com \
#   docker compose up -d --build
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS webbuild
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /build
COPY web/package*.json ./
RUN npm ci --no-fund --no-audit --registry=${NPM_REGISTRY}
COPY web/ ./
RUN npm run build

FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG ALPINE_MIRROR=
ENV TZ=Asia/Shanghai NODE_ENV=production
RUN if [ -n "$ALPINE_MIRROR" ]; then sed -i "s#https://dl-cdn.alpinelinux.org#${ALPINE_MIRROR}#g" /etc/apk/repositories; fi \
  && apk add --no-cache tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit --registry=${NPM_REGISTRY}
COPY server/ ./server/
COPY --from=webbuild /build/dist ./web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server/index.js"]
