FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
