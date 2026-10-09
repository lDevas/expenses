import { useEffect, useState } from 'react';
import type { UserCategory } from '../types/categories';
import { apiFetch } from './api';

export function useCategories(revision = 0) {
  const [categories, setCategories] = useState<UserCategory[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    apiFetch<UserCategory[]>('/categories')
      .then(data => { if (!cancelled) { setCategories(data); setError(''); } })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [revision]);
  return { categories, categoryError: error };
}
