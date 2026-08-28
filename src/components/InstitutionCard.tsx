import { useState } from 'react';
import type { Institution, IngestionRun } from '../types/models';

const API_URL = 'http://localhost:3456/api';

interface Props {
  institution: Institution & { lastRun?: IngestionRun | null };
}

export default function InstitutionCard({ institution }: Props) {
  const [ingesting, setIngesting] = useState(false);
  const [result, setResult] = useState<IngestionRun | null>(null);

  const handleIngest = async () => {
    setIngesting(true);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/ingest/${institution.id}`, { method: 'POST' });
      const run = await res.json();
      setResult(run);
    } catch {
      setResult({ ...institution, error: 'Failed to connect to server' } as any);
    }
    setIngesting(false);
  };

  const getStatusIcon = () => {
    switch (institution.status) {
      case 'active': return '🟢';
      case 'error': return '🔴';
      case 'needs-setup': return '🟡';
    }
  };

  const getLastRunInfo = () => {
    const run = (institution as any).lastRun;
    if (!run) return 'Never synced';
    const date = new Date(run.startedAt).toLocaleDateString();
    return `${run.status} — ${run.transactionsIngested} txns (${date})`;
  };

  return (
    <div className="institution-card">
      <div className="card-header">
        <span className="status-icon">{getStatusIcon()}</span>
        <h3>{institution.name}</h3>
        <span className="institution-type">{institution.type}</span>
      </div>
      
      <p className="last-sync">Last sync: {getLastRunInfo()}</p>
      
      <div className="card-actions">
        <button 
          onClick={handleIngest}
          disabled={ingesting || institution.status === 'needs-setup'}
          className={ingesting ? 'loading' : ''}
        >
          {ingesting ? '⏳ Ingesting...' : 'Ingest Data'}
        </button>
        
        {institution.status === 'needs-setup' && (
          <button 
            onClick={() => window.location.href = `/setup/${institution.id}`}
            className="secondary"
          >
            Setup Session
          </button>
        )}
      </div>
      
      {result && (
        <div className="result-summary">
          <span className={result.status === 'success' ? 'success' : 'error'}>
            {result.status === 'success' ? '✅' : '❌'} {result.transactionsIngested} transactions
          </span>
          {result.error && <span className="error-text">{result.error}</span>}
        </div>
      )}
    </div>
  );
}
