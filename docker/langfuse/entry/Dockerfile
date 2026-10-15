FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY main.mjs ./
USER node
EXPOSE 3000
CMD ["node", "main.mjs"]
