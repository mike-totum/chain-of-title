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
# Three services, one image.
#
# The chainmints service runs TWO processes against one file: the scanner writing rows and the metadata resolver
# updating them. Two writers on one SQLite database is the arrangement that has kept `npm run clusters` off the
# collector for days - but the reason there is that a blocked write drops a launch permanently. Here both hold
# short BEGIN IMMEDIATE transactions under the 10s busy_timeout, and the worst case is a retry: the scanner
# re-reads overlapping ranges every pass anyway, and the resolver's work is idempotent. SERVICE=chainmints reads every block and records every token creation on the chain,
# whatever launchpad made it; it writes its own database file so it never competes for the collector's write lock,
# which is why it can be deployed and restarted without costing the collector a single launch.
CMD ["sh", "-c", "if [ \"$SERVICE\" = web ]; then exec tsx --no-warnings=ExperimentalWarning src/serve.ts --db ${DB_PATH:-/data/record.db} --dir site; elif [ \"$SERVICE\" = chainmints ]; then tsx --no-warnings=ExperimentalWarning src/chainmeta.ts --daemon & exec tsx --no-warnings=ExperimentalWarning src/chainmints.ts --daemon; else exec tsx --no-warnings=ExperimentalWarning src/index.ts; fi"]
