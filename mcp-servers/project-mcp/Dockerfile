FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY index.js .

ENV PORT=3333
ENV PROJECT_ROOT=/project
ENV LM_STUDIO_URL=http://host.docker.internal:1234
ENV LM_STUDIO_MODEL=mistralai/ministral-3-3b

EXPOSE 3333

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3333/health || exit 1

CMD ["node", "index.js"]
