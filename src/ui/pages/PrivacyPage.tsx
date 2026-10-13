export default function PrivacyPage() {
  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Confidentialité</h1>
        <p>
          <strong>Visualiseur PEA &amp; CTO — Fortuneo · Saxo</strong> est une application <em>local-first</em> :
          vos données de portefeuille (quantités, opérations, valorisations, cash) restent
          exclusivement dans le stockage de ce navigateur (IndexedDB).
        </p>
        <h2>Ce qui ne quitte jamais votre machine</h2>
        <ul className="muted">
          <li>Fichiers CSV / XLS Fortuneo ou XLSX Saxo et leur contenu</li>
          <li>Quantités, PRU, montants, opérations</li>
          <li>Exports JSON de sauvegarde (téléchargement local uniquement)</li>
        </ul>
        <h2>Seul trafic réseau éventuel</h2>
        <p className="muted">
          Des appels optionnels partent uniquement pour des{' '}
          <strong>identifiants de marché publics</strong> — jamais quantités, montants,
          PRU, opérations ni valorisations. Le proxy GAS rejette d’ailleurs les
          paramètres <code>quantity</code> / <code>qty</code> / <code>amount</code> /{' '}
          <code>pru</code>.
        </p>
        <ul className="muted">
          <li>
            <strong>Cours</strong> (proxy GAS) : tickers Yahoo + plages de dates
          </li>
          <li>
            <strong>Correspondances</strong> (GAS / Fortuneo / Morningstar en dev) :
            libellé ou ISIN en texte libre pour retrouver un ticker — cela révèle
            quels titres vous mappez, pas combien vous en détenez
          </li>
        </ul>
        <h2>Multi-utilisateur</h2>
        <p className="muted">
          Chaque personne utilise son propre navigateur. Il n’y a pas de compte ni de sync
          cloud du portefeuille. Le cache de cours côté proxy est partagé uniquement pour des
          OHLC publics (ticker + plage).
        </p>
        <h2>Effacement</h2>
        <p className="muted">
          Utilisez la page Sauvegarde → « Effacer le navigateur », ou les outils de
          développement du navigateur pour supprimer le site / IndexedDB.
        </p>
      </section>
    </div>
  )
}
