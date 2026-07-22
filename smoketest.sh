#!/bin/bash
set -e
BASE="http://localhost:3000/api"
J() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
OTP() { node get_otp.js "$1" "$2"; }

echo "── 1. Inscription bailleur ──"
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" -d '{
  "role":"bailleur","nom":"Jean-Paul Mutombo","telephone":"+243810000001","password":"pass123",
  "commune":"Gombe","cni_recto_url":"http://x/r.jpg","cni_verso_url":"http://x/v.jpg"
}'
echo

echo "── 2. Inscription locataire ──"
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" -d '{
  "role":"locataire","nom":"Sophie Mbala","telephone":"+243810000002","password":"pass123",
  "commune":"Limete","cni_recto_url":"http://x/r2.jpg","cni_verso_url":"http://x/v2.jpg"
}'
echo

OTP_BAILLEUR=$(OTP "+243810000001" "connexion")
OTP_LOCATAIRE=$(OTP "+243810000002" "connexion")
echo "OTP bailleur=$OTP_BAILLEUR / locataire=$OTP_LOCATAIRE"

echo "── 3. Vérification téléphone (les deux) ──"
TOKEN_B=$(curl -s -X POST $BASE/auth/verify-phone -H "Content-Type: application/json" -d "{\"telephone\":\"+243810000001\",\"code\":\"$OTP_BAILLEUR\"}" | J "['token']")
TOKEN_L=$(curl -s -X POST $BASE/auth/verify-phone -H "Content-Type: application/json" -d "{\"telephone\":\"+243810000002\",\"code\":\"$OTP_LOCATAIRE\"}" | J "['token']")
echo "token bailleur: ${TOKEN_B:0:20}..."
echo "token locataire: ${TOKEN_L:0:20}..."

echo "── 4. Connexion admin ──"
TOKEN_A=$(curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" -d '{"telephone":"+243800000000","password":"admin123"}' | J "['token']")
echo "token admin: ${TOKEN_A:0:20}..."

echo "── 5. Admin vérifie les CNI en attente ──"
curl -s $BASE/auth/admin/cni-pending -H "Authorization: Bearer $TOKEN_A"
echo
BID=$(curl -s $BASE/auth/admin/cni-pending -H "Authorization: Bearer $TOKEN_A" | python3 -c "import sys,json; d=json.load(sys.stdin)['users']; print([u['id'] for u in d if u['telephone']=='+243810000001'][0])")
LID=$(curl -s $BASE/auth/admin/cni-pending -H "Authorization: Bearer $TOKEN_A" | python3 -c "import sys,json; d=json.load(sys.stdin)['users']; print([u['id'] for u in d if u['telephone']=='+243810000002'][0])")
curl -s -X POST $BASE/auth/admin/cni-review/$BID -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" -d '{"decision":"verifie"}'
echo
curl -s -X POST $BASE/auth/admin/cni-review/$LID -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" -d '{"decision":"verifie"}'
echo

echo "── 6. Le bailleur publie une offre ──"
OFFRE=$(curl -s -X POST $BASE/offres -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" -d '{
  "titre":"F3 Limete","type":"appartement","commune":"Limete","adresse":"Av. Kasa-Vubu",
  "chambres":3,"loyer_usd":320,"description":"Bel appartement 3 chambres","titre_propriete_url":"http://x/titre.pdf"
}')
echo $OFFRE
OFFRE_ID=$(echo $OFFRE | J "['offre_id']")

echo "── 7. Recherche publique (filtre commune) ──"
curl -s "$BASE/offres?commune=Limete"
echo

echo "── 8. Le locataire postule ──"
DEMANDE=$(curl -s -X POST $BASE/demandes -H "Authorization: Bearer $TOKEN_L" -H "Content-Type: application/json" -d "{\"offre_id\":$OFFRE_ID,\"message\":\"Très intéressée, disponible pour visite.\"}")
echo $DEMANDE
DEMANDE_ID=$(echo $DEMANDE | J "['demande_id']")

echo "── 9. Le bailleur sélectionne le candidat → contrat créé ──"
SELECT=$(curl -s -X POST $BASE/demandes/$DEMANDE_ID/selectionner -H "Authorization: Bearer $TOKEN_B")
echo $SELECT
CONTRAT_ID=$(echo $SELECT | J "['contrat_id']")

echo "── 10. Le bailleur prépare le contrat (durée + réception loyers) ──"
curl -s -X POST $BASE/contrats/$CONTRAT_ID/preparer -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" -d '{
  "duree_mois":12,"reception_loyer":"M-Pesa +243810000001"
}'
echo

echo "── 11. Confirmation avant signature (bailleur puis locataire) ──"
curl -s -X POST $BASE/contrats/$CONTRAT_ID/confirmer -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" -d '{
  "atteste_exactitude":true,"accepte_traitement_donnees":true,"consent_alertes":true
}'
echo
curl -s -X POST $BASE/contrats/$CONTRAT_ID/confirmer -H "Authorization: Bearer $TOKEN_L" -H "Content-Type: application/json" -d '{
  "atteste_exactitude":true,"accepte_traitement_donnees":true,"consent_alertes":true
}'
echo

OTP_SIG_B=$(OTP "+243810000001" "signature")
OTP_SIG_L=$(OTP "+243810000002" "signature")
echo "OTP signature bailleur=$OTP_SIG_B / locataire=$OTP_SIG_L"

echo "── 12. Signature électronique (bailleur puis locataire) ──"
curl -s -X POST $BASE/contrats/$CONTRAT_ID/signer -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" -d "{\"code\":\"$OTP_SIG_B\"}"
echo
curl -s -X POST $BASE/contrats/$CONTRAT_ID/signer -H "Authorization: Bearer $TOKEN_L" -H "Content-Type: application/json" -d "{\"code\":\"$OTP_SIG_L\"}"
echo

echo "── 13. Détail du contrat signé ──"
curl -s $BASE/contrats/$CONTRAT_ID -H "Authorization: Bearer $TOKEN_L"
echo

echo "── 14. Tableau de bord admin (entonnoir d'adoption) ──"
curl -s $BASE/admin/stats -H "Authorization: Bearer $TOKEN_A"
echo

echo "=== SMOKE TEST TERMINÉ AVEC SUCCÈS ==="
