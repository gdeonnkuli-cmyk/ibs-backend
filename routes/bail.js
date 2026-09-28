const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");
const { notify } = require("../notify");
const { auditLog } = require("../audit");
const { urlDeStockageValide, MESSAGE_URL_INVALIDE } = require("../storage");

const router = express.Router();

// Durée de préavis retenue faute d'autre indication. Elle est modifiable à
// chaque congé : la durée applicable dépend du bail et du droit congolais, que
// ce code ne prétend pas trancher.
const PREAVIS_JOURS_DEFAUT = 30;

function estCoteBailleur(user, c) { return agenceIdDe(user) === c.bailleur_id; }

async function getContratPourPartie(contratId, user) {
  const r = await query(`SELECT * FROM contrats WHERE id = $1`, [contratId]);
  const c = r.rows[0];
  if (!c) return null;
  if (c.bailleur_id !== agenceIdDe(user) && c.locataire_id !== user.id) return "forbidden";
  return c;
}

function autrePartie(user, c) {
  return estCoteBailleur(user, c) ? c.locataire_id : c.bailleur_id;
}

// ── Donner congé ─────────────────────────────────────────────────────────
// Les deux parties peuvent en prendre l'initiative : un bailleur qui reprend
// son bien comme un locataire qui déménage.
router.post("/:id/preavis", requireAuth, async (req, res) => {
  try {
    const { motif, preavis_jours } = req.body;
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "signe") return res.status(409).json({ error: "Seul un bail signé peut faire l'objet d'un congé." });

    const jours = Number.isFinite(Number(preavis_jours)) && Number(preavis_jours) > 0
      ? Math.min(Number(preavis_jours), 365)
      : PREAVIS_JOURS_DEFAUT;
    const fin = new Date();
    fin.setDate(fin.getDate() + jours);
    const finISO = fin.toISOString().slice(0, 10);

    await query(
      `UPDATE contrats SET statut = 'preavis', preavis_par = $2, preavis_at = NOW(),
                           preavis_motif = $3, fin_effective = $4
       WHERE id = $1`,
      [c.id, req.user.id, motif || null, finISO]
    );
    await auditLog(req.user.id, "preavis_donne", { contrat_id: c.id, fin_effective: finISO, jours });

    const qui = estCoteBailleur(req.user, c) ? "Votre bailleur" : "Votre locataire";
    await notify(autrePartie(req.user, c),
      `IBS : ${qui} a donné congé. Le bail prend fin le ${finISO}. Préparez l'état des lieux de sortie.`, "sms");
    await notify(req.user.id, `IBS : votre congé est enregistré, fin du bail au ${finISO}.`, "in_app");

    res.json({ message: "Congé enregistré.", fin_effective: finISO, preavis_jours: jours });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Annuler un congé, tant que le bail n'est pas clos ─────────────────────
router.post("/:id/preavis/annuler", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "preavis") return res.status(409).json({ error: "Aucun congé en cours sur ce bail." });
    // Celui qui a donné congé est celui qui le retire.
    if (c.preavis_par !== req.user.id) {
      return res.status(403).json({ error: "Seule la partie qui a donné congé peut l'annuler." });
    }

    // Une fois la sortie engagée, le congé ne se retire plus : sans ce garde-fou
    // le bail repartait en 'signe' en laissant derrière lui un état des lieux de
    // sortie accepté et une garantie restituée — des pièces qui n'ont aucun sens
    // sur un bail en cours, et que personne ne pourrait plus corriger. Tant que
    // rien n'est acté (constat encore en attente ou contesté, garantie non
    // proposée), le congé reste révocable.
    const engage = await query(
      `SELECT
         EXISTS (SELECT 1 FROM etats_lieux WHERE contrat_id = $1 AND type = 'sortie' AND statut = 'accepte') AS constat,
         EXISTS (SELECT 1 FROM garanties WHERE contrat_id = $1 AND statut <> 'due') AS garantie`,
      [c.id]
    );
    const { constat, garantie } = engage.rows[0];
    if (constat || garantie) {
      return res.status(409).json({
        error: constat
          ? "L'état des lieux de sortie est accepté : le congé ne peut plus être annulé."
          : "La restitution de la garantie est engagée : le congé ne peut plus être annulé.",
      });
    }

    // Le constat de sortie encore en attente ou contesté perd son objet : le
    // laisser afficherait un état des lieux de sortie sur un bail qui continue.
    await query(`DELETE FROM etats_lieux WHERE contrat_id = $1 AND type = 'sortie'`, [c.id]);

    await query(
      `UPDATE contrats SET statut = 'signe', preavis_par = NULL, preavis_at = NULL,
                           preavis_motif = NULL, fin_effective = NULL WHERE id = $1`, [c.id]);
    await auditLog(req.user.id, "preavis_annule", { contrat_id: c.id });
    await notify(autrePartie(req.user, c), "IBS : le congé donné sur votre bail a été annulé. Le bail se poursuit.", "sms");
    res.json({ message: "Congé annulé. Le bail se poursuit." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── État des lieux : constat par une partie ──────────────────────────────
router.post("/:id/etat-lieux", requireAuth, async (req, res) => {
  try {
    const { type, observations, photos } = req.body;
    if (!["entree", "sortie"].includes(type)) {
      return res.status(400).json({ error: "Type invalide : 'entree' ou 'sortie'." });
    }
    const liste = Array.isArray(photos) ? photos.slice(0, 12) : [];
    if (liste.some((u) => !urlDeStockageValide(u))) {
      return res.status(400).json({ error: MESSAGE_URL_INVALIDE });
    }

    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (!["signe", "preavis"].includes(c.statut)) {
      return res.status(409).json({ error: "L'état des lieux ne concerne qu'un bail en cours." });
    }

    const existant = await query(
      `SELECT statut, fait_par FROM etats_lieux WHERE contrat_id = $1 AND type = $2`, [c.id, type]);
    // Un constat accepté fait foi : il ne se réécrit pas.
    if (existant.rows.length && existant.rows[0].statut === "accepte") {
      return res.status(409).json({ error: "Cet état des lieux est déjà accepté par les deux parties." });
    }
    if (existant.rows.length && existant.rows[0].fait_par !== req.user.id && existant.rows[0].statut === "en_attente") {
      return res.status(409).json({ error: "Un état des lieux est déjà en attente de votre validation." });
    }

    await query(
      `INSERT INTO etats_lieux (contrat_id, type, observations, photos, fait_par, statut)
       VALUES ($1,$2,$3,$4,$5,'en_attente')
       ON CONFLICT (contrat_id, type) DO UPDATE SET
         observations = $3, photos = $4, fait_par = $5, statut = 'en_attente',
         valide_par = NULL, valide_at = NULL, motif_contestation = NULL`,
      [c.id, type, observations || null, liste, req.user.id]
    );
    await auditLog(req.user.id, "etat_lieux_depose", { contrat_id: c.id, type, photos: liste.length });
    await notify(autrePartie(req.user, c),
      `IBS : un état des lieux de ${type === "entree" ? "entrée" : "sortie"} a été déposé sur votre bail. Vérifiez-le et validez-le dans l'application.`, "sms");

    res.status(201).json({ message: "État des lieux déposé. Il attend la validation de l'autre partie.", statut: "en_attente" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── État des lieux : accepter ou contester ───────────────────────────────
router.post("/:id/etat-lieux/:type/valider", requireAuth, async (req, res) => {
  try {
    const { accepte, motif } = req.body;
    const { type } = req.params;
    if (!["entree", "sortie"].includes(type)) return res.status(400).json({ error: "Type invalide." });
    if (accepte === false && (!motif || motif.trim().length < 5)) {
      return res.status(400).json({ error: "Un motif d'au moins 5 caractères est requis pour contester." });
    }

    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });

    const e = await query(`SELECT * FROM etats_lieux WHERE contrat_id = $1 AND type = $2`, [c.id, type]);
    if (!e.rows.length) return res.status(404).json({ error: "Aucun état des lieux déposé." });
    // On ne valide pas son propre constat : c'est l'autre partie qui le contrôle.
    if (e.rows[0].fait_par === req.user.id) {
      return res.status(403).json({ error: "C'est à l'autre partie de valider votre constat." });
    }
    if (e.rows[0].statut !== "en_attente") {
      return res.status(409).json({ error: "Cet état des lieux a déjà été traité." });
    }

    const nouveau = accepte === false ? "conteste" : "accepte";
    await query(
      `UPDATE etats_lieux SET statut = $3, valide_par = $4, valide_at = NOW(), motif_contestation = $5
       WHERE contrat_id = $1 AND type = $2`,
      [c.id, type, nouveau, req.user.id, accepte === false ? motif.trim() : null]
    );
    await auditLog(req.user.id, `etat_lieux_${nouveau}`, { contrat_id: c.id, type });

    const lbl = type === "entree" ? "d'entrée" : "de sortie";
    await notify(autrePartie(req.user, c), nouveau === "accepte"
      ? `IBS : votre état des lieux ${lbl} a été accepté.`
      : `IBS : votre état des lieux ${lbl} est contesté. Motif : ${motif.trim()}`, "sms");

    res.json({ message: nouveau === "accepte" ? "État des lieux accepté." : "Contestation enregistrée.", statut: nouveau });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Garantie : le bailleur annonce ce qu'il restitue ─────────────────────
router.post("/:id/garantie", requireAuth, async (req, res) => {
  try {
    const { montant_restitue, motif_retenue } = req.body;
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (!estCoteBailleur(req.user, c)) {
      return res.status(403).json({ error: "Seul le bailleur détient la garantie et en annonce la restitution." });
    }

    const propriete = await query(
      `SELECT p.garantie_mois FROM contrats ct
       JOIN offres o ON o.id = ct.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE ct.id = $1`, [c.id]);
    const mois = Number(propriete.rows[0]?.garantie_mois || 0);
    const initial = mois * Number(c.loyer_usd);
    if (!initial) {
      return res.status(409).json({ error: "Aucune garantie n'était prévue à ce bail." });
    }

    const restitue = Number(montant_restitue);
    if (!Number.isFinite(restitue) || restitue < 0 || restitue > initial) {
      return res.status(400).json({ error: `Le montant restitué doit être compris entre 0 et ${initial} USD.` });
    }
    // Toute retenue doit être motivée : c'est elle qui fait le litige.
    if (restitue < initial && (!motif_retenue || motif_retenue.trim().length < 5)) {
      return res.status(400).json({ error: "Une retenue doit être motivée (5 caractères minimum)." });
    }

    const deja = await query(`SELECT statut FROM garanties WHERE contrat_id = $1`, [c.id]);
    if (deja.rows.length && deja.rows[0].statut === "acceptee") {
      return res.status(409).json({ error: "La restitution de cette garantie est déjà soldée." });
    }

    await query(
      `INSERT INTO garanties (contrat_id, montant_initial, montant_restitue, motif_retenue, statut, declare_par, declare_at)
       VALUES ($1,$2,$3,$4,'proposee',$5,NOW())
       ON CONFLICT (contrat_id) DO UPDATE SET
         montant_initial = $2, montant_restitue = $3, motif_retenue = $4, statut = 'proposee',
         declare_par = $5, declare_at = NOW(), valide_par = NULL, valide_at = NULL, motif_contestation = NULL`,
      [c.id, initial, restitue, motif_retenue ? motif_retenue.trim() : null, req.user.id]
    );
    await auditLog(req.user.id, "garantie_proposee", { contrat_id: c.id, initial, restitue });

    const retenu = initial - restitue;
    await notify(c.locataire_id,
      retenu > 0
        ? `IBS : votre bailleur propose de vous restituer ${restitue} USD sur ${initial} USD de garantie (${retenu} USD retenus). Acceptez ou contestez dans l'application.`
        : `IBS : votre bailleur propose de vous restituer l'intégralité de la garantie, soit ${initial} USD. Confirmez dans l'application.`,
      "sms");

    res.json({ message: "Proposition de restitution enregistrée.", montant_initial: initial, montant_restitue: restitue, statut: "proposee" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Garantie : le locataire accepte ou conteste ──────────────────────────
router.post("/:id/garantie/valider", requireAuth, async (req, res) => {
  try {
    const { accepte, motif } = req.body;
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (estCoteBailleur(req.user, c)) {
      return res.status(403).json({ error: "C'est au locataire d'accepter ou de contester la restitution." });
    }
    if (accepte === false && (!motif || motif.trim().length < 5)) {
      return res.status(400).json({ error: "Un motif d'au moins 5 caractères est requis pour contester." });
    }

    const g = await query(`SELECT * FROM garanties WHERE contrat_id = $1`, [c.id]);
    if (!g.rows.length || g.rows[0].statut === "due") {
      return res.status(404).json({ error: "Aucune proposition de restitution à valider." });
    }
    if (g.rows[0].statut === "acceptee") return res.status(409).json({ error: "Restitution déjà soldée." });

    const nouveau = accepte === false ? "contestee" : "acceptee";
    await query(
      `UPDATE garanties SET statut = $2, valide_par = $3, valide_at = NOW(), motif_contestation = $4
       WHERE contrat_id = $1`,
      [c.id, nouveau, req.user.id, accepte === false ? motif.trim() : null]
    );
    await auditLog(req.user.id, `garantie_${nouveau}`, { contrat_id: c.id });

    await notify(c.bailleur_id, nouveau === "acceptee"
      ? "IBS : votre locataire a accepté la restitution de la garantie."
      : `IBS : votre locataire conteste la restitution de la garantie. Motif : ${motif.trim()}`, "sms");

    res.json({ message: nouveau === "acceptee" ? "Restitution acceptée." : "Contestation enregistrée.", statut: nouveau });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Clôturer le bail ─────────────────────────────────────────────────────
// Un bail ne se clôt qu'une fois les comptes faits : état des lieux de sortie
// accepté, et garantie soldée si le bail en prévoyait une. Sans quoi la
// clôture effacerait un désaccord au lieu de le régler.
router.post("/:id/cloturer", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut === "termine") return res.status(409).json({ error: "Ce bail est déjà clos." });
    if (c.statut !== "preavis") return res.status(409).json({ error: "Donnez d'abord congé sur ce bail." });

    const [sortie, garantie] = await Promise.all([
      query(`SELECT statut FROM etats_lieux WHERE contrat_id = $1 AND type = 'sortie'`, [c.id]),
      query(`SELECT statut FROM garanties WHERE contrat_id = $1`, [c.id]),
    ]);

    const manque = [];
    if (!sortie.rows.length || sortie.rows[0].statut !== "accepte") {
      manque.push("un état des lieux de sortie accepté par les deux parties");
    }
    if (garantie.rows.length && garantie.rows[0].statut !== "acceptee") {
      manque.push("la restitution de la garantie acceptée par le locataire");
    }
    if (manque.length) {
      return res.status(409).json({ error: `Il manque ${manque.join(" et ")}.`, manque });
    }

    await query(`UPDATE contrats SET statut = 'termine', cloture_at = NOW() WHERE id = $1`, [c.id]);
    // Le bien redevient disponible : sans cela il resterait marqué loué.
    await query(`UPDATE offres SET statut = 'active' WHERE id = $1 AND statut <> 'active'`, [c.offre_id]);
    await auditLog(req.user.id, "bail_cloture", { contrat_id: c.id });
    await notify(autrePartie(req.user, c), "IBS : votre bail est officiellement clos. Merci d'avoir utilisé IBS.", "sms");

    res.json({ message: "Bail clos.", statut: "termine" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Vue d'ensemble de la fin de bail ─────────────────────────────────────
router.get("/:id/fin", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });

    const [etats, garantie, prop] = await Promise.all([
      query(`SELECT type, observations, photos, fait_par, statut, motif_contestation, created_at
             FROM etats_lieux WHERE contrat_id = $1`, [c.id]),
      query(`SELECT * FROM garanties WHERE contrat_id = $1`, [c.id]),
      query(`SELECT p.garantie_mois FROM contrats ct JOIN offres o ON o.id = ct.offre_id
             JOIN proprietes p ON p.id = o.propriete_id WHERE ct.id = $1`, [c.id]),
    ]);

    const mois = Number(prop.rows[0]?.garantie_mois || 0);
    res.json({
      statut: c.statut,
      je_suis_bailleur: estCoteBailleur(req.user, c),
      preavis: c.preavis_at ? {
        donne_par_moi: c.preavis_par === req.user.id,
        motif: c.preavis_motif,
        fin_effective: c.fin_effective,
        donne_le: c.preavis_at,
      } : null,
      etats_lieux: Object.fromEntries(etats.rows.map((e) => [e.type, { ...e, depose_par_moi: e.fait_par === req.user.id }])),
      garantie: garantie.rows[0]
        ? { ...garantie.rows[0], propose_par_moi: garantie.rows[0].declare_par === req.user.id }
        : { statut: "due", montant_initial: mois * Number(c.loyer_usd), montant_restitue: null },
      garantie_prevue: mois > 0,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Litiges de fin de bail (admin) ───────────────────────────────────────
router.get("/admin/litiges", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const [etats, garanties] = await Promise.all([
      query(
        `SELECT e.contrat_id, e.type, e.observations, e.photos, e.motif_contestation, e.valide_at, pr.titre, pr.commune,
                b.nom AS bailleur_nom, b.telephone AS bailleur_tel,
                l.nom AS locataire_nom, l.telephone AS locataire_tel
         FROM etats_lieux e
         JOIN contrats c ON c.id = e.contrat_id
         JOIN offres o ON o.id = c.offre_id JOIN proprietes pr ON pr.id = o.propriete_id
         JOIN users b ON b.id = c.bailleur_id JOIN users l ON l.id = c.locataire_id
         WHERE e.statut = 'conteste' ORDER BY e.valide_at DESC`),
      query(
        `SELECT g.contrat_id, g.montant_initial, g.montant_restitue, g.motif_retenue,
                g.motif_contestation, g.valide_at, pr.titre, pr.commune,
                b.nom AS bailleur_nom, b.telephone AS bailleur_tel,
                l.nom AS locataire_nom, l.telephone AS locataire_tel
         FROM garanties g
         JOIN contrats c ON c.id = g.contrat_id
         JOIN offres o ON o.id = c.offre_id JOIN proprietes pr ON pr.id = o.propriete_id
         JOIN users b ON b.id = c.bailleur_id JOIN users l ON l.id = c.locataire_id
         WHERE g.statut = 'contestee' ORDER BY g.valide_at DESC`),
    ]);
    res.json({
      etats_lieux: etats.rows,
      garanties: garanties.rows,
      total: etats.rows.length + garanties.rows.length,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
