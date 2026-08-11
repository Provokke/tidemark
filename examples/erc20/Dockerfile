# The project on the tidemark image: what Compose, Helm and the AWS module run.
FROM ghcr.io/provokke/tidemark:1.0.1
COPY --chown=node:node . /opt/tidemark/project
# A project with dependencies beyond @tidemark/* installs them next to it.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; fi
# Fail the image build, not the deployment, if the project does not bundle.
RUN tidemark build
