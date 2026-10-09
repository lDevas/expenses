import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { ConsolidatedResult } from '../types/models';
import { ApiError, apiFetch } from '../lib/api';
import MovementReconciliation from './MovementReconciliation';
import './StatementReports.css';

export default function StatementReports({ refreshKey = 0 }: { refreshKey?: number }) {
  const [result, setResult] = useState<ConsolidatedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const runId = params.get('run');
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    apiFetch<ConsolidatedResult>(runId ? `/consolidation/runs/${encodeURIComponent(runId)}/report` : '/statements/consolidated',
      { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setResult(null);
        setError(e instanceof ApiError && e.status === 404 && !runId ? null : e.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runId]);
  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    if (!loading && hash === '#statement-reports') document.getElementById('statement-reports')?.scrollIntoView();
  }, [loading, hash]);

  return (
    <div id="statement-reports" className="statement-reports">
      <div className="report-section-heading">
        <h2>Statement reports</h2>
        {runId && <Link to="/ingest#statement-reports">View all uploaded statements →</Link>}
      </div>
      <p className="report-section-note">{runId ? `Run ${runId.slice(0, 8)}` : 'All uploaded statements'} · Includes bank, card, and investment accounts. Amounts keep their original currencies.</p>
      {loading ? <p role="status">Loading statement reports…</p> : error ? (
        <div role="alert"><p className="error">{error}</p><button className="btn" onClick={load}>Retry</button></div>
      ) : !result ? <p className="muted">Upload statements to see issues and transfer reconciliation.</p> : <>
        <p className="report-section-note">Updated {new Date(result.generatedAt).toLocaleString()} · {result.files.length} files</p>
        <section aria-labelledby="issues-heading">
          <div className="report-section-heading"><h2 id="issues-heading">Issue report</h2><span>{result.issues.length} issues</span></div>
          {result.issues.length ? <ul className="issue-list">
            {result.issues.map((issue, i) => <li key={i} className={`issue-row ${issue.severity}`}>
              <span className="badge">{issue.severity}</span>
              <span className="issue-where">{[issue.file, issue.sheet, issue.row != null ? `row ${issue.row}` : null, issue.field].filter(Boolean).join(' · ')}</span>
              <span>{issue.message}</span>
            </li>)}
          </ul> : <p className="muted">No issues reported.</p>}
        </section>
        <MovementReconciliation key={result.runId} transfers={result.transfers} exchanges={result.exchanges} />
      </>}
    </div>
  );
}
