export default function PrivacyPage() {
  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Confidentialité</h1>
        <p>
          <strong>Visualiseur Fortuneo</strong> est une application <em>local-first</em> :
          vos données de portefeuille (quantités, opérations, valorisations, cash) restent
          exclusivement dans le stockage de ce navigateur (IndexedDB).
        </p>
        <h2>Ce qui ne quitte jamais votre machine</h2>
        <ul className="muted">
          <li>Fichiers CSV / XLS Fortuneo et leur contenu</li>
          <li>Quantités, PRU, montants, opérations</li>
          <li>Exports JSON de sauvegarde (téléchargement local uniquement)</li>
        </ul>
        <h2>Seul trafic réseau éventuel</h2>
        <p className="muted">
          Un proxy Google Apps Script optionnel peut être configuré pour récupérer des{' '}
          <strong>cours de marché publics</strong>. Le client n’y envoie que des{' '}
          <code>tickers</code> Yahoo et des plages de dates — jamais votre portefeuille.
        </p>
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
