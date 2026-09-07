const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

async function getContratPourPartie(contratId, userId) {
  const r = await query(`SELECT * FROM contrats WHERE id = $1`, [contratId]);
  const c = r.rows[0];
  if (!c) return null;
  if (c.bailleur_id !== userId && c.locataire_id !== userId) return "forbidden";
  return c;
}

// ── Déclarer un mois payé (locataire ou bailleur, contrat signé uniquement) ──
router.post("/", requireAuth, async (req, res) => {
  try {
    const { contrat_id, mois, montant_usd, moyen } = req.body;
    if (!contrat_id || !mois || !montant_usd) return res.status(400).json({ error: "contrat_id, mois et montant_usd sont requis." });

    const c = await getContratPourPartie(contrat_id, req.user.id);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "signe") return res.status(403).json({ error: "Le carnet de loyer n'est disponible que pour un bail signé." });

    const moisDate = mois.length === 7 ? mois + "-01" : mois; // accepte "2026-09" ou "2026-09-01"

    await query(
      `INSERT INTO paiements_loyer (contrat_id, mois, montant_usd, moyen, declare_par)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (contrat_id, mois) DO UPDATE SET montant_usd = $3, moyen = $4, declare_par = $5`,
      [contrat_id, moisDate, montant_usd, moyen || null, req.user.id]
    );
    await auditLog(req.user.id, "loyer_declare_paye", { contrat_id, mois: moisDate });
    res.status(201).json({ message: "Mois marqué comme payé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Voir le carnet complet d'un contrat (échéancier calculé + paiements déclarés) ──
router.get("/contrat/:contrat_id", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.contrat_id, req.user.id);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "signe") return res.status(403).json({ error: "Le carnet de loyer n'est disponible que pour un bail signé." });

    const paiements = await query(
      `SELECT mois, montant_usd, moyen, declare_par, created_at FROM paiements_loyer WHERE contrat_id = $1 ORDER BY mois ASC`,
      [c.id]
    );
    const payesParMois = new Map(paiements.rows.map(p => [p.mois.toISOString().slice(0, 7), p]));

    const debut = new Date(c.signed_at || c.created_at);
    debut.setDate(1);
    const aujourdHui = new Date(); aujourdHui.setDate(1);

    const echeancier = [];
    for (let i = 0; i < c.duree_mois; i++) {
      const d = new Date(debut); d.setMonth(d.getMonth() + i);
      const cle = d.toISOString().slice(0, 7);
      const paiement = payesParMois.get(cle);
      let statut;
      if (paiement) statut = "paye";
      else if (d < aujourdHui) statut = "en_retard";
      else if (d.getTime() === aujourdHui.getTime()) statut = "du_ce_mois";
      else statut = "a_venir";
      echeancier.push({ mois: cle, montant_usd: paiement ? paiement.montant_usd : c.loyer_usd, statut, moyen: paiement ? paiement.moyen : null });
    }

    const moisEnRetard = echeancier.filter(e => e.statut === "en_retard").length;
    res.json({ echeancier, mois_en_retard: moisEnRetard, loyer_usd: c.loyer_usd, duree_mois: c.duree_mois });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
