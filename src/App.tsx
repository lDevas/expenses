import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Details from './pages/Details';
import Investments from './pages/Investments';
import Ingestion from './pages/Ingestion';
import Categories from './pages/Categories';
import ServerStatusBanner from './components/ServerStatusBanner';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

function LegacyReportRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/ingest', search, hash: '#statement-reports' }} replace />;
}

function Layout() {
  return (
    <div className="app">
      <nav className="sidebar">
        <h2>Expenses</h2>
        <ul>
          <li><NavLink to="/">Dashboard</NavLink></li>
          <li><NavLink to="/details">Details</NavLink></li>
          <li><NavLink to="/categories">Categories</NavLink></li>
          <li><NavLink to="/investments">Investments</NavLink></li>
          <li><NavLink to="/ingest" className="ingest">Ingestion</NavLink></li>
        </ul>
      </nav>
      <main className="content">
        <ServerStatusBanner />
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/details" element={<Details />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/breakdown" element={<LegacyReportRedirect />} />
            <Route path="/investments" element={<Investments />} />
            <Route path="/insights" element={<Navigate to="/investments" replace />} />
            <Route path="/ingest" element={<Ingestion />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}

export default App;
