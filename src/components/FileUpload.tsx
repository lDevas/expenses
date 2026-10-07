import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import type { ConsolidatedUploadSummary } from '../types/models';

interface Props {
  onUploadComplete?: () => void | Promise<void>;
}

export default function FileUpload({ onUploadComplete }: Props) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [result, setResult] = useState<ConsolidatedUploadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const handleFiles = async (selected: FileList | null) => {
    if (!selected?.length || busy.current) return;
    const batch = Array.from(selected);
    setError(null);
    setResult(null);
    if (batch.some(file => !/\.(pdf|csv|xls|xlsx)$/i.test(file.name))) {
      setError('Choose PDF, CSV, XLS, or XLSX statement files. This batch was not uploaded.');
      if (input.current) input.current.value = '';
      return;
    }
    busy.current = true;
    setUploading(true);
    setFiles(batch.map(file => file.name));
    const body = new FormData();
    for (const file of batch) body.append('file', file);
    try {
      const summary = await apiFetch<ConsolidatedUploadSummary>('/statements/upload', { method: 'POST', body });
      setResult(summary);
      await onUploadComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed. Try again.');
    } finally {
      busy.current = false;
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <div
        className={`statement-dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={e => { e.preventDefault(); if (!busy.current) setDragging(true); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={e => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer.files); }}
        aria-busy={uploading}
      >
        <input ref={input} type="file" multiple accept=".pdf,.csv,.xls,.xlsx" hidden
          disabled={uploading} onChange={e => void handleFiles(e.target.files)} aria-label="Select statement files" />
        <button type="button" className="statement-upload-button" disabled={uploading} onClick={() => input.current?.click()}>
          <span className="upload-symbol" aria-hidden="true">↑</span>
          <strong>{uploading ? 'Processing your statements…' : 'Drop statements here, or browse files'}</strong>
          <span>PDF, CSV, XLS, XLSX · Multiple files at once</span>
        </button>
        <p>Accounts are detected automatically. Uploading starts as soon as you choose files.</p>
      </div>
      <div className="upload-feedback" role="status" aria-live="polite">
        {uploading && <p>{files.length} file{files.length === 1 ? '' : 's'}: {files.join(', ')}</p>}
        {error && <p className="error">Upload failed: {error}</p>}
        {result && <div className="upload-result">
          <strong>{result.files.length} file{result.files.length === 1 ? '' : 's'} processed{result.issueCount ? ' with issues' : ''}.</strong>
          <p>{result.itemCount} items · {result.transferCount} transfers · {result.exchangeCount} exchanges · {result.positionCount} positions · {result.realizedCount} realized</p>
          <Link to={`/breakdown?run=${encodeURIComponent(result.runId)}`}>
            {result.issueCount ? `Review ${result.issueCount} issue${result.issueCount === 1 ? '' : 's'} and results` : 'View results'} →
          </Link>
        </div>}
      </div>
    </div>
  );
}
