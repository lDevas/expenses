import { useCallback, useEffect, useState } from 'react';
import { checkServerHealth } from '../lib/api';

type Health = 'checking' | 'up' | 'down';

const POLL_INTERVAL_MS = 10_000;

// Shown at the top of the app whenever the API server cannot be reached,
// so the "server is down" state is consistent no matter which page you're on.
export default function ServerStatusBanner() {
  const [health, setHealth] = useState<Health>('checking');

  const check = useCallback(async () => {
    setHealth((await checkServerHealth()) ? 'up' : 'down');
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (health !== 'down') return;
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [health, check]);

  if (health !== 'down') return null;

  return (
    <div className="server-banner" role="alert">
      <div>
        <strong>Can't reach the data server</strong>
        <p>The API server doesn't seem to be running. Start it, then try again.</p>
      </div>
      <button className="btn" onClick={() => check()}>Retry</button>
    </div>
  );
}
