FROM node:20-alpine

RUN apk add --no-cache ffmpeg curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
