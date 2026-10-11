FROM node:24.21.0-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --prod --frozen-lockfile --ignore-workspace
COPY --chown=node:node src ./src
USER node
ENV CHATGPT_AUTH_DIR=/data
EXPOSE 3210 1455
CMD ["node", "src/main.mjs"]
