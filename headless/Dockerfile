FROM node:22-alpine

WORKDIR /app
COPY src/ ./src/
COPY headless/ ./headless/

USER node
ENV HEADLESS_CONFIG=/config/config.json
ENTRYPOINT ["node", "headless/cli.js"]
CMD ["run"]
