FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install \
    @opentelemetry/api \
    @opentelemetry/sdk-node \
    @opentelemetry/sdk-trace-base \
    @opentelemetry/resources \
    @opentelemetry/exporter-trace-otlp-grpc \
    @opentelemetry/instrumentation-http \
    @opentelemetry/instrumentation-express \
    @opentelemetry/instrumentation-undici \
    @opentelemetry/sdk-metrics \
    @opentelemetry/exporter-prometheus

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

#potential trap: installing OpenTelemetry only in the builder would leave its runtime dependencies missing from the final image, insted we copy the updated dependency manifest and lockfile into the runtime image
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8081

CMD ["node", "dist/server.js"]
