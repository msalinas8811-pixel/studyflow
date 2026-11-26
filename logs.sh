#!/bin/bash
# Muestra los últimos registros de la función del link (temLink)
gcloud functions logs read temLink --region=us-central1 --project=studyflow-d777d --limit=25 2>&1 | cut -c1-220
gcloud run services describe temlink --region=us-central1 --project=studyflow-d777d --format='value(status.latestReadyRevisionName,metadata.annotations)' 2>&1 | cut -c1-200
echo FIN-LOGS
