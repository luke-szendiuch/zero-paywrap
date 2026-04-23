export const dockerfileTemplate = (): string => `FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
# Typecheck as a pre-deploy gate.
RUN pnpm typecheck

# tsx lets the service run the TS directly; bundler module resolution doesn't
# emit \`.js\` extensions, so plain \`node dist/index.js\` rejects imports.
CMD ["node", "--import", "tsx", "src/index.ts"]
`;
