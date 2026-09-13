# Builds and runs @cas/dashboard from the pnpm/Turborepo monorepo.
#
# node:24.21.0-bookworm-slim (glibc, not musl/alpine): argon2 ships prebuilt
# binaries for darwin-arm64 and linux-x64 only (pnpm-workspace.yaml refuses
# its install script), and those prebuilds are glibc, not musl.

FROM node:24.21.0-bookworm-slim AS base
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

FROM node:24.21.0-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@cas/dashboard", "start"]
