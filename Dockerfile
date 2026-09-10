FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm i -g tsx@4
COPY . .
ENV NODE_ENV=production DB_PATH=/data/pump.db TELEGRAM_SESSION_FILE=/data/telegram.session
# Railway provides the persistent volume at /data and rejects a Dockerfile VOLUME directive.
# Keep DB_PATH pointing there; locally, mount or set DB_PATH yourself.
# Two services share this image, selected by SERVICE so neither needs its own build.
#   collector (default): writes /data/pump.db on a volume
#   web (SERVICE=web):   serves the ~40 MB record database baked into the image, read-mostly
# The record path is a variable, not a literal. It was `--db data/record.db`, and `--db` beats the DB_PATH
# environment variable, so pointing the service at its volume through DB_PATH changed nothing: the archive kept
# landing on the container filesystem and the volume sat empty while everything looked correct.
CMD ["sh", "-c", "if [ \"$SERVICE\" = web ]; then exec tsx --no-warnings=ExperimentalWarning src/serve.ts --db ${DB_PATH:-/data/record.db} --dir site; else exec tsx --no-warnings=ExperimentalWarning src/index.ts; fi"]
