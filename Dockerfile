# Builds and runs @cas/dashboard from the pnpm/Turborepo monorepo.
#
# The base is pinned by its manifest-list digest, the tag kept for the reader (D58): a tag
# rebuilt under the same name cannot change the deployed image without a pull request.
# Dependabot opens the bump weekly (.github/dependabot.yml); the bump is reviewed by two
# checks (docs/RUNBOOK-SECURITY.md, section 6): the new digest resolves from the tag on the
# registry, and the image scan (.github/workflows/image-scan.yml) is clean.
#
# node:24.22.2-bookworm-slim (glibc, not musl/alpine): argon2 ships prebuilt
# binaries for darwin-arm64 and linux-x64 only (pnpm-workspace.yaml refuses
# its install script), and those prebuilds are glibc, not musl.

FROM node:24.22.2-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base
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

FROM node:24.22.2-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@cas/dashboard", "start"]
