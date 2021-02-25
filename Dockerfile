FROM node:lts-slim
LABEL maintainer Carlos Lapao <mail@carloslapao.com>

ENV NODE_ENV=production

WORKDIR /opt/k8s-mongo-sidecar

COPY package.json package-lock.json /opt/k8s-mongo-sidecar/

RUN npm install

COPY ./build /opt/k8s-mongo-sidecar/

CMD ["node", "index.js"]
