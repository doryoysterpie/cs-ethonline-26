# Builds and runs @cas/dashboard from the pnpm/Turborepo monorepo.
#
# The base is pinned by its manifest-list digest, the tag kept for the reader: a tag
# rebuilt under the same name cannot change the deployed image without a pull request.
#
# node:24.22.2-bookworm-slim (glibc, not musl/alpine): argon2 ships prebuilt
# binaries for darwin-arm64 and linux-x64 only (pnpm-workspace.yaml refuses
# its install script), and those prebuilds are glibc, not musl.

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
COPY data ./data
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm exec turbo run build --filter=@cas/dashboard...

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
# npm is never run here (the dashboard starts through corepack's pnpm), and the copy the base
# image carries, with its own bundled packages, is what the image scan flags; it is removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@cas/dashboard", "start"]
