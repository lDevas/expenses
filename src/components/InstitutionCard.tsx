import { useState } from 'react';
import type { Institution, IngestionRun } from '../types/models';
import { apiFetch } from '../lib/api';

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
      const run = await apiFetch<IngestionRun>(`/ingest/${institution.id}`, { method: 'POST' });
      setResult(run);
    } catch (e) {
      setResult({
        id: 'error',
        institutionId: institution.id,
        startedAt: new Date(),
        status: 'error',
        transactionsIngested: 0,
        error: e instanceof Error ? e.message : 'Failed to connect to server',
        steps: [],
      });
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
