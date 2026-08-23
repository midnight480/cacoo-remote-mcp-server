# Cloud Run 向けイメージ。
# ビルドと実行を分け、実行段には本番依存だけを入れる。

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
# tsx で TypeScript のまま動かすため、ここでは型チェックだけ行う
RUN npx tsc -p tsconfig.gcp.json

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/src ./src
COPY tsconfig*.json ./
# Cloud Run は PORT を渡してくる。serve.ts が読む。
EXPOSE 8080
CMD ["npx", "tsx", "src/platforms/gcp/server.ts"]
