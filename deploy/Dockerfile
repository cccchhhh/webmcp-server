FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 38472
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "const r=require('http').get({host:'127.0.0.1',port:process.env.PORT||38472,path:'/health/ready',headers:{host:(process.env.ALLOWED_HOSTS||'localhost').split(',')[0]}},r=>{r.resume();process.exitCode=r.statusCode===200?0:1});r.on('error',()=>process.exitCode=1);r.setTimeout(4000,()=>r.destroy())"
CMD ["node", "dist/cli.js", "serve"]
