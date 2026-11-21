FROM node:22-alpine

WORKDIR /webmixer

# Run as non-root, but still allow binding the default web port 80 (ports below 1024 are
# privileged). The node user can't use `sysctl net.ipv4.ip_unprivileged_port_start` with
# network_mode: host (it isn't namespaced), so grant the node binary the
# cap_net_bind_service file capability instead. Docker's default capability set includes
# NET_BIND_SERVICE, so this works without any extra compose options.
RUN apk add --no-cache libcap \
    && setcap cap_net_bind_service=+ep "$(readlink -f "$(which node)")" \
    && apk del libcap

# Install dependencies first so this layer is cached until package files change
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Then copy the rest of the source
COPY . .

# Make sure the app (and the ./config volume mount point) is writable by the node user
RUN chown -R node:node /webmixer
USER node

# Healthy when the web server answers /healthz (port read from the saved config, default 80)
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "const fs=require('fs');let p=80;try{p=JSON.parse(fs.readFileSync('/webmixer/config/global.json','utf8')).server.port||80}catch(e){}require('http').get({host:'127.0.0.1',port:process.env.PORT||p,path:'/healthz',timeout:4000},r=>process.exit(r.statusCode==200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT [ "node", "." ]
