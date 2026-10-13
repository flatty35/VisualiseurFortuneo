import { NavLink, Route, Routes } from 'react-router-dom'
import DashboardPage from '@/ui/pages/DashboardPage'
import ImportPage from '@/ui/pages/ImportPage'
import ChartsPage from '@/ui/pages/ChartsPage'
import TriPage from '@/ui/pages/TriPage'
import ContributionPage from '@/ui/pages/ContributionPage'
import MappingsPage from '@/ui/pages/MappingsPage'
import BackupPage from '@/ui/pages/BackupPage'
import PrivacyPage from '@/ui/pages/PrivacyPage'

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/import', label: 'Import' },
  { to: '/charts', label: 'Graphiques' },
  { to: '/tri', label: 'TRI' },
  { to: '/contribution', label: 'Contribution' },
  { to: '/mappings', label: 'Correspondances' },
  { to: '/backup', label: 'Sauvegarde' },
  { to: '/privacy', label: 'Privacy' },
]

export default function App() {
  return (
    <div className="app-shell">
      <header className="nav">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          Visualiseur PEA &amp; CTO <span>Fortuneo · Saxo</span>
          <span className="badge brand-beta" title="Version bêta — résultats à vérifier">
            Beta
          </span>
        </div>
        <nav className="nav-links">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/charts" element={<ChartsPage />} />
        <Route path="/tri" element={<TriPage />} />
        <Route path="/contribution" element={<ContributionPage />} />
        <Route path="/mappings" element={<MappingsPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
      </Routes>
    </div>
  )
}
