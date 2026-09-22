import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api.js';
import { useSelectedApp } from '../app.js';

/**
 * The per-application pages (requests, usage, policy) all need one selected DApp. The picker owns that choice and
 * falls back to the first application, so a fresh browser lands on something useful instead of an empty page.
 */
export const useApplicationScope = () => {
  const [selected, select] = useSelectedApp();
  const apps = useQuery({ queryKey: ['applications'], queryFn: api.applications, staleTime: 30_000 });
  const list = apps.data ?? [];
  const valid = selected && list.some((a) => a.id === selected) ? selected : list[0]?.id ?? null;
  useEffect(() => { if (valid && valid !== selected) select(valid); }, [valid, selected, select]);
  return { applicationId: valid, applications: list, select, isPending: apps.isPending, error: apps.error };
};

export const AppPicker = ({ value, onChange, applications }: {
  value: string | null; onChange: (id: string) => void; applications: { id: string; name: string }[];
}) => (
  <label className="field">Application
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={!applications.length}>
      {applications.length === 0 && <option value="">no applications</option>}
      {applications.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  </label>
);
