/**
 * rbac.js - Role-Based Access Control for Tap Density
 */

var ROLE_RESTRICTIONS = {
  admin: {
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',
    'disable-recipes': 'full-access',
  },
  supervisor: {
    'user-manage': 'view-only',
    'user-add': 'no-access',
    'user-delete': 'no-access',
    'user-unlock': 'no-access',
    'user-enable': 'no-access',
    'user-change-role': 'no-access',
    'factory-settings': 'view-only',
    'factory-reset': 'no-access',
    'edit-datetime': 'no-access',
    'reports-delete': 'no-access',
    'recipe-delete': 'no-access',
  },
  user: {
    'user-manage': 'no-access',
    'user-add': 'no-access',
    'user-delete': 'no-access',
    'user-unlock': 'no-access',
    'user-enable': 'no-access',
    'user-change-role': 'no-access',
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',
    'edit-datetime': 'no-access',
    'recipe-edit': 'no-access',
    'recipe-delete': 'no-access',
    'reports-delete': 'no-access',
    'validate-menu': 'no-access',
    'disable-recipes': 'no-access',
  },
  factory: {},
};

var SCREEN_FEATURE_MAP = {
  'login': 'login',
  'home': 'dashboard',
  'quick-test': 'quick-test',
  'test-run': 'dashboard',
  'manage-recipes': 'recipe-list',
  'create-recipe-step1': 'recipe-edit',
  'create-recipe-step2': 'recipe-edit',
  'create-recipe-step3': 'recipe-edit',
  'reports': 'reports-view',
  'report-preview': 'reports-view',
  'view-recipes': 'recipe-list',
  'recipe-print-preview': 'reports-view',
  'validate': 'validate-menu',
  'validate-type-select': 'validate-menu',
  'load-validation': 'validate-menu',
  'distance-validation': 'validate-menu',
  'validation-run': 'validate-menu',
  'calibration-type-select': 'validate-menu',
  'load-calibration': 'validate-menu',
  'distance-zero-calibration': 'validate-menu',
  'settings': 'settings',
  'factory-settings': 'factory-settings',
  'datetime': 'edit-datetime',
  'user-profile': 'profile',
  'manage-members': 'user-manage',
  'add-member': 'user-add',
  'locked-members': 'user-manage',
  'disabled-members': 'user-manage',
};

var ACTION_FEATURE_MAP = {
  'add-member': 'user-add',
  'delete-member': 'user-delete',
  'unlock-member': 'user-unlock',
  'enable-member': 'user-enable',
  'change-role': 'user-change-role',
  'save-factory-settings': 'factory-settings',
  'save-recipe': 'recipe-edit',
  'delete-recipe': 'recipe-delete',
  'edit-recipe': 'recipe-edit',
  'start-validation': 'validate-menu',
  'delete-report': 'reports-delete',
  'save-profile': 'profile',
};

var FEATURE_CATALOG = [
  { key: 'quick-test', label: 'Quick Test', description: 'Access quick test workflow', group: 'Testing' },
  { key: 'recipe-list', label: 'View Recipes', description: 'Browse recipe list and details', group: 'Recipe' },
  { key: 'recipe-edit', label: 'Create/Edit Recipes', description: 'Create or modify recipes', group: 'Recipe' },
  { key: 'recipe-delete', label: 'Disable Recipes', description: 'Disable recipes', group: 'Recipe' },
  { key: 'reports-view', label: 'View Reports', description: 'Open test and report history', group: 'Reports' },
  { key: 'validate-menu', label: 'Validation & Calibration', description: 'Run validation/calibration flows', group: 'Hardware' },
  { key: 'settings', label: 'Settings', description: 'Open settings area', group: 'Settings' },
  { key: 'edit-datetime', label: 'Date/Time Edit', description: 'Edit system date/time and RTC', group: 'Settings' },
  { key: 'profile', label: 'User Profile', description: 'Access user profile page', group: 'General' },
  { key: 'user-manage', label: 'Manage Members', description: 'View member management screens', group: 'Users' },
  { key: 'user-add', label: 'Add Member', description: 'Create new users and operators', group: 'Users' },
  { key: 'user-delete', label: 'Disable Member', description: 'Disable member accounts', group: 'Users' },
  { key: 'user-unlock', label: 'Unlock Member', description: 'Unlock locked user accounts', group: 'Users' },
  { key: 'user-enable', label: 'Enable Member', description: 'Enable disabled user accounts', group: 'Users' },
  { key: 'user-change-role', label: 'Change Role', description: 'Change user role assignment', group: 'Users' },
  { key: 'disable-recipes', label: 'Disable Recipes Tool', description: 'Access disable recipes utility', group: 'Recipe' }
];

var currentUser = null;

function getCurrentRole() {
  var role = null;
  if (window.currentUser && window.currentUser.role) role = window.currentUser.role;
  else if (currentUser && currentUser.role) role = currentUser.role;
  return role ? String(role).toLowerCase() : null;
}

function getFeatureCatalog() {
  return FEATURE_CATALOG.slice();
}

function getKnownFeatureKeys() {
  return FEATURE_CATALOG.map(function (f) { return f.key; });
}

function getRestriction(role, featureKey) {
  if (!role || !featureKey) return null;
  var roleRules = ROLE_RESTRICTIONS[String(role).toLowerCase()] || {};
  return roleRules[featureKey] || null;
}

function normalizeFeatureOverrides(overrides) {
  var known = getKnownFeatureKeys();
  var out = { allow: [], deny: [] };
  if (!overrides || typeof overrides !== 'object') return out;
  if (Array.isArray(overrides.allow)) {
    overrides.allow.forEach(function (k) {
      var key = String(k || '').trim();
      if (key && known.indexOf(key) !== -1 && out.allow.indexOf(key) === -1) out.allow.push(key);
    });
  }
  if (Array.isArray(overrides.deny)) {
    overrides.deny.forEach(function (k) {
      var key = String(k || '').trim();
      if (key && known.indexOf(key) !== -1 && out.deny.indexOf(key) === -1) out.deny.push(key);
    });
  }
  out.allow = out.allow.filter(function (k) { return out.deny.indexOf(k) === -1; });
  return out;
}

function _getUserObjectFromInput(roleOrUser) {
  if (roleOrUser && typeof roleOrUser === 'object') return roleOrUser;
  if (window.currentUser && typeof window.currentUser === 'object') return window.currentUser;
  return null;
}

function _getRoleFromInput(roleOrUser) {
  if (roleOrUser && typeof roleOrUser === 'object' && roleOrUser.role) return String(roleOrUser.role).toLowerCase();
  if (roleOrUser && typeof roleOrUser === 'string') return String(roleOrUser).toLowerCase();
  return getCurrentRole();
}

function getEffectiveRestriction(roleOrUser, featureKey) {
  if (!featureKey) return 'no-access';
  var role = _getRoleFromInput(roleOrUser);
  if (!role) return 'no-access';
  if (featureKey === 'dashboard') return 'full-access';
  if (featureKey === 'factory-settings' || featureKey === 'factory-reset') {
    return role === 'factory' ? 'full-access' : 'no-access';
  }
  var base = getRestriction(role, featureKey);
  var userObj = _getUserObjectFromInput(roleOrUser);
  var overrides = normalizeFeatureOverrides(userObj && userObj.featureOverrides ? userObj.featureOverrides : null);
  if (overrides.deny.indexOf(featureKey) !== -1) return 'no-access';
  if (overrides.allow.indexOf(featureKey) !== -1) return 'full-access';
  return base;
}

function canAccess(roleOrUser, featureKey) {
  var restriction = getEffectiveRestriction(roleOrUser, featureKey);
  return restriction !== 'no-access';
}

function isViewOnly(roleOrUser, featureKey) {
  return getEffectiveRestriction(roleOrUser, featureKey) === 'view-only';
}

function canPerformAction(roleOrUser, featureKey, action) {
  var restriction = getEffectiveRestriction(roleOrUser, featureKey);
  if (restriction === 'no-access') return false;
  if (restriction === 'view-only') {
    var editActions = ['edit', 'delete', 'create', 'save', 'change', 'calibrate', 'start', 'enable', 'unlock'];
    return editActions.indexOf(String(action || '').toLowerCase()) === -1;
  }
  return true;
}

function isProtectedFactoryUser(user) {
  if (!user) return false;
  var username = (user.username || user.user || '').toString().toUpperCase();
  return username === 'RLERLT';
}

function checkNavigationAccess(screenId) {
  if (screenId === 'login') return true;
  var role = getCurrentRole();
  if (!role) return false;
  var featureKey = SCREEN_FEATURE_MAP[screenId] || screenId;
  return canAccess(window.currentUser || role, featureKey);
}
