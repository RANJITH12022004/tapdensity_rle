#!/usr/bin/env node
/**
 * Reproduce Audit Trails button visibility bug after login swap.
 * Simulates initAuditReportsVisibility() one-way hide behavior from script.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const rbacSrc = fs.readFileSync(path.join(root, 'rbac.js'), 'utf8');

function makeContext(user) {
  const ctx = {
    window: { currentUser: user },
    console,
    getCurrentRole: () => (user && user.role ? String(user.role).toLowerCase() : ''),
  };
  ctx.window.currentUser = user;
  vm.createContext(ctx);
  vm.runInContext(rbacSrc, ctx);
  return ctx;
}

function initAuditReportsVisibility(ctx, auditBtn) {
  const canViewAuditLog = () => {
    const role = ctx.getCurrentRole();
    if (role === 'factory') return true;
    const u = ctx.window.currentUser;
    if (u && typeof ctx.userHasInternalKey === 'function') {
      return ctx.userHasInternalKey(u, 'audit-view');
    }
    return false;
  };
  if (auditBtn) {
    auditBtn.style.display = canViewAuditLog() ? '' : 'none';
  }
}

const auditUser = {
  username: 'Rahul',
  role: 'User',
  featureOverrides: {
    allow: ['perm_audit_view', 'perm_reports_view'],
    deny: [],
  },
};

const noAuditUser = {
  username: 'noaudit',
  role: 'User',
  featureOverrides: {
    allow: ['perm_reports_view'],
    deny: [],
  },
};

const auditBtn = { style: { display: '' } };

function step(label, user) {
  const ctx = makeContext(user);
  const has = ctx.userHasInternalKey(user, 'audit-view');
  initAuditReportsVisibility(ctx, auditBtn);
  console.log(`${label}`);
  console.log(`  user: ${user.username} | audit-view permission: ${has}`);
  console.log(`  button display after initAuditReportsVisibility: "${auditBtn.style.display || '(default/visible)'}"`);
  console.log('');
}

console.log('=== Audit Trails button reproduction (current script.js logic) ===\n');

step('1. Login Rahul (has audit access)', auditUser);
step('2. Logout Rahul, login noaudit, open Reports (no audit)', noAuditUser);
step('3. Logout noaudit, login Rahul again (has audit)', auditUser);

if (auditBtn.style.display === 'none') {
  console.log('BUG CONFIRMED: Audit Trails button stays hidden for Rahul after step 3.');
  process.exit(1);
}
console.log('Button visible — bug not reproduced.');
process.exit(0);
