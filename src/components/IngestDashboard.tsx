import { useState, useEffect } from 'react';
import InstitutionCard from './InstitutionCard';
import type { Institution } from '../types/models';
import { apiFetch } from '../lib/api';

export default function IngestDashboard() {
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Institution[]>('/ingest/status')
      .then(data => {
        setInstitutions(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load institutions');
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <h1>Ingestion Dashboard</h1>
      <p>Monitor and trigger data ingestion from your banks and investment platforms.</p>
      
      <div className="institution-grid">
        {institutions.map(inst => (
          <InstitutionCard key={inst.id} institution={inst} />
        ))}
      </div>
    </div>
  );
}
