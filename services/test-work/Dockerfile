FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY test.mjs ./
CMD ["node", "test.mjs"]
