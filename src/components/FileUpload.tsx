import { useState, useRef } from 'react';
import { apiFetch } from '../lib/api';

interface Props {
  institutionId: string;
  onUploadComplete?: (count: number) => void;
}

export default function FileUpload({ institutionId, onUploadComplete }: Props) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ count: number; error?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | File[]) => {
    setUploading(true);
    setResult(null);
    
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('institutionId', institutionId);
      
      const parserType = file.name.endsWith('.pdf') ? 'pdf' 
        : file.name.endsWith('.xlsx') || file.name.endsWith('.xls') ? 'excel'
        : 'csv';
      formData.append('parserType', parserType);
      
      try {
        const data = await apiFetch<{ transactionsIngested: number }>(`/transactions/upload`, {
          method: 'POST',
          body: formData,
        });

        setResult({ count: data.transactionsIngested });
        if (onUploadComplete) onUploadComplete(data.transactionsIngested);
      } catch (e) {
        setResult({ count: 0, error: e instanceof Error ? e.message : `Failed to process ${file.name}` });
      }
    }
    
    setUploading(false);
  };

  return (
    <div 
      className={`upload-zone ${dragging ? 'dragging' : ''} ${uploading ? 'uploading' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { 
        e.preventDefault(); 
        setDragging(false); 
        handleFiles(e.dataTransfer.files); 
      }}
      onClick={() => fileInputRef.current?.click()}
    >
      <input 
        ref={fileInputRef}
        type="file" 
        multiple 
        accept=".pdf,.csv,.xlsx,.xls"
        style={{ display: 'none' }}
        onChange={e => e.target.files && handleFiles(e.target.files)}
      />
      
      {uploading ? (
        <p>⏳ Processing files...</p>
      ) : (
        <>
          <p>📄 Drop PDF, CSV, or Excel files here</p>
          <p className="hint">or click to browse</p>
        </>
      )}
      
      {result && (
        <p className={result.error ? 'error' : 'success'}>
          {result.error || `${result.count} transactions ingested`}
        </p>
      )}
    </div>
  );
}
