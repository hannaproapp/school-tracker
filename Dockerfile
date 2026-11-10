FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY kids.json ./
ENV NODE_ENV=production TZ=America/New_York
CMD ["node", "src/server.js"]
