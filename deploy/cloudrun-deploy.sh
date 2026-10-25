#!/usr/bin/env bash
# Deploys the API + UI container to Cloud Run with Cloud SQL (Postgres). Not run during the local build.
# Requires: gcloud auth, a project with billing, and a Cloud SQL instance (see docs/DEPLOY.md).
set -euo pipefail
: "${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${REGION:-europe-north1}"          # 30 gCO2e/kWh vs 579 in us-east1 (Google 2025 region table)
SERVICE="${SERVICE:-depmap}"
SQL_INSTANCE="${SQL_INSTANCE:-depmap-db}"
CONN="$GCP_PROJECT:$REGION:$SQL_INSTANCE"

IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT/depmap/$SERVICE:$(git rev-parse --short HEAD 2>/dev/null || date +%s)"

gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com --project "$GCP_PROJECT"
gcloud artifacts repositories describe depmap --location "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 \
  || gcloud artifacts repositories create depmap --repository-format docker --location "$REGION" --project "$GCP_PROJECT"
gcloud builds submit --project "$GCP_PROJECT" --config deploy/cloudbuild.yaml --substitutions "_IMAGE=$IMAGE" .
gcloud run deploy "$SERVICE" \
  --project "$GCP_PROJECT" --region "$REGION" --image "$IMAGE" \
  --allow-unauthenticated --port 8080 --memory 1Gi --cpu 1 --min-instances 0 --max-instances 3 \
  --add-cloudsql-instances "$CONN" \
  --set-env-vars "DATA_MODE=record,SCI_REGION=$REGION,SCI_GRID_INTENSITY=30,PUBLIC_URL=https://$SERVICE-$GCP_PROJECT.$REGION.run.app" \
  --set-secrets "DATABASE_URL=depmap-database-url:latest,APP_SECRET=depmap-app-secret:latest"
