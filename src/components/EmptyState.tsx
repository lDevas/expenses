import { Link } from 'react-router-dom';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  actionLabel?: string;
  actionTo?: string;
  onAction?: () => void;
}

export default function EmptyState({
  title,
  description,
  icon = '📊',
  actionLabel = 'Upload Statements',
  actionTo = '/ingest',
  onAction,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {description && <p className="empty-description">{description}</p>}
      <div className="empty-actions">
        {onAction ? (
          <button className="btn primary" onClick={onAction}>
            {actionLabel}
          </button>
        ) : (
          <Link to={actionTo} className="btn primary">
            {actionLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
