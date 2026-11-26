#!/bin/bash
# Instala el servidor de StudyFlow en Firebase (proyecto studyflow-d777d)
set -e
cd "$(dirname "$0")/firebase"
(cd functions && npm install --no-audit --no-fund)
firebase deploy --only firestore:rules,functions --project studyflow-d777d --force
gcloud functions add-invoker-policy-binding temLink --region=us-central1 --member=allUsers --project=studyflow-d777d --quiet || echo "AVISO: no se pudo dar permiso a temLink"
echo "LISTO-STUDYFLOW"
