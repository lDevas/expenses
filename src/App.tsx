import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Details from './pages/Details';
import Breakdown from './pages/Breakdown';
import Insights from './pages/Insights';
import IngestDashboard from './components/IngestDashboard';
import Upload from './pages/Upload';
import ServerStatusBanner from './components/ServerStatusBanner';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

function Layout() {
  return (
    <div className="app">
      <nav className="sidebar">
        <h2>Honiara</h2>
        <ul>
          <li><NavLink to="/">Dashboard</NavLink></li>
          <li><NavLink to="/details">Details</NavLink></li>
          <li><NavLink to="/upload">Upload</NavLink></li>
          <li><NavLink to="/breakdown">Breakdown</NavLink></li>
          <li><NavLink to="/insights">Insights</NavLink></li>
          <li><NavLink to="/ingest" className="ingest">Ingestion</NavLink></li>
        </ul>
      </nav>
      <main className="content">
        <ServerStatusBanner />
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/details" element={<Details />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/breakdown" element={<Breakdown />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/ingest" element={<IngestDashboard />} />
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
