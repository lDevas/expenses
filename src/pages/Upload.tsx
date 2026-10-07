import { useState, useRef } from 'react';
import type { ConsolidatedUploadSummary } from '../types/models';
import { apiFetch } from '../lib/api';

export default function Upload() {
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const selected = Array.from(fileList);
    setFiles(selected);
    await doUpload(selected);
  };

  const doUpload = async (selected: File[]) => {
    if (selected.length === 0) return;
    setUploading(true);
    setUploadMsg(null);
    const formData = new FormData();
    for (const file of selected) formData.append('file', file);
    try {
      const data = await apiFetch<ConsolidatedUploadSummary>('/statements/upload', { method: 'POST', body: formData });
      setUploadMsg(
        `Consolidated ${data.files.length} files: ${data.itemCount} items, ${data.transferCount} transfers, ${data.exchangeCount} exchanges, ${data.positionCount} positions, ${data.realizedCount} realized, ${data.issueCount} issues`
      );
    } catch (e) {
      setUploadMsg(e instanceof Error ? `Upload failed: ${e.message}` : 'Upload failed');
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div>
      <h1>Upload Statements</h1>
      <p>Upload bank and broker statement files to update your consolidated data. Supports PDF, CSV, XLS, XLSX. You can select multiple files at once.</p>

      <div
        className="upload-zone"
        onClick={() => fileInputRef.current?.click()}
        style={{ cursor: 'pointer' }}
      >
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.csv,.xlsx,.xls" style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
        {uploading ? <span>Consolidating…</span> : <span>Drop statement files here, or click to browse (multi-file)</span>}
        {files.length > 0 && !uploading && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {files.length} file{files.length > 1 ? 's' : ''} selected: {files.map(f => f.name).join(', ')}
          </div>
        )}
        {uploadMsg && <span className="upload-msg">{uploadMsg}</span>}
      </div>

      <section>
        <h2>What happens</h2>
        <ul>
          <li>Files are parsed by type (bank .xls/.csv/.pdf and broker IBKR CSV / eToro XLSX).</li>
          <li>Data is consolidated into SQLite: items, transfers, exchanges, positions, realized P/L.</li>
          <li>Broker wires are marked matched/unmatched; deposits/withdrawals never appear as expenses.</li>
          <li>Review results in Breakdown and Insights.</li>
        </ul>
      </section>
    </div>
  );
}
