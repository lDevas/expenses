import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Details from './pages/Details';
import Breakdown from './pages/Breakdown';
import Insights from './pages/Insights';
import './App.css';

function Layout() {
  return (
    <div className="app">
      <nav className="sidebar">
        <h2>Honiara</h2>
        <ul>
          <li><NavLink to="/">Dashboard</NavLink></li>
          <li><NavLink to="/details">Details</NavLink></li>
          <li><NavLink to="/breakdown">Breakdown</NavLink></li>
          <li><NavLink to="/insights">Insights</NavLink></li>
        </ul>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/details" element={<Details />} />
          <Route path="/breakdown" element={<Breakdown />} />
          <Route path="/insights" element={<Insights />} />
        </Routes>
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
