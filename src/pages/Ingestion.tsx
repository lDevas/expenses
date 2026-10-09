import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import FileUpload from '../components/FileUpload';
import StatementReports from '../components/StatementReports';
import { apiFetch } from '../lib/api';
import type { AccountUploadCoverage, ConsolidationRunSummary } from '../types/models';

const date = (value: string | null) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const uploadedAt = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
const dateMs = (value: string) => Date.parse(`${value}T00:00:00Z`);
const DAY = 86_400_000;
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const runLink = (id: string) => `/ingest?run=${encodeURIComponent(id)}#statement-reports`;

function CoverageAccount({ account, start, end }: { account: AccountUploadCoverage; start: string; end: string }) {
  const total = dateMs(end) - dateMs(start) + DAY;
  const position = (from: string, to: string) => {
    const visibleFrom = from < start ? start : from;
    const visibleTo = to > end ? end : to;
    if (visibleFrom > visibleTo) return { display: 'none' };
    return {
      left: `${(dateMs(visibleFrom) - dateMs(start)) / total * 100}%`,
      width: `${(dateMs(visibleTo) - dateMs(visibleFrom) + DAY) / total * 100}%`,
    };
  };
  return (
    <article className="coverage-account">
      <div className="coverage-account-heading">
        <div>
          <h3>{account.accountName} <span className="muted">· {account.currency}</span></h3>
          <p>{account.institutionName}{account.accountNumber && ` · ${account.accountNumber}`}</p>
        </div>
        <span className={`badge ${account.gaps.length ? 'warn' : account.ranges.length ? 'ok' : ''}`}>
          {account.gaps.length ? `${account.gaps.length} possible gap${account.gaps.length === 1 ? '' : 's'}` : account.ranges.length ? 'No gaps flagged' : 'No dated coverage'}
        </span>
      </div>
      <div className="coverage-track" role="img" aria-label={account.ranges.length
        ? `Uploaded ranges: ${account.ranges.map(r => `${date(r.from)} to ${date(r.to)}`).join('; ')}. ${account.gaps.length} possible gaps.`
        : 'No dated uploads for this account'}>
        {account.ranges.map(r => <span key={r.from} className="coverage-segment covered" style={position(r.from, r.to)}
          title={`Uploaded: ${date(r.from)} – ${date(r.to)}`} />)}
        {account.gaps.map(g => <span key={g.from} className="coverage-segment gap" style={position(g.from, g.to)}
          title={`Not uploaded: ${date(g.from)} – ${date(g.to)} (${g.days} days)`} />)}
      </div>
      <div className="coverage-meta">
        <span>{account.maxDate ? <>Uploaded through <strong>{date(account.maxDate)}</strong></> : 'Upload a statement to establish coverage'}</span>
        <span>{account.fileCount} unique file{account.fileCount === 1 ? '' : 's'}{account.hasLegacyUploads ? ' tracked + older uploads' : ''}</span>
        <span>Last upload: {uploadedAt(account.lastUploadAt)}</span>
        {account.latestRunId && <Link to={runLink(account.latestRunId)}>Latest run ↗</Link>}
      </div>
      {account.accountType === 'savings' && account.ranges.length > 0
        ? <p className="coverage-note">Savings uploads cover full calendar months, including days with no activity.</p>
        : account.hasInferredCoverage && <p className="coverage-note">Some ranges use activity dates, not a full statement period. Gaps may reflect days with no activity.</p>}
      {account.gaps.length > 0 && <ul className="coverage-gap-list">
        {account.gaps.map(g => <li key={g.from}>
          <strong>{g.kind === 'trailing' ? 'Needs updating' : 'Possible missing period'}:</strong> {date(g.from)} – {date(g.to)} <span className="muted">({g.days} days)</span>
        </li>)}
      </ul>}
      {account.uploads.length > 0 && <details className="coverage-files">
        <summary>Uploaded files &amp; date ranges ({account.uploads.length})</summary>
        {account.hasLegacyUploads && <p className="coverage-note">Older uploads did not record per-account files. Their activity ranges are recovered; file names and counts are unavailable.</p>}
        <div className="table-wrap"><table>
          <thead><tr><th>File</th><th>Dates</th><th>Range source</th><th>Uploaded</th><th>Run</th></tr></thead>
          <tbody>{account.uploads.map((file, i) => <tr key={`${file.runId}:${i}`}>
            <td className="ellipsize" title={file.file ?? ''}>{file.file ?? 'Older upload (file not recorded)'}</td>
            <td>{file.from ? `${date(file.from)} – ${date(file.to)}` : 'Dates unavailable'}</td>
            <td>{account.accountType === 'savings' && file.from && file.to ? 'Full calendar months' : file.basis === 'statement' ? 'Statement period' : file.basis === 'unknown' ? 'Unknown' : 'Activity dates'}</td>
            <td>{uploadedAt(file.uploadedAt)}</td><td><Link to={runLink(file.runId)}>{file.runId.slice(0, 8)} ↗</Link></td>
          </tr>)}</tbody>
        </table></div>
      </details>}
    </article>
  );
}

export default function Ingestion() {
  const [accounts, setAccounts] = useState<AccountUploadCoverage[]>([]);
  const [runs, setRuns] = useState<ConsolidationRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineView, setTimelineView] = useState<'recent' | 'all'>('recent');
  const [error, setError] = useState<string | null>(null);
  const [reportVersion, setReportVersion] = useState(0);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [coverage, history] = await Promise.all([
        apiFetch<AccountUploadCoverage[]>('/accounts/upload-ranges'),
        apiFetch<ConsolidationRunSummary[]>('/consolidation/runs'),
      ]);
      setAccounts(coverage);
      setRuns(history);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load upload history.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const dates = accounts.flatMap(a => a.ranges.flatMap(r => [r.from, r.to])).sort();
  const latest = dates.at(-1) ?? today();
  const end = timelineView === 'all' && latest > today() ? latest : today();
  const earliest = dates[0] ?? end;
  const recentStart = new Date(dateMs(end) - 365 * DAY).toISOString().slice(0, 10);
  const start = timelineView === 'recent' && earliest < recentStart ? recentStart : earliest > end ? end : earliest;
  const middle = new Date((dateMs(start) + dateMs(end)) / 2).toISOString().slice(0, 10);
  const withGaps = accounts.filter(a => a.gaps.length).length;

  return (
    <div className="ingestion-page">
      <header className="ingestion-header"><h1>Ingestion</h1><p>Upload statements. See what’s covered and what still needs updating.</p></header>
      <FileUpload onUploadComplete={async () => { await load(); setReportVersion(version => version + 1); }} />
      <StatementReports refreshKey={reportVersion} />
      {error && <div className="history-error" role="alert"><p className="error">{error}</p><button className="btn" onClick={() => void load()} disabled={loading}>Retry</button></div>}
      {loading && <p role="status">Loading coverage and run history…</p>}
      {!error && <>
        <section aria-labelledby="coverage-heading">
          <div className="ingestion-section-heading"><h2 id="coverage-heading">Upload coverage</h2><span>{accounts.length} accounts · {withGaps} with possible gaps</span></div>
          <p className="coverage-explanation">Each bar shows one account’s uploaded date ranges. Savings uploads cover full calendar months; other accounts use statement periods or activity dates. Gaps between uploads are flagged; accounts over 30 days behind today need updating.</p>
          {accounts.length ? <>
            <div className="timeline-controls">
              <label htmlFor="timeline-view">Timeline</label>
              <select id="timeline-view" value={timelineView} onChange={e => setTimelineView(e.target.value as 'recent' | 'all')}>
                <option value="recent">Recent year</option><option value="all">All uploaded dates</option>
              </select>
              {timelineView === 'recent' && earliest < start && <span>Older dates remain in file history and the full timeline.</span>}
            </div>
            <div className="coverage-legend"><span><i className="covered" />Uploaded range</span><span><i className="gap" />Not uploaded / possible gap</span><span><i className="untracked" />Outside uploaded ranges</span></div>
            <div className="timeline-axis"><span>{date(start)}</span>{start !== end && <><span>{date(middle)}</span><span>{date(end)}</span></>}</div>
            {accounts.map(account => <CoverageAccount key={account.accountId} account={account} start={start} end={end} />)}
          </> : !loading && <div className="ingestion-empty"><strong>No accounts uploaded yet</strong><p>Drop your statements above. Accounts and date ranges will appear automatically.</p></div>}
        </section>
        <section aria-labelledby="runs-heading">
          <div className="ingestion-section-heading"><h2 id="runs-heading">Consolidation runs</h2><span>{runs.length} runs</span></div>
          <p className="coverage-explanation">Every upload batch stays here, including files with parsing issues.</p>
          {runs.length ? <div className="table-wrap run-history"><table>
            <thead><tr><th>Uploaded</th><th>Files</th><th className="num">Items</th><th className="num">Transfers</th><th className="num">FX</th><th className="num">Positions</th><th className="num">Realized</th><th className="num">Issues</th><th>Details</th></tr></thead>
            <tbody>{runs.map(run => <tr key={run.runId}>
              <td>{uploadedAt(run.generatedAt)}</td>
              <td><details><summary>{run.files.length} file{run.files.length === 1 ? '' : 's'}</summary><ul className="run-files">{run.files.map((file, i) => <li key={i}>{file}</li>)}</ul></details></td>
              <td className="num">{run.itemCount}</td><td className="num">{run.transferCount}</td><td className="num">{run.exchangeCount}</td><td className="num">{run.positionCount}</td><td className="num">{run.realizedCount}</td>
              <td className="num">{run.issueCount ? <span className="badge warn">{run.issueCount}</span> : '0'}</td>
              <td><Link to={runLink(run.runId)} aria-label={`View run ${run.runId.slice(0, 8)}`}>View ↗</Link></td>
            </tr>)}</tbody>
          </table></div> : !loading && <div className="ingestion-empty"><p>No consolidation runs yet.</p></div>}
        </section>
      </>}
    </div>
  );
}
