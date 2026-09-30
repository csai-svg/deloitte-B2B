/* Deloitte B2B Store — admin portal (admin.html only).
   Vanilla JS, same el()/api()/toast() helpers as the rest of the site
   (assets/js/app.js, loaded before this file). Every admin_* call carries
   the signed-in session token via api()'s envelope — there is no separate
   admin password. The server re-checks role on every call; anything this
   file hides for a lower role is UX only, never the actual gate. */

const ROLE_LABEL = { user: 'User', admin: 'Admin', super_admin: 'Super admin' };

const Admin = {
  tab: 'users',
  users: null,          // all rows from admin_users, refreshed on demand
  loading: false,

  async load(force) {
    if (this.users && !force) return this.users;
    this.loading = true;
    try {
      const d = await api('admin_users', {});
      this.users = d.users;
    } finally {
      this.loading = false;
    }
    return this.users;
  },
};

/* --------------------------------------------------------------- drawer */

function closeAdminDrawer() {
  document.getElementById('admShade')?.remove();
}

function openAdminDrawer(title, bodyNode) {
  closeAdminDrawer();
  const shade = el('div', {
    class: 'adm-shade', id: 'admShade',
    onclick: e => { if (e.target.id === 'admShade') closeAdminDrawer(); },
  },
    el('div', { class: 'adm-drawer' },
      el('div', { class: 'adm-drawer-head' },
        el('h2', { style: 'margin:0;font-size:1.1rem' }, title),
        el('button', { type: 'button', 'aria-label': 'Close', onclick: closeAdminDrawer }, '×')),
      bodyNode));
  document.body.append(shade);
  document.addEventListener('keydown', adminDrawerEscape);
}
function adminDrawerEscape(e) {
  if (e.key === 'Escape') { closeAdminDrawer(); document.removeEventListener('keydown', adminDrawerEscape); }
}

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', {}, label), input,
    hint ? el('div', { class: 'small muted', style: 'margin-top:4px;font-weight:400;text-transform:none' }, hint) : null);
}

/* One-time password panel: shown once, cleared the moment the drawer that
   holds it closes (it is never written to localStorage, the URL, or logged
   to the console). */
function onePasswordPanel(pw) {
  const box = el('div', { class: 'adm-onepass' }, pw);
  return el('div', {},
    el('div', { class: 'small', style: 'color:#b3261e;font-weight:700;margin-top:14px' },
      'Copy this now — it will not be shown again.'),
    box,
    el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm',
      onclick: async () => {
        try { await navigator.clipboard.writeText(pw); toast('Password copied.'); }
        catch (e) { toast('Could not copy — select and copy manually.', 'error'); }
      },
    }, 'Copy password'));
}

function toggleSwitch(on, onChange) {
  const btn = el('button', {
    type: 'button', class: 'adm-switch' + (on ? ' on' : ''),
    'aria-pressed': on ? 'true' : 'false',
    onclick: async () => {
      btn.disabled = true;
      try { await onChange(!on); } finally { btn.disabled = false; }
    },
  });
  return btn;
}

function overflowMenu(items) {
  const wrap = el('div', { class: 'adm-menu' });
  const list = el('div', { class: 'adm-menu-list', style: 'display:none' });
  items.forEach(it => {
    if (!it) return;
    list.append(el('button', {
      type: 'button', class: it.danger ? 'danger' : '',
      onclick: () => { list.style.display = 'none'; it.onclick(); },
    }, it.label));
  });
  const btn = el('button', {
    type: 'button', class: 'btn btn-ghost btn-sm', onclick: e => {
      e.stopPropagation();
      const open = list.style.display !== 'none';
      document.querySelectorAll('.adm-menu-list').forEach(l => l.style.display = 'none');
      list.style.display = open ? 'none' : 'block';
    },
  }, '⋯');
  document.addEventListener('click', () => { list.style.display = 'none'; });
  wrap.append(btn, list);
  return wrap;
}

/* -------------------------------------------------------------- helpers */

function roleBadge(role) {
  return el('span', { class: 'adm-role-chip' + (role === 'super_admin' ? ' super' : '') }, ROLE_LABEL[role] || role);
}

function boolBadge(on, onLabel, offLabel) {
  return el('span', { class: 'adm-badge' + (on ? ' on' : '') }, on ? onLabel : offLabel);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* --------------------------------------------------------------- add user */

function addUserDrawer(allowRole) {
  const draft = { username: '', name: '', email: '', company: '', notes: '', agent_access: false, role: 'user', password: '' };
  const genOnly = { value: true };

  const body = el('div', {});
  const renderForm = () => {
    body.textContent = '';
    body.append(
      el('div', { class: 'adm-form-grid' },
        field('Username', el('input', {
          type: 'text', autocomplete: 'off', placeholder: 'firstname.lastname',
          oninput: e => { draft.username = e.target.value.trim().toLowerCase(); },
        }), 'Lowercase letters, digits, . _ or - only.'),
        field('Name', el('input', { type: 'text', oninput: e => { draft.name = e.target.value; } })),
        field('Email', el('input', { type: 'email', oninput: e => { draft.email = e.target.value.trim(); } })),
        field('Company', el('input', { type: 'text', oninput: e => { draft.company = e.target.value; } })),
        field('Notes', el('input', { type: 'text', oninput: e => { draft.notes = e.target.value; } })),
        el('label', { class: 'rail-check' },
          el('input', { type: 'checkbox', onchange: e => { draft.agent_access = e.target.checked; } }),
          el('span', {}, 'Agent Merch access')),
        allowRole ? el('label', { class: 'field' }, el('span', {}, 'Role'),
          el('select', { onchange: e => { draft.role = e.target.value; } },
            el('option', { value: 'user' }, 'User'),
            el('option', { value: 'admin' }, 'Admin'))) : null,
        el('label', { class: 'rail-check' },
          el('input', {
            type: 'checkbox', checked: 'checked',
            onchange: e => { genOnly.value = e.target.checked; renderPwField(); },
          }),
          el('span', {}, 'Generate a temporary password')),
        el('div', { id: 'admPwField' })),
      el('div', { class: 'row', style: 'margin-top:20px' },
        el('button', {
          class: 'btn', onclick: async () => {
            try {
              const r = await api('admin_add_user', { user: draft });
              toast(draft.username + ' added.');
              if (r.generated_password) {
                openAdminDrawer('Password for ' + draft.username, onePasswordPanel(r.generated_password));
              } else {
                closeAdminDrawer();
              }
              Admin.load(true).then(paintAdminBody);
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Add user'),
        el('button', { class: 'btn btn-ghost', onclick: closeAdminDrawer }, 'Cancel')));
    renderPwField();
  };
  const renderPwField = () => {
    const host = document.getElementById('admPwField');
    if (!host) return;
    host.textContent = '';
    if (!genOnly.value) {
      host.append(field('Temporary password (min. 10 characters)', el('input', {
        type: 'text', autocomplete: 'off', oninput: e => { draft.password = e.target.value; },
      })));
    } else {
      draft.password = '';
    }
  };
  renderForm();
  openAdminDrawer('Add user', body);
}

/* ------------------------------------------------------------- bulk import */

function importUsersDrawer() {
  const draft = { csv: '', password: '' };
  const preview = el('div', { class: 'small muted', style: 'margin-top:8px' });

  const parse = () => {
    const lines = draft.csv.split('\n').map(l => l.trim()).filter(Boolean);
    const rows = lines.map(l => {
      const [username, name, email, company] = l.split(',').map(s => (s || '').trim());
      return { username: (username || '').toLowerCase(), name: name || '', email: email || '', company: company || '' };
    }).filter(r => r.username);
    preview.textContent = rows.length + ' row(s) parsed.';
    return rows;
  };

  openAdminDrawer('Import list', el('div', {},
    el('div', { class: 'small muted' }, 'Paste CSV: username,name,email,company — one per line. Up to 200 rows.'),
    el('textarea', {
      rows: 8, style: 'width:100%;margin-top:10px;font-family:ui-monospace,monospace;font-size:.8rem;padding:8px',
      oninput: e => { draft.csv = e.target.value; parse(); },
    }),
    preview,
    field('Shared temporary password (leave blank to generate one per user)', el('input', {
      type: 'text', autocomplete: 'off', oninput: e => { draft.password = e.target.value; },
    })),
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', {
        class: 'btn', onclick: async () => {
          const rows = parse();
          if (!rows.length) { toast('Paste at least one row.', 'error'); return; }
          try {
            const r = await api('admin_bulk_users', { users: rows, password: draft.password });
            toast(r.added.length + ' added, ' + r.skipped.length + ' skipped, ' + r.failed.length + ' failed.');
            if (r.passwords && Object.keys(r.passwords).length) {
              downloadCsv('deloitte-new-users-passwords.csv',
                [['username', 'password']].concat(Object.entries(r.passwords)));
              toast('Generated passwords downloaded as CSV.');
            }
            closeAdminDrawer();
            Admin.load(true).then(paintAdminBody);
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Import'),
      el('button', { class: 'btn btn-ghost', onclick: closeAdminDrawer }, 'Cancel'))));
}

/* ------------------------------------------------------------------ edit */

function editUserDrawer(u, allowRole) {
  const draft = { name: u.name, email: u.email, company: u.company, notes: u.notes, agent_access: u.agent_access, role: u.role };
  openAdminDrawer('Edit ' + u.username, el('div', {},
    el('div', { class: 'adm-form-grid' },
      field('Name', el('input', { type: 'text', value: draft.name, oninput: e => { draft.name = e.target.value; } })),
      field('Email', el('input', { type: 'email', value: draft.email, oninput: e => { draft.email = e.target.value.trim(); } })),
      field('Company', el('input', { type: 'text', value: draft.company, oninput: e => { draft.company = e.target.value; } })),
      field('Notes', el('input', { type: 'text', value: draft.notes, oninput: e => { draft.notes = e.target.value; } })),
      el('label', { class: 'rail-check' },
        el('input', { type: 'checkbox', checked: draft.agent_access ? 'checked' : null,
          onchange: e => { draft.agent_access = e.target.checked; } }),
        el('span', {}, 'Agent Merch access')),
      (allowRole && u.role !== 'super_admin') ? el('label', { class: 'field' }, el('span', {}, 'Role'),
        el('select', { onchange: e => { draft.role = e.target.value; } },
          el('option', { value: 'user', selected: draft.role === 'user' ? 'selected' : null }, 'User'),
          el('option', { value: 'admin', selected: draft.role === 'admin' ? 'selected' : null }, 'Admin'))) : null),
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            await api('admin_update_user', { username: u.username, user: draft });
            toast('Saved.');
            closeAdminDrawer();
            Admin.load(true).then(paintAdminBody);
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Save'),
      el('button', { class: 'btn btn-ghost', onclick: closeAdminDrawer }, 'Cancel'))));
}

/* --------------------------------------------------------- reset password */

function resetPasswordDrawer(u) {
  const draft = { password: '' };
  const genOnly = { value: true };
  const body = el('div', {});
  const pwHost = el('div', { id: 'admResetPwField' });

  const renderPwField = () => {
    pwHost.textContent = '';
    if (!genOnly.value) {
      pwHost.append(field('New temporary password (min. 10 characters)', el('input', {
        type: 'text', autocomplete: 'off', oninput: e => { draft.password = e.target.value; },
      })));
    } else {
      draft.password = '';
    }
  };

  body.append(
    el('div', { class: 'small muted' }, 'Issues a new temporary password and signs ' + u.username + ' out everywhere.'),
    el('label', { class: 'rail-check', style: 'margin-top:12px' },
      el('input', { type: 'checkbox', checked: 'checked', onchange: e => { genOnly.value = e.target.checked; renderPwField(); } }),
      el('span', {}, 'Generate a temporary password')),
    pwHost,
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            const r = await api('admin_reset_password', { username: u.username, password: draft.password });
            if (r.generated_password) {
              openAdminDrawer('New password for ' + u.username, onePasswordPanel(r.generated_password));
            } else {
              toast('Password reset.');
              closeAdminDrawer();
            }
            Admin.load(true).then(paintAdminBody);
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Reset password'),
      el('button', { class: 'btn btn-ghost', onclick: closeAdminDrawer }, 'Cancel')));
  renderPwField();
  openAdminDrawer('Reset password', body);
}

/* ----------------------------------------------------------- users table */

function userTable(rows, opts) {
  opts = opts || {};
  if (!rows.length) return el('div', { class: 'adm-empty' }, opts.emptyText || 'No users yet.');

  return el('div', { class: 'adm-table-wrap' },
    el('table', { class: 'adm-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Username'), el('th', {}, 'Email'),
        el('th', {}, 'Company'), el('th', {}, 'Role'), el('th', {}, 'Agent Merch'),
        el('th', {}, 'Status'), el('th', {}, 'Last sign-in'), el('th', {}, ''))),
      el('tbody', {}, rows.map(u => el('tr', {},
        el('td', {}, u.name || '—'),
        el('td', {}, u.username),
        el('td', {}, u.email || '—'),
        el('td', {}, u.company || '—'),
        el('td', {}, roleBadge(u.role)),
        el('td', {}, boolBadge(u.agent_access, 'On', 'Off')),
        el('td', {}, u.role === 'super_admin'
          ? boolBadge(u.active, 'Active', 'Inactive')
          : el('div', { style: 'display:flex;align-items:center;gap:8px' },
              toggleSwitch(u.active, async on => {
                if (!on && !confirm('Deactivate ' + u.username + '? They will be signed out immediately.')) return;
                try {
                  await api('admin_set_active', { username: u.username, active: on });
                  u.active = on;
                  toast(u.username + (on ? ' activated.' : ' deactivated.'));
                  paintAdminBody();
                } catch (err) { toast(err.message, 'error'); }
              }),
              u.locked ? el('span', { class: 'adm-badge warn' }, 'Locked') : null)),
        el('td', { class: 'small muted' }, u.last_login || 'Never'),
        // Super admin rows are read-only from the portal — the server refuses
        // every admin_* write against one anyway (assertCanManageTarget_),
        // so the menu that would only ever come back 'unauthorized' is left
        // off entirely rather than shown and disabled.
        el('td', {}, (opts.readOnly || u.role === 'super_admin') ? null : overflowMenu([
          { label: 'Edit', onclick: () => editUserDrawer(u, opts.allowRole) },
          { label: 'Reset password', onclick: () => resetPasswordDrawer(u) },
          u.locked ? {
            label: 'Unlock', onclick: async () => {
              try { await api('admin_unlock_user', { username: u.username }); toast('Unlocked.'); Admin.load(true).then(paintAdminBody); }
              catch (err) { toast(err.message, 'error'); }
            },
          } : null,
          opts.allowRole && u.role === 'admin' ? {
            label: 'Demote to user', onclick: async () => {
              if (!confirm('Demote ' + u.username + ' to user?')) return;
              try { await api('admin_update_user', { username: u.username, user: { role: 'user' } }); toast('Demoted.'); Admin.load(true).then(paintAdminBody); }
              catch (err) { toast(err.message, 'error'); }
            },
          } : null,
          opts.allowRole && u.role === 'user' ? {
            label: 'Promote to admin', onclick: async () => {
              if (!confirm('Promote ' + u.username + ' to admin?')) return;
              try { await api('admin_update_user', { username: u.username, user: { role: 'admin' } }); toast('Promoted.'); Admin.load(true).then(paintAdminBody); }
              catch (err) { toast(err.message, 'error'); }
            },
          } : null,
          opts.superAdmin ? {
            label: 'Sign out everywhere', onclick: async () => {
              if (!confirm('Sign ' + u.username + ' out of every device?')) return;
              try { await api('admin_revoke_sessions', { username: u.username }); toast('Sessions revoked.'); }
              catch (err) { toast(err.message, 'error'); }
            },
          } : null,
        ])))))));
}

/* -------------------------------------------------------------- tab panes */

function filterUsers(rows, q) {
  const s = (q.search || '').trim().toLowerCase();
  return rows.filter(u => {
    if (q.active === 'active' && !u.active) return false;
    if (q.active === 'inactive' && u.active) return false;
    if (q.agent === 'on' && !u.agent_access) return false;
    if (q.agent === 'off' && u.agent_access) return false;
    if (q.locked && !u.locked) return false;
    if (!s) return true;
    return (u.name + ' ' + u.username + ' ' + u.email + ' ' + u.company).toLowerCase().includes(s);
  });
}

function paintUsersTab(host, role, users) {
  const q = { search: '', active: '', agent: '', locked: false };
  const rows = users.filter(u => u.role === 'user');
  const tableHost = el('div', {});

  const repaint = () => {
    tableHost.textContent = '';
    tableHost.append(userTable(filterUsers(rows, q), { allowRole: role === 'super_admin' }));
  };

  host.append(
    el('div', { class: 'row-between', style: 'margin-bottom:14px;flex-wrap:wrap;gap:10px' },
      el('div', { class: 'adm-toolbar', style: 'margin:0' },
        el('input', { type: 'search', placeholder: 'Search name, username, email…', oninput: debounce_(e => { q.search = e.target.value; repaint(); }, 200) }),
        el('select', { onchange: e => { q.active = e.target.value; repaint(); } },
          el('option', { value: '' }, 'All statuses'), el('option', { value: 'active' }, 'Active'), el('option', { value: 'inactive' }, 'Inactive')),
        el('select', { onchange: e => { q.agent = e.target.value; repaint(); } },
          el('option', { value: '' }, 'Agent Merch: any'), el('option', { value: 'on' }, 'Has access'), el('option', { value: 'off' }, 'No access')),
        el('label', { class: 'rail-check' },
          el('input', { type: 'checkbox', onchange: e => { q.locked = e.target.checked; repaint(); } }), el('span', {}, 'Locked only'))),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-sm btn-ghost', onclick: importUsersDrawer }, 'Import list'),
        el('button', { class: 'btn btn-sm', onclick: () => addUserDrawer(role === 'super_admin') }, 'Add user'))),
    tableHost);
  repaint();
}

function paintAdminsTab(host, users) {
  const rows = users.filter(u => u.role === 'admin' || u.role === 'super_admin');
  host.append(
    el('div', { class: 'small muted', style: 'margin-bottom:14px' },
      'Account managers who can manage users, plus super admins. Only a super admin can promote, demote, or sign out an admin.'),
    userTable(rows, { allowRole: true, superAdmin: true }));
}

function paintAuditTab(host) {
  const q = { actor: '', action: '', offset: 0 };
  const listHost = el('div', {});

  const load = async () => {
    listHost.textContent = 'Loading…';
    try {
      const r = await api('admin_audit', { actor: q.actor, action: q.action, offset: q.offset, limit: 50 });
      listHost.textContent = '';
      if (!r.rows.length) { listHost.append(el('div', { class: 'adm-empty' }, 'No matching audit rows.')); return; }
      listHost.append(
        el('div', { class: 'adm-table-wrap' },
          el('table', { class: 'adm-table' },
            el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Actor'), el('th', {}, 'Role'),
              el('th', {}, 'Action'), el('th', {}, 'Target'), el('th', {}, 'Detail'))),
            el('tbody', {}, r.rows.map(row => el('tr', {},
              el('td', { class: 'small' }, row.timestamp),
              el('td', {}, row.actor), el('td', {}, row.actor_role),
              el('td', {}, row.action), el('td', {}, row.target),
              el('td', { class: 'small muted' }, row.detail)))))),
        el('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end' },
          el('button', { class: 'btn btn-ghost btn-sm', disabled: q.offset === 0 ? 'disabled' : null,
            onclick: () => { q.offset = Math.max(0, q.offset - 50); load(); } }, 'Newer'),
          el('button', { class: 'btn btn-ghost btn-sm', disabled: q.offset + 50 >= r.total ? 'disabled' : null,
            onclick: () => { q.offset += 50; load(); } }, 'Older')));
    } catch (err) {
      listHost.textContent = '';
      listHost.append(el('div', { class: 'adm-empty' }, err.message));
    }
  };

  host.append(
    el('div', { class: 'adm-toolbar' },
      el('input', { type: 'search', placeholder: 'Filter by actor username', oninput: debounce_(e => { q.actor = e.target.value; q.offset = 0; load(); }, 250) }),
      el('input', { type: 'text', placeholder: 'Filter by action, e.g. user_deactivated', oninput: debounce_(e => { q.action = e.target.value; q.offset = 0; load(); }, 250) })),
    listHost);
  load();
}

/* ------------------------------------------------------------------ shell */

async function paintAdminBody() {
  const host = document.getElementById('adminBody');
  if (!host) return;
  host.textContent = '';
  const role = Auth.role();

  try {
    const users = await Admin.load();
    if (Admin.tab === 'users') paintUsersTab(host, role, users);
    else if (Admin.tab === 'admins' && role === 'super_admin') paintAdminsTab(host, users);
    else if (Admin.tab === 'audit' && role === 'super_admin') paintAuditTab(host);
    else { Admin.tab = 'users'; paintUsersTab(host, role, users); }
  } catch (err) {
    host.append(el('div', { class: 'adm-empty' }, err.message || 'Unable to load the admin portal.'));
  }
}

function paintAdminTabs() {
  const bar = document.getElementById('adminTabs');
  if (!bar) return;
  bar.textContent = '';
  const role = Auth.role();
  const tabs = [['users', 'Users']];
  if (role === 'super_admin') { tabs.push(['admins', 'Admins'], ['audit', 'Audit']); }
  bar.append(...tabs.map(([id, label]) => el('button', {
    class: 'adm-tab' + (Admin.tab === id ? ' on' : ''), type: 'button',
    onclick: () => { Admin.tab = id; paintAdminTabs(); paintAdminBody(); },
  }, label)));
}

async function mountAdmin() {
  mount('Admin');
  paintAdminTabs();
  await paintAdminBody();
}
