import { useEffect, useState } from 'react';
import { Spinner, StatusBadge } from '../components/ui';
import { mapProofreadingSheet, parseCsv, type MappedImport } from '../lib/csv';
import { formatDateTime } from '../lib/format';
import { friendlyError, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import type { AuditEntry, Profile, UserRole } from '../lib/types';

// ---------------------------------------------------------------- Import
export function AdminImport() {
  const toast = useToast();
  const [result, setResult] = useState<MappedImport | null>(null);
  const [publish, setPublish] = useState(false);
  const [fileText, setFileText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (fileText !== null) setResult(mapProofreadingSheet(parseCsv(fileText), { publishChecked: publish }));
  }, [fileText, publish]);

  async function onFile(f: File) {
    setDone(null);
    if (f.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB', 'error');
    if (!/\.csv$/i.test(f.name)) return toast('Export the sheet as CSV first (File > Save As > CSV)', 'error');
    setFileText(await f.text());
  }

  async function run() {
    if (!result || result.errors.length) return;
    setBusy(true);
    let ins = 0;
    let upd = 0;
    for (let i = 0; i < result.rows.length; i += 200) {
      const { data, error } = await supabase.rpc('staff_import_products', { p_rows: result.rows.slice(i, i + 200) });
      if (error) {
        setBusy(false);
        return toast(`Stopped at row ${i + 2}: ${friendlyError(error)}`, 'error');
      }
      const r = (data as { inserted: number; updated: number }[])[0];
      ins += r?.inserted ?? 0;
      upd += r?.updated ?? 0;
    }
    setBusy(false);
    setDone(`Imported: ${ins} new, ${upd} updated.`);
  }

  const counts = result
    ? { live: result.rows.filter((r) => r.status === 'live').length, review: result.rows.filter((r) => r.status === 'review').length, archived: result.rows.filter((r) => r.status === 'archived').length }
    : null;

  return (
    <>
      <h1>Import proofreading sheet</h1>
      <div className="box form" style={{ maxWidth: 720 }}>
        <p>Upload the product sheet saved as <b>CSV</b>. Rows are matched by <b>ID</b>: existing products are updated, new IDs are added. Costs and vendor details are never uploaded here.</p>
        <label className="btn sec" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
          Choose CSV file
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <label className="row"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish rows marked OK or Fixed</label>
        {result && (
          <>
            {result.errors.length > 0 ? (
              <div className="alert err" role="alert">
                <b>Fix these in the sheet, then upload again:</b>
                <ul style={{ paddingLeft: 18, marginTop: 6 }}>{result.errors.slice(0, 30).map((e) => <li key={e}>{e}</li>)}</ul>
                {result.errors.length > 30 && <p>…and {result.errors.length - 30} more.</p>}
              </div>
            ) : (
              <p className="alert info">{result.rows.length} rows ready · {counts!.live} will go live · {counts!.review} to review · {counts!.archived} archived</p>
            )}
            <button className="btn pri" onClick={run} disabled={busy || result.errors.length > 0 || !result.rows.length}>{busy ? 'Importing…' : 'Import'}</button>
          </>
        )}
        {done && <p className="alert ok">{done}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Users
export function AdminUsers() {
  const toast = useToast();
  const { profile: me } = useAuth();
  const [users, setUsers] = useState<Profile[] | null>(null);
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(1000).then(({ data }) => setUsers((data ?? []) as Profile[]));
  }, [tick]);

  async function setRole(id: string, role: UserRole) {
    const { error } = await supabase.rpc('admin_set_role', { p_user_id: id, p_role: role });
    if (error) return toast(friendlyError(error), 'error');
    toast('Role updated', 'success');
    setTick((t) => t + 1);
  }

  const needle = q.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => !needle || `${u.email} ${u.full_name} ${u.company}`.toLowerCase().includes(needle));
  return (
    <>
      <h1>Users</h1>
      <p className="note" style={{ marginBottom: 14 }}>Staff can manage products and quotes. Admins can also manage users and see the audit log.</p>
      <div className="toolbar"><input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" /></div>
      {users === null ? <Spinner /> : (
        <div className="tablewrap">
          <table className="t">
            <thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Joined</th><th>Role</th></tr></thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td><td>{u.full_name ?? '—'}</td><td>{u.company ?? '—'}</td><td>{formatDateTime(u.created_at)}</td>
                  <td>
                    <select className="input" style={{ width: 'auto' }} value={u.role} aria-label={`Role for ${u.email}`}
                      onChange={(e) => {
                        const role = e.target.value as UserRole;
                        if (u.id === me?.id && role !== 'admin' && !window.confirm('Remove your own admin access?')) return;
                        void setRole(u.id, role);
                      }}>
                      <option value="client">client</option><option value="staff">staff</option><option value="admin">admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Audit (admin)
export function AdminAudit() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(200);
      const list = (data ?? []) as AuditEntry[];
      setRows(list);
      const ids = [...new Set(list.map((r) => r.actor_id).filter((x): x is string => !!x))];
      if (ids.length) {
        const { data: ps } = await supabase.from('profiles').select('id, email').in('id', ids);
        setPeople(Object.fromEntries(((ps ?? []) as { id: string; email: string }[]).map((p) => [p.id, p.email])));
      }
    })();
  }, []);

  const changed = (r: AuditEntry) => {
    if (!r.old_data || !r.new_data) return '';
    return Object.keys(r.new_data)
      .filter((k) => k !== 'updated_at' && JSON.stringify(r.old_data![k]) !== JSON.stringify(r.new_data![k]))
      .join(', ');
  };

  return (
    <>
      <h1>Audit log</h1>
      <p className="note" style={{ marginBottom: 14 }}>Latest 200 changes to products, prices, vendors, quotes and roles.</p>
      {rows === null ? <Spinner /> : (
        <div className="tablewrap">
          <table className="t">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Table</th><th>Changed fields</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.created_at)}</td>
                  <td>{r.actor_id ? people[r.actor_id] ?? r.actor_id.slice(0, 8) : 'system'}</td>
                  <td><StatusBadge value={r.action === 'DELETE' ? 'remove' : r.action === 'INSERT' ? 'ok' : 'review'} label={r.action.toLowerCase()} /></td>
                  <td>{r.table_name}</td>
                  <td>{changed(r) || (typeof r.new_data?.name === 'string' ? r.new_data.name : '') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
