FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

WORKDIR /opt/uaw

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY bin/ ./bin/
COPY scripts/uwf-runner/ ./scripts/uwf-runner/
COPY scripts/uaw-mcp/ ./scripts/uaw-mcp/
COPY scripts/hooks/ ./scripts/hooks/
COPY schemas/ ./schemas/
COPY .github/skills/ ./.github/skills/
COPY .github/agents/ ./.github/agents/
COPY .github/instructions/ ./.github/instructions/
COPY .github/prompts/ ./.github/prompts/
COPY .github/hooks/ ./.github/hooks/

RUN rm -rf /opt/uaw/scripts/uwf-runner/test /opt/uaw/scripts/uaw-mcp/test \
  && find /opt/uaw/.github/skills -type f \( -name '*.db*' -o -name '*.sqlite*' -o -name '.env*' \) -delete \
  && chmod 0755 /opt/uaw/bin/uaw.mjs /opt/uaw/bin/uaw-mcp.mjs \
  && ln -sf /opt/uaw/bin/uaw.mjs /usr/local/bin/uaw \
  && ln -sf /opt/uaw/bin/uaw-mcp.mjs /usr/local/bin/uaw-mcp \
  && chown -R node:node /opt/uaw

ENV UWF_SKILLS_ROOT=/opt/uaw

USER node
WORKDIR /workspace

ENTRYPOINT ["uaw"]
CMD ["--help"]
