// Tap Density - navigation + API
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});

var API_BASE = '';
var currentReportFilter = null;
var membersCache = [];
var FACTORY_USERNAME = 'RLERLT';
var currentMemberIdForRoleEdit = null;
var appModalResolve = null;
var lastValidationType = 'distance'; // 'distance' = USP 1, 'load' = USP 2
var validationRunState = 'idle'; // 'idle' | 'running'
var validationRunIntervalId = null;
var validationRunCurrentCount = 0;
var validationRunExpected = 300;
var validationRunTarget = 300;
var validationRunTolerance = 50;
var validationRunMin = 250;
var validationRunMax = 350;
var validationRunBackendPending = false;
var validationHardwareEnabled = false; // temporarily disable backend hardware validation commands
var validationCompletion = { distance: false, load: false }; // distance=USP 1, load=USP 2
var biometricEnabledSetting = true;
var currentReportId = null;
var currentReportData = null;
var currentRecipeForPrint = null;
var lastKnownDateTime = null;
var dateTimeClockInterval = null;
var lastDisplayedRecipes = [];
var pendingRecipeToLoad = null;
var recipeListMode = 'manage'; // 'manage' | 'load'
var approvalVerifyResolve = null;
var approvalVerifyReject = null;
var adminApprovalVerifyResolve = null;
var adminApprovalVerifyReject = null;
var _approvalVerifyModalOriginal = null;
var _approvalVerifyButtonOriginal = null;
var _approvalVerifyEmptyCredentialsMessage = 'Enter QA username and password.';
var _approvalVerifyPurpose = 'recipe';
var _suppressTestRunNavGuardOnce = false;

/** Display label: Supervisor role shown as Reviewer (stored value unchanged). */
function displayRoleLabel(role) {
    var r = String(role || '').trim();
    if (String(r).toLowerCase() === 'supervisor') return 'Reviewer';
    return r || '--';
}

/** Approved-by line may contain "(supervisor)" from stored reports — show as Reviewer. */
function formatApprovedByLine(line) {
    var s = String(line || '').trim();
    if (!s || s === '--') return '--';
    return s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
}

function getActivePageName() {
    var active = document.querySelector('.page.active');
    if (!active || !active.id) return '';
    return active.id.indexOf('page-') === 0 ? active.id.slice(5) : active.id;
}

function isEditableTarget(el) {
    if (!el) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (el.isContentEditable) return true;
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = String(el.type || 'text').toLowerCase();
    return t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'reset';
}

function isTestRunActive() {
    return getActivePageName() === 'test-run' && testRunButtonState === 'abort';
}

function isValidationRunActive() {
    return getActivePageName() === 'validation-run' && validationRunState === 'running';
}

function isValidationPartiallyCompleted() {
    return !!(validationCompletion.distance || validationCompletion.load);
}

function isValidationFullyCompleted() {
    return !!(validationCompletion.distance && validationCompletion.load);
}

function getMissingValidationLabel() {
    if (!validationCompletion.distance) return 'USP 1';
    if (!validationCompletion.load) return 'USP 2';
    return '';
}

function stopActiveRunForLogout() {
    // Abort active test-run simulation before logout.
    if (testRunButtonState === 'abort') {
        if (testRunIntervalId != null) {
            clearInterval(testRunIntervalId);
            testRunIntervalId = null;
        }
        testRunButtonState = 'start';
        var testBtn = document.getElementById('btn-test-start-abort');
        if (testBtn) {
            testBtn.className = 'btn-ctrl start';
            testBtn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
            testBtn.classList.remove('danger');
        }
        var statusText = document.getElementById('run-status-text');
        var statusSubtext = document.getElementById('run-status-subtext');
        if (statusText) statusText.textContent = 'Aborted';
        if (statusSubtext) statusSubtext.textContent = 'Test stopped';
    }

    // Abort active validation hardware run before logout.
    if (validationRunState === 'running' || validationRunBackendPending) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        return stopValidationOnBackend().catch(function () {}).finally(function () {
            validationRunState = 'idle';
            validationRunBackendPending = false;
        });
    }
    return Promise.resolve();
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    if (isEditableTarget(e.target)) return;
    if (isTestRunActive() || isValidationRunActive()) {
        e.preventDefault();
    }
}, true);

function closeAppModal() {
    var overlay = document.getElementById('app-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (appModalResolve) {
        appModalResolve(false);
        appModalResolve = null;
    }
}

function showAppModal(message, title, onClose) {
    var overlay = document.getElementById('app-modal-overlay');
    var titleEl = document.getElementById('app-modal-title');
    var msgEl = document.getElementById('app-modal-message');
    var buttonsEl = document.getElementById('app-modal-buttons');
    if (!overlay || !titleEl || !msgEl || !buttonsEl) {
        window.alert(message);
        if (typeof onClose === 'function') onClose();
        return;
    }
    titleEl.textContent = title || 'Message';
    msgEl.textContent = message || '';
    buttonsEl.innerHTML = '';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-role-select btn-role-user';
    okBtn.textContent = 'OK';
    okBtn.onclick = function () {
        if (appModalResolve) {
            appModalResolve(true);
            appModalResolve = null;
        }
        overlay.style.display = 'none';
        if (typeof onClose === 'function') onClose();
    };
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
}

function showConfirmModal(message, title) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var ok = window.confirm(message);
            resolve(ok);
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-confirm-ok';
        var t = String(title || '').trim().toLowerCase();
        okBtn.textContent = (t === 'test running') ? 'Abort Test' : (t === 'operation in progress') ? 'Abort' : 'OK';
        okBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(cancelBtn);
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
    });
}

function updateProfileFromCurrentUser(user) {
    if (!user) return;
    var name = user.name || user.username || '';
    var role = user.role || '';
    var nameEl = document.getElementById('profile-name-display');
    if (nameEl) {
        nameEl.textContent = name || '---';
    }
    var roleEl = document.getElementById('profile-role-display');
    if (roleEl) {
        roleEl.textContent = displayRoleLabel(role);
    }
    var fullNameInput = document.getElementById('profile-fullname');
    if (fullNameInput && name) {
        fullNameInput.value = name;
    }
}

function apiRequest(path, options) {
    options = options || {};
    var base = API_BASE || '';
    var p = String(path || '');
    if (base && p.indexOf(base) === 0) {
        p = p.slice(base.length);
        if (p.charAt(0) !== '/') p = '/' + p;
    }
    var url = base + p;
    var headers = { 'Content-Type': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        var hdrRole = window.currentUser.role;
        if (!hdrRole && typeof getCurrentRole === 'function') {
            var gr = getCurrentRole();
            if (gr) hdrRole = gr;
        }
        if (hdrRole) headers['X-User-Role'] = hdrRole;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    if (options.headers) for (var h in options.headers) headers[h] = options.headers[h];
    var opts = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    return fetch(url, opts).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
            if (ct.indexOf('json') !== -1) {
                return r.json().then(function (data) {
                    var msg = (data && (data.error || data.message)) ? String(data.error || data.message) : (r.statusText || r.status);
                    throw new Error(msg);
                }).catch(function (err) {
                    throw err instanceof Error ? err : new Error(r.statusText || r.status);
                });
            }
            return r.text().then(function (text) {
                throw new Error(text || r.statusText || r.status);
            }).catch(function () {
                throw new Error(r.statusText || r.status);
            });
        }
        if (ct.indexOf('json') !== -1) return r.json();
        return r.text();
    });
}

var _approvalVerifyReturnPage = 'home';

function openApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        if (!els) {
            reject(new Error('QA verification UI is missing.'));
            return;
        }
        approvalVerifyResolve = resolve;
        approvalVerifyReject = reject;
        _storeApprovalVerifyModalOriginalUiOnce();
        _restoreApprovalVerifyModalOriginalUi();
        _setApprovalVerifyModalButtonHandlers(submitApprovalVerifyModal, cancelApprovalVerifyModal);
        var o = options == null ? {} : options;
        _approvalVerifyPurpose = o.purpose || 'recipe';
        if (o.titleText && els.titleEl) els.titleEl.textContent = o.titleText;
        if (o.subtitleText && els.subtitleEl) els.subtitleEl.textContent = o.subtitleText;
        if (o.usernameLabelText && els.usernameLabelEl) els.usernameLabelEl.textContent = o.usernameLabelText;
        if (o.usernamePlaceholder && els.usernameEl) els.usernameEl.setAttribute('placeholder', o.usernamePlaceholder);
        _approvalVerifyEmptyCredentialsMessage = o.emptyCredentialsMessage || 'Enter QA username and password.';
        if (els.errEl) {
            els.errEl.textContent = '';
            els.errEl.style.display = 'none';
        }
        els.usernameEl.value = '';
        els.passwordEl.value = '';
        if (!els.passwordEl._approvalVerifyEnterHandler) {
            els.passwordEl._approvalVerifyEnterHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (adminApprovalVerifyResolve) submitAdminApprovalVerifyModal();
                    else submitApprovalVerifyModal();
                }
            };
            els.passwordEl.addEventListener('keydown', els.passwordEl._approvalVerifyEnterHandler);
        }
        setTimeout(function () { els.usernameEl.focus(); }, 30);
    });
}

function closeApprovalVerifyModal() {
    if (typeof goToPage === 'function') goToPage(_approvalVerifyReturnPage || 'home');
}

function cancelApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (approvalVerifyResolve) {
        approvalVerifyResolve(null);
        approvalVerifyResolve = null;
    }
    if (approvalVerifyReject) approvalVerifyReject = null;
}

function submitApprovalVerifyModal() {
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        if (errEl) {
            errEl.textContent = _approvalVerifyEmptyCredentialsMessage;
            errEl.style.display = 'block';
        }
        return;
    }
    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: _approvalVerifyPurpose }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            if (errEl) {
                errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(data.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    }).catch(function (err) {
        if (errEl) {
            errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
            errEl.style.display = 'block';
        }
    });
}

function submitApprovalVerifyBiometricModal() {
    var errEl = document.getElementById('approval-verify-error');
    if (!biometricEnabledSetting) {
        if (errEl) {
            errEl.textContent = 'Biometric verification is disabled by Factory Settings.';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    showBiometricProgressOverlay('Verify Fingerprint', 'Place an Admin/QA fingerprint on the scanner to authorize this action.');
    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'biometric', purpose: _approvalVerifyPurpose }
    }).then(function (data) {
        hideBiometricProgressOverlay();
        if (!data || !data.ok || !data.token) {
            if (errEl) {
                errEl.textContent = (data && data.error) ? String(data.error) : 'Fingerprint verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(data.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    }).catch(function (err) {
        hideBiometricProgressOverlay();
        if (errEl) {
            errEl.textContent = 'Fingerprint verification failed: ' + (err && err.message ? err.message : 'Error');
            errEl.style.display = 'block';
        }
    });
}

function _getApprovalVerifyModalElements() {
    var overlay = document.getElementById('page-approval-verify');
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    if (!overlay || !usernameEl || !passwordEl || !errEl) return null;
    var usernameLabelEl = overlay.querySelector('label[for="approval-verify-username"]');
    var userBtn = overlay.querySelector('.btn-role-user');
    var cancelBtn = overlay.querySelector('.btn-role-cancel');
    var titleEl = overlay.querySelector('h3');
    var subtitleEl = overlay.querySelector('p.section-subtitle');
    return { overlay: overlay, usernameEl: usernameEl, passwordEl: passwordEl, errEl: errEl, usernameLabelEl: usernameLabelEl, userBtn: userBtn, cancelBtn: cancelBtn, titleEl: titleEl, subtitleEl: subtitleEl };
}

function _storeApprovalVerifyModalOriginalUiOnce() {
    if (_approvalVerifyModalOriginal) return;
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    _approvalVerifyModalOriginal = {
        titleText: els.titleEl ? els.titleEl.textContent : null,
        subtitleText: els.subtitleEl ? els.subtitleEl.textContent : null,
        usernameLabelText: els.usernameLabelEl ? els.usernameLabelEl.textContent : null,
        usernamePlaceholder: els.usernameEl ? els.usernameEl.getAttribute('placeholder') : null
    };
    _approvalVerifyButtonOriginal = {
        userBtnOnclick: els.userBtn ? els.userBtn.onclick : null,
        cancelBtnOnclick: els.cancelBtn ? els.cancelBtn.onclick : null
    };
}

function _restoreApprovalVerifyModalOriginalUi() {
    var els = _getApprovalVerifyModalElements();
    if (!els || !_approvalVerifyModalOriginal) return;
    if (els.titleEl && _approvalVerifyModalOriginal.titleText != null) els.titleEl.textContent = _approvalVerifyModalOriginal.titleText;
    if (els.subtitleEl && _approvalVerifyModalOriginal.subtitleText != null) els.subtitleEl.textContent = _approvalVerifyModalOriginal.subtitleText;
    if (els.usernameLabelEl && _approvalVerifyModalOriginal.usernameLabelText != null) els.usernameLabelEl.textContent = _approvalVerifyModalOriginal.usernameLabelText;
    if (els.usernameEl && _approvalVerifyModalOriginal.usernamePlaceholder != null) els.usernameEl.setAttribute('placeholder', _approvalVerifyModalOriginal.usernamePlaceholder);
    if (_approvalVerifyButtonOriginal) {
        if (els.userBtn) els.userBtn.onclick = _approvalVerifyButtonOriginal.userBtnOnclick;
        if (els.cancelBtn) els.cancelBtn.onclick = _approvalVerifyButtonOriginal.cancelBtnOnclick;
    }
}

function _setApprovalVerifyModalButtonHandlers(verifyFn, cancelFn) {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    if (els.userBtn) els.userBtn.onclick = verifyFn;
    if (els.cancelBtn) els.cancelBtn.onclick = cancelFn;
}

function _normUserKey(v) {
    return String(v || '').trim().toLowerCase();
}

// Admin-only verification modal for starting a test run.
function openAdminApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        var opts = options || {};
        if (!els) {
            reject(new Error('Admin verification UI is missing.'));
            return;
        }

        _storeApprovalVerifyModalOriginalUiOnce();
        adminApprovalVerifyResolve = resolve;
        adminApprovalVerifyReject = reject;

        els.errEl.textContent = '';
        els.errEl.style.display = 'none';
        els.usernameEl.value = '';
        els.passwordEl.value = '';

        if (els.titleEl) els.titleEl.textContent = opts.titleText || 'Admin approval required';
        if (els.subtitleEl) els.subtitleEl.textContent = opts.subtitleText || 'Enter admin credentials to continue.';
        if (els.usernameLabelEl) els.usernameLabelEl.textContent = 'Admin username';
        if (els.usernameEl) els.usernameEl.setAttribute('placeholder', 'Enter admin username');

        _setApprovalVerifyModalButtonHandlers(submitAdminApprovalVerifyModal, cancelAdminApprovalVerifyModal);

        setTimeout(function () { els.usernameEl.focus(); }, 30);
    });
}

function cancelAdminApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (adminApprovalVerifyResolve) {
        adminApprovalVerifyResolve(null);
        adminApprovalVerifyResolve = null;
    }
    if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
}

function submitAdminApprovalVerifyModal() {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;

    var username = els.usernameEl ? String(els.usernameEl.value || '').trim() : '';
    var password = els.passwordEl ? String(els.passwordEl.value || '') : '';

    if (!username || !password) {
        els.errEl.textContent = 'Enter admin username and password.';
        els.errEl.style.display = 'block';
        return;
    }

    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: 'recipe' }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            els.errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
            els.errEl.style.display = 'block';
            return;
        }

        var role = (data.verifier && data.verifier.role) ? String(data.verifier.role) : '';
        role = String(role).trim().toLowerCase();
        if (role !== 'admin') {
            els.errEl.textContent = 'Admin credentials are required.';
            els.errEl.style.display = 'block';
            return;
        }

        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (adminApprovalVerifyResolve) {
            adminApprovalVerifyResolve({
                token: String(data.token),
                username: _normUserKey(data.verifier && data.verifier.username),
                role: role
            });
            adminApprovalVerifyResolve = null;
        }
        if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
    }).catch(function (err) {
        els.errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
        els.errEl.style.display = 'block';
    });
}

function distributeTotalTaps(total, stepCount) {
    var t = parseInt(total, 10);
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    if (isNaN(t) || t < n) return null;
    var base = Math.floor(t / n);
    var rem = t - base * n;
    var arr = [];
    for (var i = 0; i < n; i++) {
        arr.push(base + (i < rem ? 1 : 0));
    }
    return arr;
}

function computeStandardUspTaps(stepCount) {
    var taps = [];
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    for (var i = 0; i < n; i++) {
        taps.push(i === 0 ? 10 : (i === 1 ? 500 : 1250));
    }
    return taps;
}

function computeCreateRecipeStepTapsForStepCount(stepCount) {
    var mode = getCreateUspMode();
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var total = totalEl ? parseInt(totalEl.value, 10) : 0;
        return distributeTotalTaps(total, stepCount);
    }
    return computeStandardUspTaps(stepCount);
}

function refreshActiveQaCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'qa') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeQaCount = n;
    }).catch(function () { window._activeQaCount = 0; });
}

function refreshActiveSupervisorCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'supervisor') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeSupervisorCount = n;
    }).catch(function () { window._activeSupervisorCount = 0; });
}

function userCanApproveByQaRule() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function' && !userHasInternalKey(u, 'recipe-approve')) {
        return false;
    }
    var hasQa = typeof window._activeQaCount === 'number' ? window._activeQaCount >= 1 : false;
    if (hasQa) return role === 'qa';
    return role === 'admin';
}

/** Test reports: must have test-report-approve permission (Factory bypass in UI). */
function userCanApproveTestReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'test-report-approve');
    }
    return false;
}

function userCanApproveValidationReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'validation-report-approve');
    }
    return false;
}

/** Recipe approval modal copy; server allows QA only when QA exists, else Admin only. */
function _approvalVerifyModalOptionsForRecipe() {
    var hasQa = typeof window._activeQaCount === 'number' && window._activeQaCount >= 1;
    if (hasQa) return { purpose: 'recipe' };
    return {
        purpose: 'recipe',
        titleText: 'Admin approval required',
        subtitleText: 'No active QA users. An admin must verify to continue.',
        usernameLabelText: 'Admin username',
        usernamePlaceholder: 'Enter admin username',
        emptyCredentialsMessage: 'Enter admin username and password.'
    };
}

/** Test report approval: Reviewer (Supervisor) or Admin verifier; not QA. */
function _approvalVerifyModalOptionsForReport() {
    return {
        purpose: 'report',
        titleText: 'Test report approval',
        subtitleText: 'Enter Reviewer or Admin credentials to approve this test.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Reviewer or Admin username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

function getEffectiveRecipeApprovalStatus(recipe) {
    if (!recipe) return 'approved';
    var st = recipe.recipeApprovalStatus;
    if (st == null || st === '') return 'approved';
    return st;
}

function getCreateUspMode() {
    var r = document.querySelector('input[name="create-usp-mode"]:checked');
    return r ? String(r.value).toUpperCase() : 'USP1';
}

function getQuickUspMode() {
    var r = document.querySelector('input[name="quick-usp-mode"]:checked');
    return r ? String(r.value).toUpperCase() : 'USP1';
}

function applyCreateUspModeToSpeedHeight() {
    var mode = getCreateUspMode();
    var speedWrap = document.getElementById('create-custom-speed-height-wrap');
    if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var totalWrap = document.getElementById('create-custom-total-wrap');
    if (totalWrap) totalWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    if (mode === 'USP1') {
        var s1 = document.querySelector('input[name="create-speed"][value="300"]');
        var h1 = document.querySelector('input[name="create-height"][value="14"]');
        if (s1) s1.checked = true;
        if (h1) h1.checked = true;
    } else if (mode === 'USP2') {
        var s2 = document.querySelector('input[name="create-speed"][value="250"]');
        var h2 = document.querySelector('input[name="create-height"][value="3"]');
        if (s2) s2.checked = true;
        if (h2) h2.checked = true;
    }
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function applyQuickUspModeToSpeedHeight() {
    var mode = getQuickUspMode();
    var speedWrap = document.getElementById('quick-custom-speed-height-wrap');
    if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var totalWrap = document.getElementById('quick-custom-total-wrap');
    if (totalWrap) totalWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    if (mode === 'USP1') {
        var s1 = document.querySelector('input[name="quick-speed"][value="300"]');
        var h1 = document.querySelector('input[name="quick-height"][value="14"]');
        if (s1) s1.checked = true;
        if (h1) h1.checked = true;
    } else if (mode === 'USP2') {
        var s2 = document.querySelector('input[name="quick-speed"][value="250"]');
        var h2 = document.querySelector('input[name="quick-height"][value="3"]');
        if (s2) s2.checked = true;
        if (h2) h2.checked = true;
    }
}

var PAGE_TITLES = {
    'home': 'Tap Density Apparatus',
    'quick-test': 'Quick Test',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Configure Steps',
    'create-recipe-step3': 'Cylinder Size',
    'manage-recipes': null,
    'manage-members': 'Manage Profiles',
    'load-validation': 'USP 2',
    'distance-validation': 'USP 1',
    'add-member': 'Add New Member',
    'validate': 'Validation',
    'validate-type-select': 'Select Validation Type',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    'settings': 'Settings',
    'datetime': 'Date and Time',
    'factory-settings': 'Factory Settings',
    'reports': 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'USP 1',
    'usp2-detail': 'USP 2',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test'
};

async function fetchDateTimeFromBackend() {
    try {
        var r = await fetch((API_BASE || '') + '/api/get_datetime');
        if (r.ok) {
            var data = await r.json();
            if (data && (data.datetime || data.date)) return data;
        }
    } catch (e) {}
    return null;
}

function updateDateTime() {
    fetchDateTimeFromBackend().then(function (data) {
        var timeString = '--:--:--';
        var dateString = '--/--/----';
        if (data && data.datetime) {
            var dt = new Date(data.datetime.replace('Z', ''));
            if (!isNaN(dt.getTime())) {
                var d = dt.getDate();
                var m = dt.getMonth() + 1;
                var y = dt.getFullYear();
                var h = dt.getHours();
                var min = String(dt.getMinutes()).padStart(2, '0');
                var sec = String(dt.getSeconds()).padStart(2, '0');
                dateString = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
                timeString = String(h).padStart(2, '0') + ':' + min + ':' + sec;
                lastKnownDateTime = { timeString: timeString, dateString: dateString };
            }
        } else if (data && data.date && data.time) {
            dateString = (data.date || '').replace(/-/g, '/');
            timeString = (data.time || '--:--').split(':').slice(0, 2).join(':');
            if (data.time && data.time.split(':').length >= 3) timeString = data.time;
            else timeString = timeString + ':00';
            lastKnownDateTime = { timeString: timeString, dateString: dateString };
        } else if (lastKnownDateTime) {
            timeString = lastKnownDateTime.timeString;
            dateString = lastKnownDateTime.dateString;
        }
        var timeEl = document.getElementById('current-time');
        var dateEl = document.getElementById('current-date');
        if (timeEl) timeEl.textContent = timeString;
        if (dateEl) dateEl.textContent = dateString;
    });
}

function showLoginScreen() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (app) app.style.display = 'none';
    if (login) login.style.display = 'flex';
    if (typeof loadLoginFactorySettingsDisplay === 'function') loadLoginFactorySettingsDisplay();
}

function showAppContainer() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';
    updateDateTime();
    if (!dateTimeClockInterval) {
        dateTimeClockInterval = setInterval(updateDateTime, 1000);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
}

function updateSettingsVisibility() {
    var u = window.currentUser;
    var role = typeof getCurrentRole === 'function' ? getCurrentRole() : '';
    var rl = String(role || '').toLowerCase();
    function showIf(sel, featureKey) {
        var el = document.querySelector(sel);
        if (!el) return;
        var ok = u && typeof canAccess === 'function' ? canAccess(u, featureKey) : false;
        el.style.display = ok ? '' : 'none';
    }
    showIf('.settings-datetime', 'edit-datetime');
    showIf('.settings-recipes', 'recipe-list');
    var disableCard = document.querySelector('.settings-disable');
    if (disableCard) {
        var show =
            (u && typeof canAccess === 'function' && canAccess(u, 'disable-recipes')) ||
            rl === 'factory';
        disableCard.style.display = show ? '' : 'none';
    }
    showIf('.settings-validation', 'validation-test');
    var factoryCard = document.querySelector('.settings-factory');
    if (factoryCard) {
        factoryCard.style.display = rl === 'factory' ? '' : 'none';
    }
    var resetCard = document.querySelector('.settings-reset');
    if (resetCard) {
        resetCard.style.display = rl === 'factory' ? '' : 'none';
    }
}

/** Hide sidebar / home tiles the current user cannot access (RBAC). */
function refreshShellAccessVisibility() {
    var u = window.currentUser;
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        var page = btn.getAttribute('data-page');
        var feat = btn.getAttribute('data-rbac-nav');
        if (!feat && typeof SCREEN_FEATURE_MAP !== 'undefined' && SCREEN_FEATURE_MAP[page]) {
            feat = SCREEN_FEATURE_MAP[page];
        }
        if (!feat) feat = page;
        var ok = true;
        if (page === 'home') {
            ok = true;
        } else if (u && typeof canAccess === 'function') {
            ok = canAccess(u, feat);
        } else if (!u) {
            ok = false;
        }
        btn.style.display = ok ? '' : 'none';
    });
    document.querySelectorAll('.test-card[data-rbac-nav]').forEach(function (el) {
        var feat = el.getAttribute('data-rbac-nav');
        var ok = u && typeof canAccess === 'function' && feat ? canAccess(u, feat) : false;
        el.style.display = ok ? '' : 'none';
    });
    var mp = document.querySelector('.profile-actions button[onclick*="manage-members"]');
    var am = document.querySelector('.profile-actions button[onclick*="openAddMember"]');
    if (mp) mp.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-manage') ? '' : 'none';
    if (am) am.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-add') ? '' : 'none';
    var expBtn = document.querySelector('.reports-filter-export');
    if (expBtn) expBtn.style.display = u && typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb') ? '' : 'none';
    var audEx = document.querySelector('.audit-filter-export');
    if (audEx) audEx.style.display = u && typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb') ? '' : 'none';
    if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
}

function goToPage(pageName) {
    if (!_suppressTestRunNavGuardOnce && isTestRunActive && typeof isTestRunActive === 'function') {
        if (isTestRunActive() && pageName !== 'test-run') {
            showConfirmModal('Test is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                // Abort current test run
                if (typeof toggleTestRunState === 'function' && testRunButtonState === 'abort') {
                    toggleTestRunState();
                }
                // Re-run navigation after abort (guard will no longer apply)
                goToPage(pageName);
            });
            return;
        }
    }
    _suppressTestRunNavGuardOnce = false;
    if (pageName === 'factory-settings') {
        var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
        if (String(role || '').toLowerCase() !== 'factory') {
            showAppModal('Only Factory user can access Factory Settings.', 'Permission');
            pageName = 'settings';
        }
    }
    if (pageName !== 'login' && pageName !== 'password-expired-reset') {
        if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
            showAppModal('Please log in.', 'Session');
            if (typeof showLoginScreen === 'function') showLoginScreen();
            return;
        }
        if (typeof checkNavigationAccess === 'function' && !checkNavigationAccess(pageName)) {
            showAppModal('You do not have permission to open this screen.', 'Permission');
            return;
        }
    }
    document.querySelectorAll('.page').forEach(function (p) {
        p.classList.remove('active');
    });
    var page = document.getElementById('page-' + pageName);
    if (page) {
        page.classList.add('active');
    }
    document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-page') === pageName);
    });
    var sidebarProfile = document.querySelector('.sidebar .user-profile');
    if (sidebarProfile) {
        if (pageName === 'user-profile') sidebarProfile.classList.add('active');
        else sidebarProfile.classList.remove('active');
    }
    var title = document.getElementById('header-title');
    if (title) {
        if (pageName === 'manage-recipes') {
            title.textContent = 'Manage Recipes';
        } else if (PAGE_TITLES[pageName]) {
            title.textContent = PAGE_TITLES[pageName];
        }
    }
    var logoEl = document.getElementById('header-logo');
    var backBtnEl = document.getElementById('header-back-btn');
    if (pageName === 'home') {
        if (logoEl) logoEl.style.display = 'block';
        if (backBtnEl) backBtnEl.style.display = 'none';
    } else {
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'block';
    }
    if (pageName === 'reports' && typeof loadReports === 'function') {
        setTimeout(function () { loadReports(currentReportFilter || null); }, 50);
    }
    if (pageName === 'settings') {
        setTimeout(function () {
            if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
        }, 50);
    }
    if (pageName === 'factory-settings') {
        setTimeout(function () {
            if (typeof initFactorySettings === 'function') initFactorySettings();
        }, 50);
    }
    if (pageName === 'manage-members' || pageName === 'locked-members' || pageName === 'disabled-members') {
        setTimeout(function () {
            if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
        }, 50);
    }
    if (pageName === 'manage-recipes') {
        setTimeout(function () {
            if (typeof loadManageRecipes === 'function') loadManageRecipes();
        }, 50);
    }
    if (pageName === 'validate-type-select') {
        setTimeout(function () {
            // Clear selection when entering the validation type page.
            // This prevents retaining the previous selection.
            lastValidationType = null;
            var r1 = document.querySelector('input[name="val-type"][value="distance"]');
            var r2 = document.querySelector('input[name="val-type"][value="load"]');
            if (r1) r1.checked = false;
            if (r2) r2.checked = false;
        }, 0);
    }
    if (pageName === 'quick-test') {
        setTimeout(function () {
            if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
            if (typeof _refreshQuickStepSummary === 'function') _refreshQuickStepSummary();
        }, 50);
    }
    if (pageName === 'disable-recipes') {
        setTimeout(function () {
            if (typeof loadDisableRecipes === 'function') loadDisableRecipes();
        }, 50);
    }
    if (pageName === 'create-recipe-step1') {
        setTimeout(function () {
            if (!window.currentEditingRecipeId) {
                var nameEl = document.getElementById('recipe-product-name');
                if (nameEl) nameEl.value = '';
                var um = document.querySelector('input[name="create-usp-mode"][value="USP1"]');
                if (um) um.checked = true;
                applyCreateUspModeToSpeedHeight();
                var ct = document.getElementById('create-custom-total-taps');
                if (ct) ct.value = '';
                window._createRecipeStepTaps = null;
                updateCreateRecipeContinueButton();
            } else if (typeof loadRecipeForEdit === 'function') {
                loadRecipeForEdit();
            }
        }, 50);
    }
    if (pageName === 'create-recipe-step2') {
        setTimeout(function () {
            if (typeof renderCreateRecipeStepInputsPage === 'function') renderCreateRecipeStepInputsPage();
        }, 50);
    }
    if (pageName === 'view-recipes') {
        setTimeout(function () {
            if (typeof loadViewRecipes === 'function') loadViewRecipes();
        }, 50);
    }
    if (pageName === 'validation-run') {
        setTimeout(function () {
            if (typeof initValidationRunPage === 'function') initValidationRunPage();
        }, 50);
    }
    if (pageName === 'datetime') {
        setTimeout(function () {
            if (typeof initializeDatetime === 'function') initializeDatetime();
        }, 50);
    }
    if (pageName === 'user-profile') {
        setTimeout(function () {
            var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
            if (typeof updateProfileFromCurrentUser === 'function') updateProfileFromCurrentUser(u);
        }, 50);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
}

function goBack() {
    var activePage = document.querySelector('.page.active');
    var pageId = activePage ? activePage.id : '';
    if (pageId === 'page-quick-test') {
        goToPage('home');
    } else if (pageId === 'page-test-run') {
        if (isTestRunActive && typeof isTestRunActive === 'function' && isTestRunActive()) {
            showConfirmModal('Test is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                if (typeof toggleTestRunState === 'function' && testRunButtonState === 'abort') {
                    toggleTestRunState();
                }
                _suppressTestRunNavGuardOnce = true;
                goToPage('home');
            });
            return;
        }
        goToPage('home');
    } else if (pageId === 'page-create-recipe-step1') {
        goToPage('manage-recipes');
    } else if (pageId === 'page-create-recipe-step2') {
        goToPage('create-recipe-step1');
    } else if (pageId === 'page-create-recipe-step3') {
        goToPage('create-recipe-step2');
    } else if (pageId === 'page-report-preview') {
        goToPage('reports');
    } else if (pageId === 'page-recipe-print-preview') {
        goToPage('view-recipes');
    } else if (pageId === 'page-view-recipes') {
        goToPage('reports');
    } else if (pageId === 'page-factory-settings') {
        goToPage('settings');
    } else if (pageId === 'page-usp1-detail' || pageId === 'page-usp2-detail') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-load-validation' || pageId === 'page-distance-validation') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-validation-run') {
        if (typeof goBackFromValidationRun === 'function') goBackFromValidationRun();
        return;
    } else if (pageId === 'page-validate-type-select' || pageId === 'page-validate') {
        if (isValidationPartiallyCompleted() && !isValidationFullyCompleted()) {
            showAppModal('Complete both USP 1 and USP 2 validation before exiting Validation.', 'Validation');
            return;
        }
        if (pageId === 'page-validate-type-select') {
            goToPage('validate');
        } else {
            goToPage('home');
        }
        return;
    } else if (pageId === 'page-calibration-type-select') {
        goToPage('validate');
    } else if (pageId === 'page-load-calibration' || pageId === 'page-distance-zero-calibration') {
        goToPage('calibration-type-select');
    } else if (pageId === 'page-datetime') {
        goToPage('settings');
    } else if (pageId === 'page-locked-members' || pageId === 'page-disabled-members') {
        goToPage('manage-members');
    } else if (pageId === 'page-settings' || pageId === 'page-reports' || pageId === 'page-user-profile' || pageId === 'page-manage-recipes') {
        goToPage('home');
    } else {
        goToPage('home');
    }
}

function login() {
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    var username = (uidEl && uidEl.value) ? uidEl.value.trim() : '';
    var password = (pwdEl && pwdEl.value) || '';
    if (!username || !password) {
        showAppModal('Please enter User/Employee ID and Password.', 'Login');
        return;
    }
    // Use raw fetch here so we can show backend error messages (lockout, disabled, etc.)
    fetch((API_BASE || '') + '/api/data/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        var msg = data.error || '';
        var remaining = (typeof data.remainingAttempts === 'number') ? data.remainingAttempts : null;
        if (result.status === 403 && data && data.passwordExpired) {
            showPasswordExpiredResetScreen(data.username || username, password);
            return;
        }
        if (result.status === 401) {
            if (remaining != null && remaining > 0) {
                msg = 'Incorrect password. ' + remaining + ' tr' + (remaining === 1 ? 'y' : 'ies') + ' remaining.';
            } else {
                msg = msg || 'Invalid username or password.';
            }
        } else if (result.status === 403) {
            msg = msg || 'Account locked. Contact admin.';
        } else if (!msg) {
            msg = 'Login failed (HTTP ' + result.status + ').';
        }
        showAppModal(msg, 'Login Failed');
    }).catch(function (err) {
        showAppModal('Login failed: ' + (err && err.message ? err.message : 'Network error'), 'Login Error');
    });
}

function showPasswordExpiredResetScreen(username, oldPassword) {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = oldPassword || '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (newEl && typeof newEl.focus === 'function') newEl.focus();
    }, 60);
}

function _restoreSidebarAndHeaderAfterExpiredReset() {
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (sidebar) {
        var prev = sidebar.getAttribute('data-prev-display');
        sidebar.style.display = prev != null ? prev : '';
        sidebar.removeAttribute('data-prev-display');
    }
    if (header) {
        var prevH = header.getAttribute('data-prev-display');
        header.style.display = prevH != null ? prevH : '';
        header.removeAttribute('data-prev-display');
    }
}

function submitExpiredPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/password-expired-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok) {
            _restoreSidebarAndHeaderAfterExpiredReset();
            showLoginScreen();
            var loginUid = document.getElementById('login-uid');
            var loginPwd = document.getElementById('login-pwd');
            if (loginUid) loginUid.value = username;
            if (loginPwd) loginPwd.value = '';
            showAppModal('Password updated. Please log in with your new password.', 'Reset Password');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function logout() {
    var runActive =
        (testRunButtonState === 'abort') ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);

    var doLogout = function () {
        stopActiveRunForLogout().finally(function () {
            apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST' }).catch(function () {});
            window.currentUser = null;
            try { localStorage.removeItem('currentUser'); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = null;
            showLoginScreen();
        });
    };

    if (runActive) {
        showConfirmModal('Test is running. Do you want to abort and logout?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            doLogout();
        });
        return;
    }

    doLogout();
}

function normalizeBiometricEnabled(value) {
    if (typeof value === 'string') {
        var v = value.trim().toLowerCase();
        if (v === 'disabled' || v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
        if (v === 'enabled' || v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    }
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    return true;
}

function applyBiometricSetting(enabled) {
    biometricEnabledSetting = normalizeBiometricEnabled(enabled);
    var loginDivider = document.getElementById('login-divider');
    if (loginDivider) {
        loginDivider.style.display = biometricEnabledSetting ? '' : 'none';
    }
    var loginBtn = document.getElementById('login-biometric-btn');
    if (loginBtn) {
        loginBtn.style.display = biometricEnabledSetting ? '' : 'none';
        loginBtn.disabled = !biometricEnabledSetting;
    }
    var enrollBtn = document.getElementById('enroll-biometric-btn');
    if (enrollBtn) {
        enrollBtn.style.display = biometricEnabledSetting ? '' : 'none';
        enrollBtn.disabled = !biometricEnabledSetting;
    }
}

function loginBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric login is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    showAppContainer();
    goToPage('home');
}

function enrollMemberBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric enrollment is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    var bioUserEl = document.getElementById('member-biometric-username');
    var formUserEl = document.getElementById('add-userid');
    var username = '';
    if (bioUserEl && bioUserEl.textContent && bioUserEl.textContent.trim() !== '--') {
        username = bioUserEl.textContent.trim();
    } else if (formUserEl && formUserEl.value) {
        username = formUserEl.value.trim();
    }
    if (!username) {
        showAppModal('No member selected for fingerprint enrollment. Save the member first.', 'Register Fingerprint');
        return;
    }
    showBiometricProgressOverlay('Register Fingerprint', 'Place your finger on the scanner. Hold still until enrollment completes.');
    apiRequest(API_BASE + '/api/biometric/enroll', {
        method: 'POST',
        body: { username: username }
    }).then(function (data) {
        hideBiometricProgressOverlay();
        if (data && data.ok) {
            _addMemberLastSavedId = null;
            showAppModal('Fingerprint enrolled successfully.', 'Register Fingerprint');
            goToPage('user-profile');
        } else {
            showAppModal((data && data.error) || 'Fingerprint enrollment failed.', 'Register Fingerprint');
        }
    }).catch(function (err) {
        hideBiometricProgressOverlay();
        showAppModal('Fingerprint enrollment failed: ' + (err && err.message ? err.message : 'Network error'), 'Register Fingerprint');
    });
}

function showBiometricProgressOverlay(title, message) {
    var overlay = document.getElementById('biometric-progress-overlay');
    var titleEl = document.getElementById('biometric-progress-title');
    var msgEl = document.getElementById('biometric-progress-message');
    if (titleEl && title) titleEl.textContent = title;
    if (msgEl && message) msgEl.textContent = message;
    if (overlay) overlay.style.display = 'flex';
}

function hideBiometricProgressOverlay() {
    var overlay = document.getElementById('biometric-progress-overlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelBiometricProgress() {
    hideBiometricProgressOverlay();
}

// ===== Generic Loading Overlay (export progress, long ops) =====
var _appLoadingCancelHandler = null;

function showLoadingOverlay(title, message, options) {
    var overlay = document.getElementById('app-loading-overlay');
    var titleEl = document.getElementById('app-loading-title');
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    var cancelBtn = document.getElementById('app-loading-cancel-btn');
    if (titleEl) titleEl.textContent = title || 'Working...';
    if (msgEl) msgEl.textContent = message || 'Please wait.';
    if (detailEl) detailEl.textContent = '';
    var opts = options || {};
    _appLoadingCancelHandler = typeof opts.onCancel === 'function' ? opts.onCancel : null;
    if (cancelBtn) {
        if (opts.cancellable === false) {
            cancelBtn.style.display = 'none';
        } else {
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
        }
    }
    // Default: spinner shown, progress bar hidden. Caller can switch with setLoadingProgress.
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (opts.progress === true) {
        if (spinner) spinner.style.display = 'none';
        if (pwrap) pwrap.style.display = '';
        if (pbar) pbar.style.width = '0%';
        if (ppct) ppct.textContent = '0%';
    } else {
        if (spinner) spinner.style.display = '';
        if (pwrap) pwrap.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function setLoadingMessage(message, detail) {
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    if (msgEl && message != null) msgEl.textContent = String(message);
    if (detailEl && detail != null) detailEl.textContent = String(detail);
}

function setLoadingProgress(percent, message, detail) {
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (spinner) spinner.style.display = 'none';
    if (pwrap) pwrap.style.display = '';
    var pct = parseFloat(percent);
    if (!isFinite(pct)) pct = 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pbar) pbar.style.width = pct.toFixed(1) + '%';
    if (ppct) ppct.textContent = Math.round(pct) + '%';
    if (message != null) setLoadingMessage(message, detail != null ? detail : undefined);
    else if (detail != null) setLoadingMessage(null, detail);
}

// Map any backend / network error into a single short user-facing line.
function _friendlyExportError(err) {
    var raw = '';
    if (err && err.message) raw = String(err.message);
    else if (typeof err === 'string') raw = err;
    var t = raw.toLowerCase();
    if (t.indexOf('no external pendrive') !== -1 || t.indexOf('not detected') !== -1)
        return 'No external pendrive detected. Please connect a USB pendrive and try again.';
    if (t.indexOf('multiple pendrives') !== -1)
        return 'Multiple pendrives detected. Please disconnect extras and try again.';
    if (t.indexOf('could not access') !== -1 || t.indexOf('not authorized') !== -1 || t.indexOf('mount') !== -1)
        return 'Could not access the pendrive. Reconnect it and try again.';
    if (t.indexOf('disk full') !== -1 || t.indexOf('no space') !== -1)
        return 'Pendrive is full. Free space or use a different pendrive.';
    return 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.';
}

function hideLoadingOverlay() {
    var overlay = document.getElementById('app-loading-overlay');
    if (overlay) overlay.style.display = 'none';
    _appLoadingCancelHandler = null;
}

function cancelLoadingOverlay() {
    var fn = _appLoadingCancelHandler;
    _appLoadingCancelHandler = null;
    hideLoadingOverlay();
    if (typeof fn === 'function') {
        try { fn(); } catch (e) { /* ignore */ }
    }
}

// ===== USB Pendrive Picker =====
var _usbPickerResolve = null;

function pickPendrive(devices) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('usb-picker-overlay');
        var list = document.getElementById('usb-picker-list');
        if (!overlay || !list) {
            resolve(null);
            return;
        }
        list.innerHTML = '';
        (devices || []).forEach(function (d) {
            var card = document.createElement('div');
            card.className = 'usb-picker-card';
            var label = d.label || '(no label)';
            var size = d.size_human || '';
            var fs = (d.fs_type || '').toUpperCase();
            var path = d.path || '';
            card.innerHTML =
                '<div class="usb-picker-card-meta">' +
                    '<span class="usb-picker-card-label">' + label + '</span>' +
                    '<span class="usb-picker-card-sub">' + path + ' \u2014 ' + size + (fs ? ' \u2014 ' + fs : '') + '</span>' +
                '</div>' +
                '<button type="button" class="btn btn-primary">Choose</button>';
            card.addEventListener('click', function () {
                hideUsbPicker();
                if (_usbPickerResolve) { _usbPickerResolve(d.path); _usbPickerResolve = null; }
            });
            list.appendChild(card);
        });
        _usbPickerResolve = resolve;
        overlay.style.display = 'flex';
    });
}

function hideUsbPicker() {
    var overlay = document.getElementById('usb-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelUsbPicker() {
    hideUsbPicker();
    if (_usbPickerResolve) {
        _usbPickerResolve(null);
        _usbPickerResolve = null;
    }
}

// ===== Report Preview HTML capture for PDF rendering =====
var _stylesCssCache = null;

function _fetchStylesCss() {
    if (_stylesCssCache != null) return Promise.resolve(_stylesCssCache);
    return fetch('styles.css', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('styles.css HTTP ' + r.status);
        return r.text();
    }).then(function (txt) {
        _stylesCssCache = String(txt || '');
        return _stylesCssCache;
    }).catch(function () {
        _stylesCssCache = '';
        return '';
    });
}

function _wrapPreviewHtmlAsDocument(innerHtml, cssText) {
    var docCss =
        '@page { size: A4; margin: 12mm 10mm; }' +
        'html, body { margin: 0; padding: 0; background: #ffffff; color: #000; }' +
        'body { font-family: Inter, "Segoe UI", Roboto, system-ui, sans-serif; }' +
        '.modal-overlay, .sidebar, .app-header, .header-back-btn, header.app-header, ' +
        '.test-run-controls, .report-preview-actions { display: none !important; }' +
        '#page-report-preview, .page, .page.active { display: block !important; position: static !important; ' +
            'background: #ffffff !important; color: #000 !important; padding: 0 !important; margin: 0 !important; ' +
            'opacity: 1 !important; overflow: visible !important; height: auto !important; max-height: none !important; }' +
        '#page-report-preview * { color: #000 !important; background: transparent !important; }' +
        '#page-report-preview table { border-collapse: collapse; width: 100%; }' +
        '#page-report-preview th, #page-report-preview td { border: 1px solid #888; padding: 4px 6px; }';
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>' +
        '<style>' + (cssText || '') + '</style>' +
        '<style>' + docCss + '</style>' +
        '</head><body>' + (innerHtml || '') + '</body></html>'
    );
}

function buildReportPreviewHtmlById(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.reject(new Error('Invalid report id'));
    return Promise.all([
        apiRequest(API_BASE + '/api/reports/' + id + '/preview'),
        _fetchStylesCss()
    ]).then(function (results) {
        var data = results[0];
        var css = results[1];
        if (!data || !data.preview) throw new Error('No preview for report ' + id);
        // Render into the existing hidden page-report-preview DOM (not navigated to).
        try {
            populateReportPreview(data.preview);
        } catch (e) {
            // populate must not throw; we continue with whatever DOM state.
        }
        var pageEl = document.getElementById('page-report-preview');
        var inner = pageEl ? pageEl.outerHTML : '';
        return _wrapPreviewHtmlAsDocument(inner, css);
    });
}

// ===== External-USB report export flow =====
function _summariseExportResult(result) {
    var count = (result && result.count) ? result.count : 0;
    var fails = (result && result.failed && result.failed.length) ? result.failed.length : 0;
    if (count > 0 && !fails) {
        return (count === 1)
            ? 'Report export successful.'
            : count + ' reports exported successfully.';
    }
    if (count > 0 && fails) {
        return count + ' exported, ' + fails + ' failed.';
    }
    return 'Export completed with no files written.';
}

function _ensureExportApprovalToken() {
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory') return Promise.resolve('');
    return openApprovalVerifyModal({
        purpose: 'export',
        titleText: 'Export approval',
        subtitleText: 'Enter credentials of a user with export approval permission.',
        usernameLabelText: 'Verifier username',
        usernamePlaceholder: 'Username',
        emptyCredentialsMessage: 'Enter verifier username and password.'
    }).then(function (token) {
        return token || '';
    });
}

function _exportReportsWithFlow(reportIds, opts) {
    var ids = (reportIds || []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x) && x > 0; });
    if (!ids.length) {
        showAppModal('No reports selected to export.', 'Export');
        return Promise.resolve(null);
    }
    var u = window.currentUser;
    if (!u || typeof userHasInternalKey !== 'function' || !userHasInternalKey(u, 'export-usb')) {
        showAppModal('You do not have permission to export reports to USB.', 'Export');
        return Promise.resolve(null);
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    var titleText = (opts && opts.title) ? opts.title : 'Export';

    return _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', 'Export');
            return Promise.resolve(null);
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};

        // Phase 1: detect USB (spinner, no percentage yet — quick).
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false });
        return apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return null;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            return pickPromise.then(function (devicePath) {
                if (!devicePath) return null;
                // Phase 2: build preview HTML for each report (frontend-only step).
                showLoadingOverlay(titleText, 'Preparing report PDFs...', { cancellable: false, progress: true });
                setLoadingProgress(0, 'Preparing report PDFs...', 'Step 1 of 2: rendering previews');
                return _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText).then(function (pdfHtmlByIdNeeded) {
                    // Phase 3: stream the export (real percentage per report).
                    setLoadingProgress(0, 'Starting export...', 'Step 2 of 2: mounting + uploading');
                    var payload = { report_ids: ids, device_path: devicePath };
                    if (pdfHtmlByIdNeeded && Object.keys(pdfHtmlByIdNeeded).length) {
                        payload.pdf_html_by_id = pdfHtmlByIdNeeded;
                    }
                    return _streamExportReports(payload, titleText, exportHeaders);
                });
            });
        });
}).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _streamExportReports(payload, titleText, exportHeaders) {
    var hdrs = { 'Content-Type': 'application/json' };
    if (exportHeaders && exportHeaders['X-Approval-Verify-Token']) {
        hdrs['X-Approval-Verify-Token'] = exportHeaders['X-Approval-Verify-Token'];
    }
    return fetch(API_BASE + '/api/reports/export/stream', {
        method: 'POST',
        headers: hdrs,
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    }).then(function (resp) {
        if (!resp.ok && resp.status !== 200) {
            return resp.json().catch(function () { return {}; }).then(function (j) {
                throw new Error((j && j.error) || ('HTTP ' + resp.status));
            });
        }
        if (!resp.body || !resp.body.getReader) {
            // Streams unsupported (very old browsers) -> fall back to buffered read.
            return resp.text().then(function (txt) {
                return _consumeNdjsonText(txt, titleText);
            });
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var lastEvent = null;
        function pump() {
            return reader.read().then(function (r) {
                if (r.done) {
                    if (buffer.trim()) {
                        try { lastEvent = JSON.parse(buffer); _handleExportEvent(lastEvent, titleText); }
                        catch (e) { /* trailing partial */ }
                    }
                    return lastEvent;
                }
                buffer += decoder.decode(r.value, { stream: true });
                var idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    var line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        var evt = JSON.parse(line);
                        lastEvent = evt;
                        _handleExportEvent(evt, titleText);
                    } catch (e) { /* skip malformed line */ }
                }
                return pump();
            });
        }
        return pump();
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _consumeNdjsonText(text, titleText) {
    var lines = String(text || '').split('\n');
    var last = null;
    for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (!s) continue;
        try { var evt = JSON.parse(s); last = evt; _handleExportEvent(evt, titleText); } catch (e) {}
    }
    return last;
}

function _handleExportEvent(evt, titleText) {
    if (!evt || typeof evt !== 'object') return;
    var ev = evt.event;
    if (ev === 'start') {
        setLoadingProgress(0, 'Starting export of ' + (evt.total || '?') + ' report(s)...', '');
        return;
    }
    if (ev === 'stage') {
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Stage: ' + evt.stage),
                           '');
        return;
    }
    if (ev === 'report') {
        var detail = 'Report ' + evt.current + ' of ' + evt.total + ' \u2014 ' + (evt.status || '');
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Exporting report ' + evt.current + ' of ' + evt.total + '...'),
                           detail);
        return;
    }
    if (ev === 'done') {
        setLoadingProgress(100, 'Export complete', '');
        // Brief flash at 100% so the user sees completion, then hide.
        setTimeout(function () {
            hideLoadingOverlay();
            if (evt.ok) {
                showAppModal(_summariseExportResult(evt), titleText);
            } else {
                showAppModal(
                    (evt.failed && evt.failed.length)
                        ? 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.'
                        : 'Export finished but no files were written.',
                    titleText);
            }
        }, 350);
        return;
    }
    if (ev === 'error') {
        hideLoadingOverlay();
        if (evt.code === 'MULTIPLE_PENDRIVES' && evt.devices && evt.devices.length) {
            // Race: a 2nd pendrive appeared mid-flow. Re-prompt.
            pickPendrive(evt.devices).then(function (devPath) {
                if (!devPath) return;
                // We don't have payload here; tell user to retry.
                showAppModal('Pendrive choice changed. Please tap Export again.', titleText);
            });
            return;
        }
        showAppModal(_friendlyExportError(evt.message || 'Export failed.'), titleText);
        return;
    }
}

function _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText) {
    var collected = {};
    var i = 0;
    var savedReportId = currentReportId;
    var savedReportData = currentReportData;
    function step() {
        if (i >= ids.length) {
            setLoadingProgress(100, 'Previews rendered. Connecting to pendrive...', '');
            if (savedReportId != null) {
                return apiRequest(API_BASE + '/api/reports/' + savedReportId + '/preview').then(function (data) {
                    if (data && data.preview) { try { populateReportPreview(data.preview); } catch (e) {} }
                    currentReportId = savedReportId;
                    currentReportData = savedReportData;
                    return collected;
                }).catch(function () { return collected; });
            }
            return collected;
        }
        var id = ids[i];
        var pct = (i / ids.length) * 100;
        setLoadingProgress(pct, 'Rendering preview ' + (i + 1) + ' of ' + ids.length + '...', 'Report id ' + id);
        return buildReportPreviewHtmlById(id).then(function (html) {
            if (html) collected[String(id)] = html;
        }).catch(function () { /* skip */ }).then(function () {
            i++;
            return step();
        });
    }
    return Promise.resolve().then(step);
}

function _saveReportPdfSilent(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.resolve(false);
    return buildReportPreviewHtmlById(id).then(function (html) {
        if (!html) return false;
        return apiRequest(API_BASE + '/api/reports/' + id + '/pdf', {
            method: 'POST',
            body: { html: html }
        }).then(function () { return true; }).catch(function () { return false; });
    }).catch(function () { return false; });
}

function startQuickTest() {
    goToPage('quick-test');
}

function _refreshQuickStepSummary() {
    var summaryEl = document.getElementById('quick-step-count-summary');
    var subEl = document.getElementById('quick-step-count-summary-sub');
    var n = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (window._quickStepTaps && window._quickStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._quickStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps';
        }
    }
}

function goToQuickTestStepsPage() {
    var current = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : 10;
    goToPage('quick-test-steps');
    setTimeout(function () {
        var radio = document.querySelector('input[name="quick-step-card"][value="' + current + '"]');
        if (radio) radio.checked = true;
        _renderQuickStepTapInputs(current);
        var cards = document.querySelectorAll('#quick-step-cards-grid label.create-recipe-card');
        cards.forEach(function (label) {
            label.removeEventListener('click', _onQuickStepCardClick);
            label.addEventListener('click', _onQuickStepCardClick);
        });
    }, 60);
}

function _onQuickStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="quick-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    setTimeout(function () { _renderQuickStepTapInputs(n); }, 0);
}

function _renderQuickStepTapInputs(stepCount) {
    var container = document.getElementById('quick-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._quickStepTaps && window._quickStepTaps.length === n)
        ? window._quickStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="quick-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="quick-step-tap-' + stepNum + '" ' +
                'class="input-field quick-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmQuickTestStepSetup() {
    var radio = document.querySelector('input[name="quick-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Quick Test');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Quick Test');
        return;
    }
    var inputs = document.querySelectorAll('#quick-step-tap-inputs input.quick-step-tap');
    var taps = [];
    for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
        var v = parseInt(inputs[i].value, 10);
        if (isNaN(v) || v < 1) {
            showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Quick Test');
            inputs[i].focus();
            return;
        }
        taps.push(v);
    }
    if (taps.length !== stepCount) {
        showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Quick Test');
        return;
    }
    window._quickStepCount = stepCount;
    window._quickStepTaps = taps;
    _refreshQuickStepSummary();
    goToPage('quick-test');
}

function startRecipeTest() {
    recipeListMode = 'load';
    goToPage('manage-recipes');
}

function manageRecipes() {
    recipeListMode = 'manage';
    goToPage('manage-recipes');
}

function startRecipeCreation() {
    window.currentEditingRecipeId = null;
    goToPage('create-recipe-step1');
}

function selectOperation(type) {
    if (type === 'validate') {
        validationCompletion = { distance: false, load: false };
        goToPage('validate-type-select');
    } else if (type === 'calibrate') {
        if (typeof canAccess === 'function' && window.currentUser && !canAccess(window.currentUser, 'calibration-menu')) {
            showAppModal('You do not have permission to run calibration.', 'Permission');
            return;
        }
        goToPage('calibration-type-select');
    }
}

function startValidationFromType() {
    var radio = document.querySelector('input[name="val-type"]:checked');
    lastValidationType = radio ? radio.value : 'distance'; // 'distance' = USP 1, 'load' = USP 2
    goToPage('validation-run');
}

function startUspValidation(type) {
    goToPage('validation-run');
}

function goBackFromValidationRun() {
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    validationRunState = 'idle';
    goToPage('validate-type-select');
}

function setValRunEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function initValidationRunPage() {
    var type = lastValidationType || 'distance';
    var usp = type === 'load' ? 'USP 2' : 'USP 1';
    var tapsMin = type === 'load' ? 250 : 300;
    var dropHeight = type === 'load' ? 3 : 14;
    validationRunTarget = type === 'load' ? 250 : 300;
    validationRunTolerance = 50;
    validationRunMin = validationRunTarget - validationRunTolerance;
    validationRunMax = validationRunTarget + validationRunTolerance;
    validationRunExpected = validationRunTarget;

    setValRunEl('val-run-usp', usp);
    setValRunEl('val-run-taps-min', String(tapsMin));
    setValRunEl('val-run-height', String(dropHeight));
    setValRunEl('val-run-expected', String(validationRunTarget) + ' (+/- ' + String(validationRunTolerance) + ')');
    setValRunEl('val-run-tap-count', '0');
    setValRunEl('val-run-status', 'Ready');
    setValRunEl('val-run-status-sub', 'Press Start to begin');

    var resultCard = document.getElementById('val-result-card');
    if (resultCard) resultCard.style.display = 'none';

    validationRunCurrentCount = 0;
    validationRunState = 'idle';
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }

    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary validation-action-btn';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function startCalibrationFromType() {
    var radio = document.querySelector('input[name="cal-type"]:checked');
    if (radio && radio.value === 'load') goToPage('load-calibration');
    else if (radio && radio.value === 'distance-zero') goToPage('distance-zero-calibration');
    else goToPage('load-calibration');
}

function viewRecipe() {
    goToPage('view-recipes');
}

// ----- Members: manage, locked, disabled -----
function loadMembersAndRender() {
    apiRequest(API_BASE + '/api/data/members', {
        method: 'GET'
    }).then(function (data) {
        var members = (data && data.members && Array.isArray(data.members)) ? data.members : [];
        membersCache = members;
        renderMembersView();
    }).catch(function (err) {
        console.error('Failed to load members', err);
        renderMembersView(); // still clear tables / empty state
    });
}

function renderMembersView() {
    var members = Array.isArray(membersCache) ? membersCache : [];
    var active = [];
    var locked = [];
    var disabled = [];
    members.forEach(function (m) {
        var status = (m && m.status ? String(m.status) : 'active').toLowerCase();
        if (status === 'locked') locked.push(m);
        else if (status === 'disabled') disabled.push(m);
        else active.push(m);
    });

    function renderTable(bodyId, emptyId, rows, options) {
        options = options || {};
        var tbody = document.getElementById(bodyId);
        var emptyEl = document.getElementById(emptyId);
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!rows || rows.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        var currentRole = (typeof getCurrentRole === 'function') ? getCurrentRole() : ((window.currentUser && window.currentUser.role) ? String(window.currentUser.role).toLowerCase() : null);
        var canUnlock = !(typeof canPerformAction === 'function') || canPerformAction(currentRole, 'user-unlock', 'change');
        var canEnable = !(typeof canPerformAction === 'function') || canPerformAction(currentRole, 'user-enable', 'change');
        // Sort by name for a consistent list
        rows.slice().sort(function (a, b) {
            var an = (a && a.name ? String(a.name) : '').toLowerCase();
            var bn = (b && b.name ? String(b.name) : '').toLowerCase();
            if (an < bn) return -1;
            if (an > bn) return 1;
            return 0;
        }).forEach(function (m) {
            var tr = document.createElement('tr');
            var name = m.name || '';
            var username = m.username || '';
            var role = m.role || '';
            if (options.style === 'active') {
                var roleKey = String(role || '').toLowerCase();
                var roleClass = 'member-role-badge ';
                if (roleKey === 'admin') roleClass += 'member-role-admin';
                else if (roleKey === 'supervisor') roleClass += 'member-role-supervisor';
                else if (roleKey === 'qa') roleClass += 'member-role-qa';
                else roleClass += 'member-role-user';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td><span class="' + roleClass + '">' + displayRoleLabel(role) + '</span></td>' +
                    '<td class="member-actions-cell">' +
                    '<button class="btn-member-action btn-role" onclick="openRoleModal(' + (m.id || 0) + ')">Change Role</button>' +
                    '<button class="btn-member-action btn-disable" onclick="disableMember(' + (m.id || 0) + ')">Disable</button>' +
                    '</td>';
            } else {
                var actionBtn = '';
                if (options.style === 'locked') {
                    actionBtn = '<button class="btn-member-action btn-unlock" ' + (canUnlock ? '' : 'disabled') + ' onclick="unlockMember(' + (m.id || 0) + ')">Unlock</button>';
                } else if (options.style === 'disabled') {
                    actionBtn = '<button class="btn-member-action btn-enable" ' + (canEnable ? '' : 'disabled') + ' onclick="enableMember(' + (m.id || 0) + ')">Enable</button>';
                }
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td>' + displayRoleLabel(role) + '</td>' +
                    '<td class="member-actions-cell">' + actionBtn + '</td>';
            }
            tbody.appendChild(tr);
        });
    }

    renderTable('members-list-body', 'members-empty-state', active, { style: 'active' });
    renderTable('locked-members-table-body', 'locked-members-empty-state', locked, { style: 'locked' });
    renderTable('disabled-members-table-body', 'disabled-members-empty-state', disabled, { style: 'disabled' });
}

function unlockMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-unlock', 'change')) {
            showAppModal('Only Admin/Factory can unlock accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Unlock this account?', 'Unlock Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/unlock', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account unlocked.', 'Unlock');
            })
            .catch(function (err) {
                showAppModal('Failed to unlock: ' + (err && err.message ? err.message : 'Unknown error'), 'Unlock');
            });
    });
}

function enableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-enable', 'change')) {
            showAppModal('Only Admin/Factory can enable accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Enable this account?', 'Enable Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/enable', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account enabled.', 'Enable');
            })
            .catch(function (err) {
                showAppModal('Failed to enable: ' + (err && err.message ? err.message : 'Unknown error'), 'Enable');
            });
    });
}

// ----- Reports and audit from API -----
function loadReports(filterType) {
    currentReportFilter = filterType || null;
    var tbody = document.getElementById('reports-table-body');
    var theadRow = document.getElementById('reports-thead-row');
    var bar = document.getElementById('audit-filters-bar');
    if (!tbody) return;
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    tbody.innerHTML = '';

    if (filterType === 'audit') {
        if (bar) bar.style.display = '';
        if (theadRow) theadRow.innerHTML = '<th>Date & Time</th><th>User</th><th>Role</th><th>Action</th><th>Details</th>';
        var userEl = document.getElementById('audit-filter-user');
        var roleEl = document.getElementById('audit-filter-role');
        var actionEl = document.getElementById('audit-filter-action');
        var fromDate = document.getElementById('audit-filter-from-date');
        var fromTime = document.getElementById('audit-filter-from-time');
        var toDate = document.getElementById('audit-filter-to-date');
        var toTime = document.getElementById('audit-filter-to-time');
        var fromTs = '';
        var toTs = '';
        if (fromDate && fromDate.value) {
            var parts = fromDate.value.split('-');
            var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
            var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
            fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
        }
        if (toDate && toDate.value) {
            var parts2 = toDate.value.split('-');
            var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
            var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
            toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
        }
        var q = [];
        if (userEl && userEl.value) q.push('user=' + encodeURIComponent(userEl.value));
        if (roleEl && roleEl.value) q.push('role=' + encodeURIComponent(roleEl.value));
        if (actionEl && actionEl.value) q.push('action=' + encodeURIComponent(actionEl.value));
        if (fromTs) q.push('from=' + fromTs);
        if (toTs) q.push('to=' + toTs);
        var auditUrl = API_BASE + '/api/data/audit-log' + (q.length ? '?' + q.join('&') : '');
        apiRequest(auditUrl).then(function (data) {
            var list = (data && data.entries) ? data.entries : [];
            if (userEl && userEl.options.length <= 1) {
                apiRequest(API_BASE + '/api/data/audit-log').then(function (full) {
                    var fullList = (full && full.entries) ? full.entries : [];
                    var users = [];
                    var actions = [];
                    fullList.forEach(function (e) {
                        var u = e.user || '--';
                        if (users.indexOf(u) === -1) users.push(u);
                        var a = e.action || '';
                        if (a && actions.indexOf(a) === -1) actions.push(a);
                    });
                    // Ensure core audit actions are always available
                    // Include both current (Title Case) and legacy action strings
                    // so existing stored audit rows remain filterable.
                    var coreActions = [
                        // Use backend's Title Case to avoid duplicates
                        'Login',
                        'Logout',
                        'Test performed',
                        'Report generated',
                        'Report approved',
                        'Recipe approved',
                        'Approval verification',
                        'Disable Recipe',
                        // legacy (older stored audit rows)
                        'Recipe disabled'
                    ];
                    coreActions.forEach(function (a) {
                        if (actions.indexOf(a) === -1) actions.push(a);
                    });

                    users.sort();
                    actions.sort();
                    if (userEl) {
                        userEl.innerHTML = '<option value="">All</option>';
                        users.forEach(function (u) { userEl.appendChild(new Option(u, u)); });
                    }
                    if (actionEl) {
                        actionEl.innerHTML = '<option value="">All</option>';
                        actions.forEach(function (a) {
                            actionEl.appendChild(new Option(a, a));
                        });
                    }
                }).catch(function () {});
            }
            if (!list.length) {
                var emptyRow = document.createElement('tr');
                emptyRow.innerHTML = '<td colspan="5">No audit entries match the filters.</td>';
                tbody.appendChild(emptyRow);
            } else {
                list.forEach(function (entry, i) {
                    var row = document.createElement('tr');
                    row.innerHTML = '<td>' + (entry.dateTime || '') + '</td><td>' + (entry.user || '--') + '</td><td>' + displayRoleLabel(entry.role || '--') + '</td><td>' + (entry.action || '') + '</td><td>' + (entry.details || '') + '</td>';
                    tbody.appendChild(row);
                });
            }
        }).catch(function () {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="5">Unable to load audit log.</td>';
            tbody.appendChild(emptyRow);
        });
        return;
    }

    if (bar) bar.style.display = 'none';
    if (theadRow) theadRow.innerHTML = '<th>SL No</th><th>Report Name</th><th>Creation Time</th><th>Action</th>';
    var filter = (filterType === 'test' || filterType === 'validation') ? filterType : 'all';
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        if (!list.length) {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="4">No reports.</td>';
            tbody.appendChild(emptyRow);
        } else {
            list.forEach(function (r, i) {
                var row = document.createElement('tr');
                var name = r.name;
                if (!name && r.type === 'validation') {
                    name = 'Validation - ' + (r.validationSubtype === 'load' ? 'USP 2' : 'USP 1');
                }
                if (!name) name = (r.recipe && r.recipe.productName) || 'Report ' + (r.id || (i + 1));
                var created = r.createdAt || r.created || '';
                if (created && created.length > 10) created = created.slice(0, 10) + ' ' + created.slice(11, 19);
                row.innerHTML = '<td>' + (i + 1) + '</td><td>' + name + '</td><td>' + created + '</td><td><button class="reports-open-btn" onclick="openReportPreview(' + (r.id || 0) + ')">Open</button></td>';
                tbody.appendChild(row);
            });
        }
    }).catch(function () {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="4">Unable to load reports.</td>';
        tbody.appendChild(emptyRow);
    });
}

function canViewAuditLog() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'audit-view');
    }
    return false;
}

function initAuditReportsVisibility() {
    var auditBtn = document.querySelector('.reports-filter-audit');
    if (auditBtn && !canViewAuditLog()) {
        auditBtn.style.display = 'none';
    }
}

function filterReports(type) {
    if (type === 'audit' && typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    loadReports(type);
}

function applyAuditFiltersAndRefresh() {
    loadReports('audit');
}

function exportAuditTrails() {
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    var u = window.currentUser;
    if (!u || typeof userHasInternalKey !== 'function' || !userHasInternalKey(u, 'export-usb')) {
        showAppModal('You do not have permission to export audit trails to USB.', 'Export');
        return;
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';

    var userEl = document.getElementById('audit-filter-user');
    var roleEl = document.getElementById('audit-filter-role');
    var actionEl = document.getElementById('audit-filter-action');
    var fromDate = document.getElementById('audit-filter-from-date');
    var fromTime = document.getElementById('audit-filter-from-time');
    var toDate = document.getElementById('audit-filter-to-date');
    var toTime = document.getElementById('audit-filter-to-time');

    var fromTs = '';
    var toTs = '';

    if (fromDate && fromDate.value) {
        var parts = fromDate.value.split('-');
        var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
        var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
        fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
    }
    if (toDate && toDate.value) {
        var parts2 = toDate.value.split('-');
        var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
        var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
        toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
    }

    var filters = {};
    if (userEl && userEl.value) filters.user = userEl.value;
    if (roleEl && roleEl.value) filters.role = roleEl.value;
    if (actionEl && actionEl.value) filters.action = actionEl.value;
    if (fromTs) filters.from = fromTs;
    if (toTs) filters.to = toTs;

    var titleText = 'Export Audit';
    _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', titleText);
            return;
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false, progress: true });
        setLoadingProgress(5, 'Detecting external pendrive...', '');
        apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            pickPromise.then(function (devicePath) {
                if (!devicePath) return;
                showLoadingOverlay(titleText, 'Generating audit-trail PDF...', { cancellable: false, progress: true });
                setLoadingProgress(25, 'Mounting pendrive...', devicePath);
                setTimeout(function () { setLoadingProgress(60, 'Rendering audit-trail PDF...', ''); }, 600);
                apiRequest(API_BASE + '/api/audit/export', {
                    method: 'POST',
                    headers: exportHeaders,
                    body: { filters: filters, device_path: devicePath }
                }).then(function (res) {
                    if (res && res.success) {
                        setLoadingProgress(95, 'Writing to pendrive...', '');
                        setTimeout(function () {
                            setLoadingProgress(100, 'Export complete', '');
                            setTimeout(function () {
                                hideLoadingOverlay();
                                showAppModal('Audit trail export successful.', titleText);
                            }, 350);
                        }, 250);
                    } else {
                        hideLoadingOverlay();
                        showAppModal(_friendlyExportError((res && res.error) || 'audit export failed'), titleText);
                    }
                }).catch(function (err) {
                    hideLoadingOverlay();
                    showAppModal(_friendlyExportError(err), titleText);
                });
            });
        }).catch(function (err) {
            hideLoadingOverlay();
            showAppModal(_friendlyExportError(err), titleText);
        });
    });
}

function exportFilteredReports() {
    if (currentReportFilter === 'audit') {
        exportAuditTrails();
        return;
    }
    var filter = (currentReportFilter === 'test' || currentReportFilter === 'validation') ? currentReportFilter : 'all';
    showLoadingOverlay('Export Reports', 'Loading report list...', { cancellable: false });
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        var ids = list.map(function (r) { return r && r.id ? parseInt(r.id, 10) : null; }).filter(function (x) { return x; });
        hideLoadingOverlay();
        if (!ids.length) {
            showAppModal('No reports match the current filter to export.', 'Export Reports');
            return;
        }
        showConfirmModal(
            'Export ' + ids.length + ' report' + (ids.length === 1 ? '' : 's') +
            ' to USB (filter: ' + filter + ')?',
            'Export Reports'
        ).then(function (ok) {
            if (!ok) return;
            _exportReportsWithFlow(ids, { title: 'Export Reports (' + filter + ')' });
        });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal('Could not load reports: ' + (err && err.message ? err.message : 'Network error'), 'Export Reports');
    });
}
function handlePrintReport() {
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    var reportData = currentReportData;
    var doPrint = function () {
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    };
    if (reportData) {
        doPrint();
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + currentReportId).then(function (data) {
        reportData = data.report || data;
        if (reportData) {
            currentReportData = reportData;
            doPrint();
        } else {
            showAppModal('Could not load report data. Please try again.', 'Print');
        }
    }).catch(function () {
        showAppModal('Could not load report data. Please try again.', 'Print');
    });
}

function handlePrintThermal() {
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    var reportData = currentReportData;
    var doPrint = function () {
        fetch((API_BASE || '') + '/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to thermal printer.', 'Print');
            } else {
                showAppModal(result.error || 'Thermal print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    };
    if (reportData) {
        doPrint();
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + currentReportId).then(function (data) {
        reportData = data.report || data;
        if (reportData) {
            currentReportData = reportData;
            doPrint();
        } else {
            showAppModal('Could not load report data. Please try again.', 'Print');
        }
    }).catch(function () {
        showAppModal('Could not load report data. Please try again.', 'Print');
    });
}

function handleExportReport() {
    if (currentReportId == null) {
        showAppModal('No report selected to export.', 'Export');
        return;
    }
    _exportReportsWithFlow([currentReportId], { title: 'Export Report' });
}

function setRecipePrintEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function populateRecipePrintPreview(recipe, factorySettings) {
    if (!recipe) return;
    currentRecipeForPrint = recipe;
    var fs = factorySettings || recipe.factorySettings || {};
    setRecipePrintEl('recipe-print-company-name', fs.companyName || 'N/A');
    setRecipePrintEl('recipe-print-model-no', fs.modelNo || 'N/A');
    setRecipePrintEl('recipe-print-serial-no', fs.serialNo || 'N/A');
    setRecipePrintEl('recipe-print-location', fs.companyLocation || fs.location || 'N/A');
    setRecipePrintEl('recipe-print-instrument-no', fs.instrumentId || 'N/A');
    setRecipePrintEl('recipe-print-previous-val', fs.lastValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-next-validation', fs.nextValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-product', recipe.productName || recipe.name || '--');
    var usp = recipe.usp || (recipe.steps && recipe.steps.length ? (recipe.steps[0].speed === 250 ? 'USP 2' : 'USP 1') : '');
    setRecipePrintEl('recipe-print-usp', usp || '--');
    var speed = recipe.speed || (recipe.steps && recipe.steps.length ? recipe.steps[0].speed : null);
    setRecipePrintEl('recipe-print-speed', speed != null ? (speed + ' Taps/Min') : '--');
    var tbody = document.getElementById('recipe-print-tolerance-body');
    if (tbody) {
        var stepCount = (recipe.stepCount != null) ? recipe.stepCount : (recipe.steps ? recipe.steps.length : '--');
        tbody.innerHTML =
            '<tr><td>Steps</td><td>' + stepCount + '</td><td></td></tr>';
    }
}

function openRecipePrintPreview(recipeIdOrRecipe) {
    var recipeId = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe.id : recipeIdOrRecipe;
    var recipe = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe : null;
    function openWithRecipe(r, fs) {
        populateRecipePrintPreview(r, fs);
        goToPage('recipe-print-preview');
    }
    if (recipe && recipe.id) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            openWithRecipe(recipe, fs);
        }).catch(function () {
            openWithRecipe(recipe, null);
        });
        return;
    }
    if (!recipeId) return;
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'View Recipe');
            return;
        }
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (fsData) {
            var fs = (fsData && fsData.settings) ? fsData.settings : (fsData || {});
            openWithRecipe(r, fs);
        }).catch(function () {
            openWithRecipe(r, null);
        });
    }).catch(function () {
        showAppModal('Recipe not found.', 'View Recipe');
    });
}

function handlePrintRecipeA4() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintA4();
        }).catch(function () { doPrintA4(); });
    } else {
        doPrintA4();
    }
    function doPrintA4() {
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    }
}

function handlePrintRecipeThermal() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintThermal();
        }).catch(function () { doPrintThermal(); });
    } else {
        doPrintThermal();
    }
    function doPrintThermal() {
        fetch((API_BASE || '') + '/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to thermal printer.', 'Print');
            } else {
                showAppModal(result.error || 'Thermal print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    }
}
function scrollReportPreviewActionsIntoView() {
    var bar = document.getElementById('report-preview-actions');
    if (!bar) return;
    bar.classList.remove('report-actions-highlight');
    void bar.offsetWidth;
    bar.classList.add('report-actions-highlight');
    try {
        bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
        bar.scrollIntoView(true);
    }
}

function openReportPreview(reportId) {
    if (!reportId) return;
    apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (data.preview) {
            currentReportId = reportId;
            currentReportData = null;
            populateReportPreview(data.preview);
            goToPage('report-preview');
        }
    }).catch(function () { showAppModal('Report not found', 'Reports'); });
}

function setReportEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function formatReportDate(isoStr) {
    if (!isoStr) return '--';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '--';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yy = d.getFullYear();
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return dd + '/' + mm + '/' + yy + ' ' + h + ':' + m + ':' + s;
}

function populateReportPreview(preview) {
    if (!preview) return;
    var reportType = preview.type || 'test';
    var isValidationOrCalibration = (reportType === 'validation' || reportType === 'calibration');
    var valCalSection = document.getElementById('report-validation-calibration-section');
    var testSections = document.getElementById('report-test-sections');
    if (valCalSection) valCalSection.style.display = isValidationOrCalibration ? 'block' : 'none';
    if (testSections) testSections.style.display = isValidationOrCalibration ? 'none' : 'block';

    var recipe = preview.recipe || (preview.testData && preview.testData.recipe) || preview.testData || {};
    var fs = preview.factorySettings || {};
    var td = preview.testData || preview;

    setReportEl('report-company-name', fs.companyName);
    setReportEl('report-model-no', fs.modelNo);
    setReportEl('report-serial-no', fs.serialNo);
    setReportEl('report-location', fs.companyLocation || fs.location);
    setReportEl('report-instrument-no', fs.instrumentId);
    setReportEl('report-previous-val', fs.lastValidationDate);
    setReportEl('report-next-validation', fs.nextValidationDate);

    if (reportType === 'validation') {
        var titleEl = document.getElementById('report-validation-calibration-title');
        var bodyEl = document.getElementById('report-validation-calibration-body');
        if (titleEl) titleEl.textContent = 'VALIDATION DETAILS';
        if (bodyEl) {
            var dateStr = formatReportDate(td.completedAt || preview.completedAt || preview.createdAt);
            var usp = td.usp || preview.usp || '--';
            var tapsMin = td.tapsMin != null ? td.tapsMin : (preview.tapsMin != null ? preview.tapsMin : '--');
            var dropHeight = td.dropHeight != null ? td.dropHeight : (preview.dropHeight != null ? preview.dropHeight : '--');
            var expected = td.expectedTapCount != null ? td.expectedTapCount : (preview.expectedTapCount != null ? preview.expectedTapCount : '--');
            var tol = td.expectedTolerance != null ? td.expectedTolerance : (preview.expectedTolerance != null ? preview.expectedTolerance : null);
            var expectedDisplay = (tol != null && expected !== '--') ? (String(expected) + ' (+/- ' + String(tol) + ')') : expected;
            var actual = td.actualTapCount != null ? td.actualTapCount : (preview.actualTapCount != null ? preview.actualTapCount : '--');
            var status = td.status || preview.status || '--';
            var rows = [];
            rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
            rows.push('<tr><th>USP</th><td>' + usp + '</td><th>Taps/Min</th><td>' + tapsMin + '</td></tr>');
            rows.push('<tr><th>Drop Height (mm)</th><td>' + dropHeight + '</td><th>Status</th><td>' + status + '</td></tr>');
            rows.push('<tr><th>Expected Tap Count</th><td>' + expectedDisplay + '</td><th>Actual Tap Count</th><td>' + actual + '</td></tr>');
            bodyEl.innerHTML = rows.join('');
        }
    }

    setReportEl('report-product-name', recipe.productName || td.productName);

    var startStr = formatReportDate(td.testStartTime || preview.createdAt);
    var endStr = formatReportDate(td.testEndTime || preview.completedAt || preview.createdAt);
    setReportEl('report-test-start', startStr);
    setReportEl('report-generated', endStr);

    var durationSec = td.durationSeconds;
    var durationStr = (durationSec != null && durationSec >= 0) ? (durationSec + ' s') : '--';
    setReportEl('report-test-duration', durationStr);
    var sc = (td.stepCount != null ? td.stepCount : (td.steps && td.steps.length ? td.steps.length : null));
    var cs = (td.completedSteps != null ? td.completedSteps : null);
    var statusLabel = (td.status === 'aborted' ? 'Aborted' : 'Completed');
    if (cs != null && sc != null) statusLabel = statusLabel + ' (' + cs + '/' + sc + ' steps)';
    setReportEl('report-test-status', statusLabel);

    var tbody = document.getElementById('report-test-data-body');
    if (tbody) {
        // Determine how many steps to show
        var stepCount =
            (td.stepCount != null ? td.stepCount : null) ||
            (td.steps && td.steps.length) ||
            (td.stepResults && td.stepResults.length) ||
            0;

        var results = td.stepResults || [];
        var rows = [];

        if (stepCount > 0) {
            for (var i = 0; i < stepCount; i++) {
                var r = results[i] || {};
                var vol = (r.volumeMl != null && r.volumeMl !== '') ? r.volumeMl : '__';
                var dVol = '__';
                if (r.volumeDeltaMl != null && r.volumeDeltaMl !== '' && !isNaN(parseFloat(r.volumeDeltaMl))) {
                    dVol = _formatDensity(parseFloat(r.volumeDeltaMl));
                }
                var bulk = (r.bulkDensity != null && r.bulkDensity !== '') ? r.bulkDensity : '__';
                var tap = (r.tapDensity != null && r.tapDensity !== '') ? r.tapDensity : '__';
                var resText = (r.resultText != null && r.resultText !== '') ? r.resultText : '__';

                rows.push(
                    '<tr>' +
                        '<td>' + (i + 1) + '</td>' +
                        '<td>' + vol + '</td>' +
                        '<td>' + dVol + '</td>' +
                        '<td>' + bulk + '</td>' +
                        '<td>' + tap + '</td>' +
                        '<td>' + resText + '</td>' +
                    '</tr>'
                );
            }
            tbody.innerHTML = rows.join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="6">No test data</td></tr>';
        }
    }

    var statBody = document.getElementById('report-statistics-body');
    if (statBody) {
        var stats = preview.statistics || td.statistics || {};
        if (stats && Object.keys(stats).length) {
            var rows = [];
            for (var k in stats) {
                if (stats.hasOwnProperty(k) && typeof stats[k] === 'object' && stats[k] !== null) {
                    var v = stats[k];
                    var mean = v.mean != null ? v.mean : v.Mean;
                    var min = v.min != null ? v.min : v.Min;
                    var max = v.max != null ? v.max : v.Max;
                    if (mean != null || min != null || max != null) {
                        rows.push('<tr><th>' + k + '</th><td>' + (mean != null ? mean : '--') + '</td><td>' + (min != null ? min : '--') + '</td><td>' + (max != null ? max : '--') + '</td></tr>');
                    }
                }
            }
            statBody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4">N/A</td></tr>';
        } else {
            statBody.innerHTML = '<tr><td colspan="4">N/A</td></tr>';
        }
    }

    var remarksEl = document.getElementById('report-remarks-box');
    if (remarksEl) remarksEl.textContent = preview.remarks || td.remarks || 'N/A';

    setReportEl('report-operated-by', td.operatorName || '--');
    setReportEl('report-employee-id', td.employeeId || '--');
    setReportEl('report-approved-by', formatApprovedByLine(preview.approvedBy || '--'));
    setReportEl('report-approval-pass-fail', preview.approvalPassFail || '--');
    var apprRem = preview.approvalRemarks;
    setReportEl('report-approval-remarks', (apprRem != null && String(apprRem).trim() !== '') ? apprRem : 'N/A');

    window._lastReportPreview = preview;
    var reportTypeNorm = String(preview.type || 'test').trim().toLowerCase();
    var approvalSt = String(preview.reportApprovalStatus || '').trim().toLowerCase();

    var apprPanel = document.getElementById('report-approve-panel');
    if (apprPanel) {
        var needTest = reportTypeNorm === 'test' && approvalSt === 'pending' && typeof userCanApproveTestReport === 'function' && userCanApproveTestReport();
        var needVal = reportTypeNorm === 'validation' && approvalSt === 'pending' && typeof userCanApproveValidationReport === 'function' && userCanApproveValidationReport();
        apprPanel.style.display = (needTest || needVal) ? 'block' : 'none';
    }

    var peGroup = document.getElementById('report-preview-print-export-group');
    if (peGroup) {
        var hidePrintExport = approvalSt === 'pending' && (reportTypeNorm === 'test' || reportTypeNorm === 'validation');
        peGroup.style.display = hidePrintExport ? 'none' : '';
    }
}

function approveReportWithVerifier(reportId, passFail, remarks) {
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username))
        ? (window.currentUser.name || window.currentUser.username) : '';
    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');

    function postReportApprove(extraHeaders) {
        return apiRequest(API_BASE + '/api/data/reports/' + reportId + '/approve', {
            method: 'POST',
            headers: extraHeaders || {},
            body: { passFail: passFail, remarks: remarks, approverName: name }
        }).then(function (data) {
            if (data && data.ok) return true;
            showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', 'Report');
            return false;
        });
    }

    if (role === 'factory') {
        return postReportApprove({});
    }

    return Promise.all([refreshActiveQaCount(), refreshActiveSupervisorCount()]).then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForReport()).then(function (token) {
            if (!token) return null;
            return postReportApprove({ 'X-Approval-Verify-Token': token });
        });
    });
}

function submitReportApprove() {
    var id = currentReportId;
    if (id == null) return;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        showAppModal('Select Pass or Fail.', 'Report');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    approveReportWithVerifier(id, pf, remarks).then(function (ok) {
        if (ok === true) {
            showAppModal('Report approved.', 'Report');
            openReportPreview(id);
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Report');
    });
}

var _pendingTestRunReportId = null;

function openTestRunCompletionApprovalModal() {
    var overlay = document.getElementById('test-run-completion-overlay');
    var passEl = document.querySelector('input[name="test-run-completion-pass-fail"][value="PASS"]');
    if (passEl) passEl.checked = true;
    var ta = document.getElementById('test-run-completion-remarks');
    if (ta) ta.value = '';
    var errEl = document.getElementById('test-run-completion-error');
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function closeTestRunCompletionApprovalModal() {
    var overlay = document.getElementById('test-run-completion-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmTestRunCompletionApproval() {
    var id = _pendingTestRunReportId;
    if (id == null) return;
    var pfEl = document.querySelector('input[name="test-run-completion-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        showAppModal('Select Pass or Fail.', 'Test complete');
        return;
    }
    var ta = document.getElementById('test-run-completion-remarks');
    var remarks = ta ? ta.value.trim() : '';
    approveReportWithVerifier(id, pf, remarks).then(function (ok) {
        if (ok === true) {
            closeTestRunCompletionApprovalModal();
            _pendingTestRunReportId = null;
            showAppModal('Report approved.', 'Report');
            openReportPreview(id);
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Report');
    });
}

function skipTestRunCompletionToReport() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
}

var lastTestRunRecipe = null;
var testRunButtonState = 'start'; // 'start' | 'abort'
var testRunIntervalId = null;
var testRunCurrentStepIndex = 0;
var testRunCurrentTapCount = 0;
var testRunSteps = [];
var testRunTotalSteps = 0;
var testRunStepResults = []; // { stepIndex, bulkDensity, tapDensity, resultText }
var testRunStepVolumes = [];   // per-step volume entries
var testRunInitialWeightG = null;
var testRunInitialVolumeMl = null;   // first reading at Start (bulk density baseline)
var testRunPreviousVolumeMl = null;  // last reading before current step’s post-tap volume
var testRunLastStepVolumeDeltaMl = null;
var testRunLastStepPreviousMl = null;
var testRunLastStepCurrentMl = null;
var _pendingStepVolumeDeltaMl = null;
var _testRunInitialWeightResolve = null;

function getMaxSampleVolumeMl(recipe) {
    if (!recipe) return null;
    if (recipe.sampleVolumeMl != null && recipe.sampleVolumeMl !== '') {
        var n = parseFloat(recipe.sampleVolumeMl);
        return isNaN(n) ? null : n;
    }
    if (recipe.cylinder && (recipe.cylinder.volume != null || recipe.cylinder.volumeMl != null)) {
        var v = recipe.cylinder.volume != null ? recipe.cylinder.volume : recipe.cylinder.volumeMl;
        var n2 = parseFloat(v);
        return isNaN(n2) ? null : n2;
    }
    return null;
}

function _formatDensity(n) {
    if (n == null || isNaN(n)) return '--';
    return String(Math.round(n * 1000) / 1000);
}

function computeBulkDensityGPerMl(weightG, initialVolMl) {
    var w = parseFloat(weightG);
    var v = parseFloat(initialVolMl);
    if (isNaN(w) || isNaN(v) || v <= 0) return null;
    return w / v;
}

function computeTapDensityGPerMl(weightG, finalTappedVolMl) {
    var w = parseFloat(weightG);
    var v = parseFloat(finalTappedVolMl);
    if (isNaN(w) || isNaN(v) || v <= 0) return null;
    return w / v;
}

function askVolumeForStep(stepIndex) {
    return openTestRunVolumeModal(stepIndex).then(function (vol) {
        if (vol === null || vol === '') return null;
        var num = parseFloat(vol);
        if (!isNaN(num)) testRunStepVolumes[stepIndex] = num;
        else testRunStepVolumes[stepIndex] = vol;
        return vol;
    });
}

function openTestRunInitialWeightModal() {
    return new Promise(function (resolve) {
        _testRunInitialWeightResolve = resolve;
        var overlay = document.getElementById('test-run-initial-weight-overlay');
        var input = document.getElementById('test-run-initial-weight-input');

        if (!overlay || !input) {
            while (true) {
                var w = window.prompt('Enter initial weight in gm before starting the test:', '');
                if (w === null || String(w).trim() === '') {
                    resolve(null);
                    return;
                }
                var n = parseFloat(w);
                if (isNaN(n) || n <= 0) {
                    window.alert('Please enter a valid initial weight greater than 0.');
                    continue;
                }
                resolve(String(w).trim());
                return;
            }
        }

        input.value = '';
        overlay.style.display = 'flex';
        setTimeout(function () {
            try {
                input.focus();
                if (typeof window.openOSKForInput === 'function') window.openOSKForInput(input);
            } catch (e) {}
        }, 0);

        if (!input._initialWeightKeydownHandler) {
            input._initialWeightKeydownHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmTestRunInitialWeight();
                }
            };
            input.addEventListener('keydown', input._initialWeightKeydownHandler);
        }
    });
}

function confirmTestRunInitialWeight() {
    var overlay = document.getElementById('test-run-initial-weight-overlay');
    var input = document.getElementById('test-run-initial-weight-input');
    var val = input ? String(input.value || '').trim() : '';

    if (val === '') {
        if (overlay) overlay.style.display = 'none';
        if (typeof window.closeOSK === 'function') window.closeOSK();
        if (!_testRunInitialWeightResolve) return;
        var r0 = _testRunInitialWeightResolve;
        _testRunInitialWeightResolve = null;
        r0(null);
        return;
    }

    var num = parseFloat(val);
    if (isNaN(num) || num <= 0) {
        showAppModal('Please enter a valid initial weight greater than 0.', 'Initial Weight (gm)');
        if (input) input.select();
        return;
    }

    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunInitialWeightResolve) return;
    var r = _testRunInitialWeightResolve;
    _testRunInitialWeightResolve = null;
    r(String(num));
}

function cancelTestRunInitialWeight() {
    var overlay = document.getElementById('test-run-initial-weight-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunInitialWeightResolve) return;
    var r = _testRunInitialWeightResolve;
    _testRunInitialWeightResolve = null;
    r(null);
}

var _testRunVolumeResolve = null;
var _testRunVolumeStepIndex = 0;

function openTestRunVolumeModal(stepIndex) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('test-run-volume-overlay');
        var titleEl = document.getElementById('test-run-volume-title');
        var msgEl = document.getElementById('test-run-volume-message');
        var input = document.getElementById('test-run-volume-input');

        _testRunVolumeResolve = resolve;
        _testRunVolumeStepIndex = stepIndex;

        var displayStep = stepIndex + 1;
        var maxMl = getMaxSampleVolumeMl(lastTestRunRecipe);
        var message = 'Enter volume in ml for step ' + displayStep + ':';
        if (maxMl != null) {
            message = 'Enter volume in ml for step ' + displayStep + ' (max ' + maxMl + ' ml):';
        }

        if (!overlay || !titleEl || !msgEl || !input) {
            // Fallback if modal markup not available
            while (true) {
                var vol = window.prompt(message, '');
                if (vol === null || String(vol).trim() === '') {
                    resolve(null);
                    return;
                }
                var num = parseFloat(vol);
                if (isNaN(num) || num <= 0) {
                    window.alert('Please enter a valid volume in ml greater than 0.');
                    continue;
                }
                if (maxMl != null && num > maxMl) {
                    window.alert('Volume in ml cannot exceed cylinder size (' + maxMl + ' ml).');
                    continue;
                }
                resolve(String(vol).trim());
                return;
            }
        }

        titleEl.textContent = 'VOLUME IN ML - STEP ' + (stepIndex + 1);
        msgEl.textContent = message;
        input.value = '';
        if (maxMl != null) {
            input.setAttribute('max', String(maxMl));
            input.setAttribute('min', '0');
        } else {
            input.removeAttribute('max');
            input.setAttribute('min', '0');
        }
        overlay.style.display = 'flex';

        setTimeout(function () {
            try {
                input.focus();
                if (typeof window.openOSKForInput === 'function') window.openOSKForInput(input);
            } catch (e) {}
        }, 0);

        if (!input._volumeKeydownHandler) {
            input._volumeKeydownHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmTestRunVolume();
                }
            };
            input.addEventListener('keydown', input._volumeKeydownHandler);
        }
    });
}

function confirmTestRunVolume() {
    var overlay = document.getElementById('test-run-volume-overlay');
    var input = document.getElementById('test-run-volume-input');
    var val = input ? String(input.value || '').trim() : '';

    if (val === '') {
        if (overlay) overlay.style.display = 'none';
        if (typeof window.closeOSK === 'function') window.closeOSK();
        if (!_testRunVolumeResolve) return;
        var r0 = _testRunVolumeResolve;
        _testRunVolumeResolve = null;
        r0(null);
        return;
    }

    var num = parseFloat(val);
    if (isNaN(num)) {
        showAppModal('Please enter a valid number for volume in ml.', 'Volume');
        if (input) input.select();
        return;
    }
    if (num <= 0) {
        showAppModal('Volume in ml must be greater than 0.', 'Volume');
        if (input) input.select();
        return;
    }

    var maxMl = getMaxSampleVolumeMl(lastTestRunRecipe);
    if (maxMl != null && num > maxMl) {
        showAppModal('Volume in ml cannot exceed cylinder size (' + maxMl + ' ml).', 'Volume');
        if (input) input.select();
        return;
    }

    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunVolumeResolve) return;
    var r = _testRunVolumeResolve;
    _testRunVolumeResolve = null;
    r(val);
}

function cancelTestRunVolume() {
    var overlay = document.getElementById('test-run-volume-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunVolumeResolve) return;
    var r = _testRunVolumeResolve;
    _testRunVolumeResolve = null;
    r(null);
}

function startTestRun(recipe) {
    if (!recipe) return;
    lastTestRunRecipe = recipe;
    testRunButtonState = 'start';
    goToPage('test-run');

    function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    setText('run-product-name', recipe.productName || '--');
    setText('run-batch-no', recipe.batchNumber || '--');
    var uspLabel = recipe.usp;
    if (!uspLabel) {
        var m = String(recipe.uspMode || '').toUpperCase();
        if (m === 'USP1') uspLabel = 'USP 1';
        else if (m === 'USP2') uspLabel = 'USP 2';
        else if (m === 'CUSTOM') uspLabel = 'Custom';
        else if (recipe.steps && recipe.steps[0] && recipe.steps[0].speed != null) {
            var sp = parseInt(recipe.steps[0].speed, 10);
            if (sp === 250) uspLabel = 'USP 2';
            else if (sp === 300) uspLabel = 'USP 1';
        }
    }
    setText('run-usp', uspLabel || '--');
    // Initial Volume/Weight are entered at Start time, so reset display here.
    setText('run-sample-volume', '--');
    setText('run-initial-weight', '--');

    var totalSteps = Math.max(1, parseInt(recipe.stepCount, 10) || 10);
    setText('run-total-steps-card', String(totalSteps));
    setText('run-current-step-card', '1');
    setText('run-tap-count-card', '0');
    var firstStepTapCount = (recipe.steps && recipe.steps[0] && recipe.steps[0].tapCount != null)
        ? String(recipe.steps[0].tapCount) : '--';
    setText('run-tap-count-of-card', 'of ' + firstStepTapCount);
    setText('run-status-text', 'Ready');
    setText('run-status-subtext', 'Waiting to start');

    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }

    // Ensure step index and run inputs are reset for a fresh run
    testRunCurrentStepIndex = 0;
    testRunStepVolumes = [];
    testRunInitialWeightG = null;
    testRunInitialVolumeMl = null;
    testRunPreviousVolumeMl = null;
    testRunLastStepVolumeDeltaMl = null;
    testRunLastStepPreviousMl = null;
    testRunLastStepCurrentMl = null;
    _pendingStepVolumeDeltaMl = null;
}

function startQuickTestRun() {
    var productName = (document.getElementById('quick-product-name') && document.getElementById('quick-product-name').value) || '';
    var batchNumber = (document.getElementById('quick-batch-number') && document.getElementById('quick-batch-number').value) || '';
    var qmode = getQuickUspMode();
    var speed = 300;
    var dropHeight = 14;
    if (qmode === 'USP1') {
        speed = 300;
        dropHeight = 14;
    } else if (qmode === 'USP2') {
        speed = 250;
        dropHeight = 3;
    } else {
        var speedRadios = document.querySelectorAll('input[name="quick-speed"]');
        for (var i = 0; i < speedRadios.length; i++) {
            if (speedRadios[i].checked) {
                speed = parseInt(speedRadios[i].value, 10) || 300;
                break;
            }
        }
        var heightRadios = document.querySelectorAll('input[name="quick-height"]');
        for (var j = 0; j < heightRadios.length; j++) {
            if (heightRadios[j].checked) {
                dropHeight = parseInt(heightRadios[j].value, 10) || 14;
                break;
            }
        }
    }
    var stepCount;
    if (typeof window._quickStepCount === 'number' && window._quickStepCount >= 1) {
        stepCount = window._quickStepCount;
    } else {
        var stepCountEl = document.getElementById('quick-step-count');
        stepCount = stepCountEl ? (parseInt(stepCountEl.value, 10) || 10) : 10;
    }
    var cylinderRadios = document.querySelectorAll('input[name="quick-cylinder"]');
    var sampleVolumeMl = null;
    for (var k = 0; k < cylinderRadios.length; k++) {
        if (cylinderRadios[k].checked) {
            sampleVolumeMl = parseInt(cylinderRadios[k].value, 10) || null;
            break;
        }
    }
    if (sampleVolumeMl == null) {
        showAppModal('Please select a cylinder size before starting the test.', 'Quick Test');
        return;
    }
    var taps;
    if (window._quickStepTaps && window._quickStepTaps.length === stepCount) {
        taps = window._quickStepTaps.slice();
    } else if (qmode === 'CUSTOM') {
        var qtotalEl2 = document.getElementById('quick-custom-total-taps');
        var qtotal2 = qtotalEl2 ? parseInt(qtotalEl2.value, 10) : 0;
        taps = distributeTotalTaps(qtotal2, stepCount);
        if (!taps) {
            showAppModal('Enter total taps (at least ' + stepCount + ', one tap per step).', 'Quick Test');
            return;
        }
    } else {
        taps = computeStandardUspTaps(stepCount);
    }
    var uspLabel = qmode === 'USP1' ? 'USP 1' : (qmode === 'USP2' ? 'USP 2' : 'Custom');
    var steps = [];
    for (var s = 0; s < stepCount; s++) {
        steps.push({ speed: speed, dropHeight: dropHeight, tapCount: taps[s] });
    }
    var recipe = {
        productName: productName || 'Quick Test',
        batchNumber: batchNumber || '--',
        speed: speed,
        dropHeight: dropHeight,
        stepCount: stepCount,
        sampleVolumeMl: sampleVolumeMl,
        usp: uspLabel,
        uspMode: qmode,
        steps: steps
    };
    if (qmode === 'CUSTOM') {
        var qte = document.getElementById('quick-custom-total-taps');
        recipe.customTotalTaps = qte ? parseInt(qte.value, 10) : taps.reduce(function (a, b) { return a + b; }, 0);
    }
    startTestRun(recipe);
}

function getTestRunSteps() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return null;
    if (recipe.steps && recipe.steps.length > 0) return recipe.steps;
    var n = Math.max(1, parseInt(recipe.stepCount, 10) || 10);
    var steps = [];
    for (var i = 0; i < n; i++) {
        steps.push({ tapCount: (i === 0) ? 10 : (i === 1) ? 500 : 1250 });
    }
    return steps;
}

function setRunCard(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function showTestRunStepCompleteModal(isFinalStep) {
    var stepNum = testRunCurrentStepIndex + 1;
    var total = testRunTotalSteps;
    var finalStep = !!isFinalStep;

    var heading = document.getElementById('test-run-step-complete-heading');
    if (heading) heading.textContent = finalStep ? 'Final step complete' : 'Step complete';

    var msg = document.getElementById('test-run-step-complete-message');
    if (msg) {
        msg.textContent = finalStep
            ? ('Step ' + stepNum + ' of ' + total + ' finished. Review the volume change below, then continue to save the report or save and complete to reports.')
            : ('Step ' + stepNum + ' of ' + total + ' finished. Review the volume change below, then continue to the next step or save and complete to reports.');
    }

    var detail = document.getElementById('test-run-step-complete-volume-detail');
    if (detail) {
        var prev = testRunLastStepPreviousMl;
        var curr = testRunLastStepCurrentMl;
        var delta = testRunLastStepVolumeDeltaMl;
        var lines = [];
        if (prev != null && !isNaN(prev)) lines.push('Previous reading: ' + _formatDensity(prev) + ' ml');
        if (curr != null && !isNaN(curr)) lines.push('Current reading: ' + _formatDensity(curr) + ' ml');
        if (delta != null && !isNaN(delta)) {
            lines.push('Δ Volume (previous − current): ' + _formatDensity(delta) + ' ml');
        } else if (lines.length) {
            lines.push('Δ Volume: —');
        } else {
            lines.push('Δ Volume: —');
        }
        detail.textContent = lines.join('\n');
    }

    var contBtn = document.getElementById('test-run-step-continue-btn');
    if (contBtn) contBtn.textContent = finalStep ? 'Finish test' : 'Continue';

    var overlay = document.getElementById('test-run-step-complete-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeTestRunStepCompleteModal() {
    var overlay = document.getElementById('test-run-step-complete-overlay');
    if (overlay) overlay.style.display = 'none';
}

function recordCurrentStepResult() {
    var bulkEl = document.getElementById('run-bulk-density');
    var tapEl = document.getElementById('run-tap-density');
    var resultEl = document.getElementById('run-result');

    var bulkDensity = bulkEl ? bulkEl.textContent : '--';
    var tapDensity = tapEl ? tapEl.textContent : '--';
    var resultText = resultEl ? resultEl.textContent : '--';
    var vol = (testRunStepVolumes && testRunStepVolumes[testRunCurrentStepIndex] != null) ? testRunStepVolumes[testRunCurrentStepIndex] : '';

    var entry = {
        stepIndex: testRunCurrentStepIndex,
        volumeMl: vol,
        volumeDeltaMl: _pendingStepVolumeDeltaMl,
        bulkDensity: bulkDensity,
        tapDensity: tapDensity,
        resultText: resultText
    };
    testRunStepResults.push(entry);
    renderTestRunResultsTable();
}

function renderTestRunResultsTable() {
    var tbody = document.getElementById('test-run-results-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!testRunStepResults || testRunStepResults.length === 0) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="6">No step data yet.</td>';
        tbody.appendChild(emptyRow);
        return;
    }

    testRunStepResults.forEach(function (entry) {
        var tr = document.createElement('tr');
        var stepNumber = entry.stepIndex + 1;
        var vol = (entry.volumeMl != null && entry.volumeMl !== '') ? entry.volumeMl : '__';
        var dVol = '__';
        if (entry.volumeDeltaMl != null && !isNaN(entry.volumeDeltaMl)) dVol = _formatDensity(entry.volumeDeltaMl);
        tr.innerHTML =
            '<td>' + stepNumber + '</td>' +
            '<td>' + vol + '</td>' +
            '<td>' + dVol + '</td>' +
            '<td>' + entry.bulkDensity + '</td>' +
            '<td>' + entry.tapDensity + '</td>' +
            '<td>' + entry.resultText + '</td>';
        tbody.appendChild(tr);
    });
}

function runTestRunTick() {
    if (testRunCurrentStepIndex >= testRunTotalSteps) return;
    var step = testRunSteps[testRunCurrentStepIndex];
    var target = parseInt(step.tapCount, 10) || 0;
    testRunCurrentTapCount++;
    setRunCard('run-tap-count-card', String(testRunCurrentTapCount));
        if (testRunCurrentTapCount >= target) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
        askVolumeForStep(testRunCurrentStepIndex).then(function (vol) {
            if (vol === null || vol === '') {
                startTestRunInterval();
                return false;
            }
            var curr = parseFloat(vol);
            if (isNaN(curr) || curr <= 0) {
                startTestRunInterval();
                return false;
            }

            var prev = testRunPreviousVolumeMl;
            testRunLastStepPreviousMl = prev;
            testRunLastStepCurrentMl = curr;
            if (prev != null && !isNaN(prev)) {
                testRunLastStepVolumeDeltaMl = prev - curr;
            } else {
                testRunLastStepVolumeDeltaMl = null;
            }
            testRunPreviousVolumeMl = curr;

            var initialVol = (testRunInitialVolumeMl != null && !isNaN(testRunInitialVolumeMl))
                ? testRunInitialVolumeMl
                : parseFloat(testRunStepVolumes[0]);
            var bulkD = computeBulkDensityGPerMl(testRunInitialWeightG, initialVol);
            var tapD = computeTapDensityGPerMl(testRunInitialWeightG, testRunStepVolumes[testRunCurrentStepIndex]);
            setRunCard('run-bulk-density', _formatDensity(bulkD));
            setRunCard('run-tap-density', _formatDensity(tapD));
            _pendingStepVolumeDeltaMl = testRunLastStepVolumeDeltaMl;
            recordCurrentStepResult();
            _pendingStepVolumeDeltaMl = null;
            return true;
        }).then(function (ok) {
            if (!ok) return;
            var isLastStep = (testRunCurrentStepIndex + 1) >= testRunTotalSteps;
            showTestRunStepCompleteModal(isLastStep);
        });
    }
}

function startTestRunInterval() {
    setRunCard('run-current-step-card', String(testRunCurrentStepIndex + 1));
    setRunCard('run-tap-count-of-card', 'of ' + (testRunSteps[testRunCurrentStepIndex] && testRunSteps[testRunCurrentStepIndex].tapCount));
    setRunCard('run-tap-count-card', '0');
    testRunCurrentTapCount = 0;
    testRunIntervalId = setInterval(runTestRunTick, 30);
}

function runTestRunSimulation() {
    var steps = getTestRunSteps();
    if (!steps || steps.length === 0) return;
    testRunSteps = steps;
    testRunTotalSteps = steps.length;
    testRunCurrentStepIndex = 0;
    testRunCurrentTapCount = 0;
    testRunStepResults = [];
    renderTestRunResultsTable();
    startTestRunInterval();
}

function buildTestRunReportPayload() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return null;
    var completedSteps = Math.min(testRunCurrentStepIndex + 1, testRunTotalSteps);
    var now = new Date().toISOString();
    var testData = {
        recipe: recipe,
        productName: recipe.productName,
        batchNumber: recipe.batchNumber,
        status: 'completed',
        completedSteps: completedSteps,
        steps: recipe.steps || testRunSteps,
        stepCount: recipe.stepCount || testRunTotalSteps,
        stepResults: testRunStepResults,
        sampleVolumeMl: recipe.sampleVolumeMl,
        initialWeightG: testRunInitialWeightG,
        usp: recipe.usp,
        createdAt: now,
        completedAt: now
    };
    return {
        name: 'Test Report - ' + (recipe.productName || 'Tap Density Apparatus Test'),
        type: 'test',
        recipe: recipe,
        testData: testData,
        createdAt: now,
        completedAt: now
    };
}

var _abortSaveInFlight = false;
function abortTestRunAndSave() {
    if (_abortSaveInFlight) return;
    _abortSaveInFlight = true;

    // Stop any ongoing tick immediately
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    closeTestRunStepCompleteModal();
    cancelTestRunVolume();

    // Set UI to aborted
    setRunCard('run-status-text', 'Aborted');
    setRunCard('run-status-subtext', 'Test stopped');

    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }
    testRunButtonState = 'start';

    var payload = buildTestRunReportPayload();
    if (!payload) {
        _abortSaveInFlight = false;
        goToPage('reports');
        return;
    }

    // Override status + completed steps to reflect actual recorded steps
    var completedSteps = (testRunStepResults && testRunStepResults.length) ? testRunStepResults.length : 0;
    payload.testData = payload.testData || {};
    payload.testData.status = 'aborted';
    payload.testData.completedSteps = completedSteps;
    payload.completedAt = new Date().toISOString();
    payload.testData.completedAt = payload.completedAt;

    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            _abortSaveInFlight = false;
            var reportId = (result && result.id) ? result.id : null;
            if (reportId) {
                _saveReportPdfSilent(reportId);
                openReportPreview(reportId);
            } else {
                goToPage('reports');
                if (typeof loadReports === 'function') loadReports();
            }
        })
        .catch(function (err) {
            _abortSaveInFlight = false;
            console.error('Abort save report failed', err);
            showAppModal('Failed to save aborted report.', 'Report');
            goToPage('reports');
        });
}

function saveTestRunReportAndGoToReportPreview() {
    var payload = buildTestRunReportPayload();
    if (!payload) {
        if (testRunIntervalId != null) {
            clearInterval(testRunIntervalId);
            testRunIntervalId = null;
        }
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            setRunCard('run-status-text', 'Completed');
            setRunCard('run-status-subtext', 'Report saved');
            var btn = document.getElementById('btn-test-start-abort');
            if (btn) {
                btn.className = 'btn-ctrl start';
                btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
                btn.classList.remove('danger');
            }
            testRunButtonState = 'start';
            var reportId = (result && result.id) ? result.id : null;
            if (reportId) {
                _saveReportPdfSilent(reportId);
                _pendingTestRunReportId = reportId;
                openTestRunCompletionApprovalModal();
            } else {
                goToPage('reports');
                if (typeof loadReports === 'function') loadReports();
            }
        })
        .catch(function (err) {
            console.error('Save report failed', err);
            showAppModal('Failed to save report.', 'Report');
        });
}

function saveTestRunReportAndGoToReports() {
    var payload = buildTestRunReportPayload();
    if (!payload) {
        closeTestRunStepCompleteModal();
        if (testRunIntervalId != null) {
            clearInterval(testRunIntervalId);
            testRunIntervalId = null;
        }
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            setRunCard('run-status-text', 'Saved');
            setRunCard('run-status-subtext', 'Report saved');
            var btn = document.getElementById('btn-test-start-abort');
            if (btn) {
                btn.className = 'btn-ctrl start';
                btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
                btn.classList.remove('danger');
            }
            testRunButtonState = 'start';
            var reportId = (result && result.id) ? result.id : null;
            if (reportId) {
                _saveReportPdfSilent(reportId);
                _pendingTestRunReportId = reportId;
                openTestRunCompletionApprovalModal();
            } else {
                goToPage('reports');
                if (typeof loadReports === 'function') loadReports();
            }
        })
        .catch(function (err) {
            console.error('Save report failed', err);
            showAppModal('Failed to save report.', 'Report');
        });
}

function confirmTestRunStepContinue() {
    var isFinal = (testRunCurrentStepIndex + 1) >= testRunTotalSteps;
    if (isFinal) {
        closeTestRunStepCompleteModal();
        saveTestRunReportAndGoToReportPreview();
        return;
    }
    closeTestRunStepCompleteModal();
    var volInput = document.getElementById('test-run-volume-input');
    if (volInput) volInput.value = '';
    // Move to next step
    testRunCurrentStepIndex++;
    // Resume ticking for the new step if currently running
    if (testRunButtonState === 'abort' && testRunIntervalId == null) {
        startTestRunInterval();
    }
}

function confirmTestRunStepSave() {
    closeTestRunStepCompleteModal();
    saveTestRunReportAndGoToReports();
}

function toggleTestRunState() {
    var btn = document.getElementById('btn-test-start-abort');
    var statusText = document.getElementById('run-status-text');
    var statusSubtext = document.getElementById('run-status-subtext');
    if (testRunButtonState === 'start') {
        if (btn) btn.disabled = true;
        openTestRunInitialWeightModal().then(function (weightVal) {
            if (btn) btn.disabled = false;
            if (weightVal === null || weightVal === '') return null;
            var n = parseFloat(weightVal);
            if (isNaN(n) || n <= 0) return null;
            testRunInitialWeightG = n;
            return askVolumeForStep(0);
        }).then(function (vol0) {
            if (testRunInitialWeightG == null) return;
            if (vol0 === null || vol0 === '') return;
            var v0n = parseFloat(vol0);
            if (!isNaN(v0n) && v0n > 0) {
                testRunInitialVolumeMl = v0n;
                testRunPreviousVolumeMl = v0n;
            } else {
                testRunInitialVolumeMl = null;
                testRunPreviousVolumeMl = null;
            }
            // Show the entered initial weight/volume in the header.
            var initVolEl = document.getElementById('run-sample-volume');
            if (initVolEl) initVolEl.textContent = String(vol0);
            var initWeightEl = document.getElementById('run-initial-weight');
            if (initWeightEl) initWeightEl.textContent = String(testRunInitialWeightG);
            var bulkD = computeBulkDensityGPerMl(testRunInitialWeightG, vol0);
            setRunCard('run-bulk-density', _formatDensity(bulkD));
            setRunCard('run-tap-density', '--');

            testRunButtonState = 'abort';
            if (btn) {
                btn.disabled = false;
                btn.className = 'btn-ctrl danger';
                btn.innerHTML = '<span class="ctrl-icon">&#9726;</span><span>ABORT</span>';
            }
            if (statusText) statusText.textContent = 'Running';
            if (statusSubtext) statusSubtext.textContent = 'Test in progress';
            runTestRunSimulation();
        }).catch(function (err) {
            if (btn) btn.disabled = false;
            showAppModal('Test run failed: ' + (err && err.message ? err.message : 'Error'), 'Test Run');
        });
    } else {
        showConfirmModal('Test is running. Do you want to abort?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            abortTestRunAndSave();
        });
    }
}

function openRecipeActionsModal(recipeId) {
    window._recipeActionsId = recipeId;
    var recipe = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    var titleEl = document.getElementById('recipe-actions-modal-title');
    if (titleEl) titleEl.textContent = (recipe && (recipe.productName || recipe.name)) ? (recipe.productName || recipe.name) : 'Recipe';
    var apprBtn = document.getElementById('recipe-action-approve-btn');
    if (apprBtn) {
        var st = recipe ? recipe.recipeApprovalStatus : null;
        var showAppr = !!(recipe && st === 'pending' && userCanApproveByQaRule());
        apprBtn.style.display = showAppr ? '' : 'none';
    }
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeActionsModal() {
    window._recipeActionsId = null;
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmRecipeAction(action) {
    var id = window._recipeActionsId;
    closeRecipeActionsModal();
    if (id == null) return;
    if (action === 'edit') {
        editRecipe(id);
    } else if (action === 'disable') {
        disableRecipe(id);
    } else if (action === 'load') {
        loadRecipeById(id);
    } else if (action === 'approve') {
        openRecipeApproveModal(id);
    }
}

function openRecipeApproveModal(recipeId) {
    window._recipeApproveId = recipeId;
    var ta = document.getElementById('recipe-approve-remarks');
    if (ta) ta.value = '';
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeApproveModal() {
    window._recipeApproveId = null;
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitRecipeApprove() {
    var id = window._recipeApproveId;
    if (id == null) return;
    var ta = document.getElementById('recipe-approve-remarks');
    var remarks = ta ? ta.value.trim() : '';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return;
            return apiRequest(API_BASE + '/api/data/recipes/' + id + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarks, approverName: name }
            }).then(function (data) {
                closeRecipeApproveModal();
                if (data && data.ok) {
                    showAppModal('Recipe approved.', 'Recipes');
                    loadManageRecipes();
                } else {
                    showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', 'Recipes');
                }
            });
        });
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Recipes');
    });
}

/** Opens credential modal and approves recipe; resolves { ok }, { cancelled: true }, or { ok: false }. */
function approveSavedRecipeWithCredentials(recipeId, modalTitle, remarks) {
    var title = modalTitle || 'Recipes';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    var remarksStr = remarks != null ? String(remarks).trim() : '';
    var rid = parseInt(recipeId, 10);
    if (isNaN(rid) || rid < 1) {
        showAppModal('Invalid recipe id for approval.', title);
        return Promise.resolve({ ok: false });
    }
    return refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return { cancelled: true };
            return apiRequest(API_BASE + '/api/data/recipes/' + rid + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarksStr, approverName: name }
            }).then(function (data) {
                if (data && data.ok) {
                    showAppModal('Recipe approved.', title);
                    loadManageRecipes();
                    return { ok: true };
                }
                showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', title);
                return { ok: false };
            });
        });
    }).catch(function (err) {
        var msg = err && err.message ? String(err.message) : 'Error';
        if (msg.toLowerCase() === 'forbidden') {
            msg += ' — restart the Tap Density Apparatus server after updating, or hard-refresh the page (cached UI).';
        }
        showAppModal('Approval failed: ' + msg, title);
        return { ok: false };
    });
}

function editRecipe(id) {
    window.currentEditingRecipeId = id;
    goToPage('create-recipe-step1');
}

function loadRecipeForEdit() {
    var id = window.currentEditingRecipeId;
    if (!id) return;
    apiRequest(API_BASE + '/api/data/recipes/' + id).then(function (data) {
        var r = data.recipe || data;
        if (!r) return;
        var nameEl = document.getElementById('recipe-product-name');
        if (nameEl) nameEl.value = r.productName || r.name || '';
        var mode = String(r.uspMode || '').toUpperCase();
        if (!mode) {
            if (String(r.usp || '').toLowerCase().indexOf('2') >= 0) mode = 'USP2';
            else if (String(r.usp || '').toLowerCase().indexOf('custom') >= 0) mode = 'CUSTOM';
            else mode = 'USP1';
        }
        var modeRadio = document.querySelector('input[name="create-usp-mode"][value="' + mode + '"]');
        if (!modeRadio) modeRadio = document.querySelector('input[name="create-usp-mode"][value="USP1"]');
        if (modeRadio) modeRadio.checked = true;
        applyCreateUspModeToSpeedHeight();
        var speed = parseInt(r.speed, 10);
        if (isNaN(speed) && r.steps && r.steps[0] && r.steps[0].speed != null) speed = parseInt(r.steps[0].speed, 10);
        if (isNaN(speed)) speed = 300;
        var speedRadio = document.querySelector('input[name="create-speed"][value="' + speed + '"]');
        if (!speedRadio && (r.usp === 'USP 2' || speed === 250)) speedRadio = document.querySelector('input[name="create-speed"][value="250"]');
        if (!speedRadio) speedRadio = document.querySelector('input[name="create-speed"][value="300"]');
        if (speedRadio) speedRadio.checked = true;
        var dropHeight = parseFloat(r.dropHeight);
        if (isNaN(dropHeight) && r.steps && r.steps[0] && r.steps[0].dropHeight != null) dropHeight = parseFloat(r.steps[0].dropHeight);
        if (isNaN(dropHeight)) dropHeight = 14;
        var heightVal = dropHeight <= 5 ? '3' : '14';
        var heightRadio = document.querySelector('input[name="create-height"][value="' + heightVal + '"]');
        if (heightRadio) heightRadio.checked = true;
        var stepCount = Math.max(1, parseInt(r.stepCount, 10) || (r.steps && r.steps.length) || 10);
        var stepEl = document.getElementById('create-recipe-step-count');
        if (stepEl) {
            stepEl.value = String(stepCount);
            if (stepEl.options[stepCount - 1]) stepEl.value = String(stepCount);
        }
        var totalEl = document.getElementById('create-custom-total-taps');
        if (totalEl) {
            if (r.customTotalTaps != null) {
                totalEl.value = String(r.customTotalTaps);
            } else if (r.steps && r.steps.length && mode === 'CUSTOM') {
                var sum = 0;
                for (var si = 0; si < r.steps.length; si++) sum += parseInt(r.steps[si].tapCount, 10) || 0;
                totalEl.value = sum > 0 ? String(sum) : '';
            } else {
                totalEl.value = '';
            }
        }
        updateCreateRecipeContinueButton();
    }).catch(function () {});
}

function disableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id, { method: 'DELETE' }).then(function () {
        try {
            // Keep a local list of disabled recipes so the Disable page only shows those
            var disabled = [];
            try {
                var raw = localStorage.getItem('disabledRecipes');
                if (raw) disabled = JSON.parse(raw) || [];
            } catch (e) {}

            var recipe = null;
            if (Array.isArray(lastDisplayedRecipes)) {
                recipe = lastDisplayedRecipes.find(function (r) { return r.id === id; }) || null;
            }

            if (recipe) {
                var entry = {
                    id: recipe.id,
                    name: recipe.productName || recipe.name || '--',
                    cylinderVolume: (recipe.cylinder && (recipe.cylinder.volume || recipe.cylinder.volumeMl)) || null,
                    stepsCount: recipe.stepCount || (recipe.steps && recipe.steps.length) || null
                };
                // Avoid duplicates
                disabled = disabled.filter(function (d) { return d.id !== entry.id; });
                disabled.push(entry);
                localStorage.setItem('disabledRecipes', JSON.stringify(disabled));
            }
        } catch (e) {}

        loadManageRecipes();
        showAppModal('Recipe disabled.', 'Disable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to disable recipe.';
        showAppModal(msg, 'Disable Recipe');
    });
}

function loadRecipeById(recipeId) {
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'Load Recipe');
            return;
        }
        pendingRecipeToLoad = r;
        openBatchNumberModal();
    }).catch(function (err) {
        showAppModal('Recipe not found or failed to load.', 'Load Recipe');
    });
}

function openBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    var input = document.getElementById('load-recipe-batch-input');
    if (overlay) overlay.style.display = 'flex';
    if (input) {
        input.value = pendingRecipeToLoad && pendingRecipeToLoad.batchNumber ? pendingRecipeToLoad.batchNumber : '';
        input.focus();
    }
}

function closeBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    var input = document.getElementById('load-recipe-batch-input');
    if (input) input.value = '';
    pendingRecipeToLoad = null;
}

function confirmBatchNumberAndLoad() {
    var input = document.getElementById('load-recipe-batch-input');
    var batch = input ? input.value.trim() : '';
    if (!pendingRecipeToLoad) {
        closeBatchNumberModal();
        return;
    }
    if (getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'pending') {
        showAppModal('This recipe is pending QA approval and cannot be loaded for testing.', 'Load Recipe');
        return;
    }
    var recipe = Object.assign({}, pendingRecipeToLoad);
    recipe.batchNumber = batch || '--';
    closeBatchNumberModal();
    startTestRun(recipe);
}

function updateCreateRecipeContinueButton() {
    var nameEl = document.getElementById('recipe-product-name');
    var recipeName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var mode = getCreateUspMode();
    var speedRadio = document.querySelector('input[name="create-speed"]:checked');
    var heightRadio = document.querySelector('input[name="create-height"]:checked');
    var btn = document.getElementById('create-recipe-continue-btn');

    var needSpeedHeight = mode === 'CUSTOM';
    var speedOk = needSpeedHeight ? !!speedRadio : true;
    var heightOk = needSpeedHeight ? !!heightRadio : true;
    var customOk = true;
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var tv = totalEl ? parseInt(totalEl.value, 10) : 0;
        customOk = !isNaN(tv) && tv >= 1;
    }
    var canContinue = !!(recipeName && speedOk && heightOk && customOk);
    if (btn) {
        btn.disabled = !canContinue;
    }

    var summaryEl = document.getElementById('create-recipe-continue-summary');
    if (summaryEl) {
        if (mode === 'USP1') {
            summaryEl.textContent = 'USP 1 — 300 Taps/Min, 14 mm drop height';
        } else if (mode === 'USP2') {
            summaryEl.textContent = 'USP 2 — 250 Taps/Min, 3 mm drop height';
        } else if (speedRadio && heightRadio) {
            summaryEl.textContent =
                'Custom — Speed: ' + speedRadio.value + ' Taps/Min, Height: ' + heightRadio.value + ' mm';
        } else {
            summaryEl.textContent = 'Custom — select speed and height';
        }
    }
}

function openCreateRecipeContinueModal() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) return;
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeCreateRecipeContinueModal() {
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'none';
}

function updateCreateRecipeStepsView() {
    var n = (typeof window.currentRecipeStepCount === 'number' && window.currentRecipeStepCount > 0)
        ? window.currentRecipeStepCount
        : 10;

    var taps = window._createRecipeStepTaps;
    if (!taps || taps.length !== n) {
        taps = computeStandardUspTaps(n);
    }

    var note = document.getElementById('create-recipe-steps-note');
    if (note) {
        var mode = getCreateUspMode();
        if (mode === 'CUSTOM') {
            note.textContent =
                'Configuring ' + n + ' step' + (n === 1 ? '' : 's') + ' — custom total taps split as below.';
        } else {
            note.textContent =
                'Configuring ' + n + ' step' + (n === 1 ? '' : 's') +
                ' (Step 1: 10 taps, Step 2: 500 taps, remaining: 1250 taps).';
        }
    }

    for (var i = 1; i <= 10; i++) {
        var row = document.getElementById('create-recipe-step-row-' + i);
        if (!row) continue;
        row.style.display = i <= n ? '' : 'none';
        if (i <= n) {
            var spans = row.querySelectorAll('span');
            if (spans.length >= 2) {
                spans[1].textContent = String(taps[i - 1] != null ? taps[i - 1] : '');
            }
        }
    }
}

function confirmCreateRecipeContinue() {
    var stepCountEl = document.getElementById('create-recipe-step-count');
    var stepCount = stepCountEl ? parseInt(stepCountEl.value, 10) || 10 : 10;
    var taps = computeCreateRecipeStepTapsForStepCount(stepCount);
    if (getCreateUspMode() === 'CUSTOM' && !taps) {
        showAppModal('Enter total taps (at least ' + stepCount + ', one tap per step).', 'Create Recipe');
        return;
    }
    window._createRecipeStepTaps = taps || computeStandardUspTaps(stepCount);
    window.currentRecipeStepCount = stepCount;
    closeCreateRecipeContinueModal();
    updateCreateRecipeStepsView();
    goToPage('create-recipe-step2');
}

function goToCreateRecipeStepsPage() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) {
        showAppModal('Enter the recipe name and select procedure (and speed/height for Custom) before continuing.', 'Create Recipe');
        return;
    }
    var stepCount = (typeof window.currentRecipeStepCount === 'number' && window.currentRecipeStepCount > 0)
        ? window.currentRecipeStepCount
        : 10;
    var stepCountEl = document.getElementById('create-recipe-step-count');
    if (stepCountEl) stepCountEl.value = String(stepCount);
    var taps = computeCreateRecipeStepTapsForStepCount(stepCount);
    if (getCreateUspMode() === 'CUSTOM' && !taps) {
        taps = computeStandardUspTaps(stepCount);
    }
    window._createRecipeStepTaps = (taps && taps.length === stepCount) ? taps : computeStandardUspTaps(stepCount);
    window.currentRecipeStepCount = stepCount;
    goToPage('create-recipe-step2');
    setTimeout(renderCreateRecipeStepInputsPage, 50);
}

function renderCreateRecipeStepInputsPage() {
    var container = document.getElementById('create-recipe-step-inputs');
    if (!container) return;
    var stepCountEl = document.getElementById('create-recipe-step-count');
    var stepCount = stepCountEl ? parseInt(stepCountEl.value, 10) || 10 : 10;
    if (stepCount < 1) stepCount = 1;
    if (stepCount > 10) stepCount = 10;

    var existingTaps = window._createRecipeStepTaps;
    var defaultTaps = computeCreateRecipeStepTapsForStepCount(stepCount) || computeStandardUspTaps(stepCount);
    var taps;
    if (existingTaps && existingTaps.length === stepCount) {
        taps = existingTaps.slice();
    } else {
        taps = defaultTaps.slice();
    }
    window._createRecipeStepTaps = taps;
    window.currentRecipeStepCount = stepCount;

    container.innerHTML = '';
    for (var i = 0; i < stepCount; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="create-recipe-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="create-recipe-step-tap-' + stepNum + '" ' +
                'class="input-field create-recipe-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (taps[i] != null ? taps[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)" ' +
                'oninput="_onCreateRecipeStepTapInput(this)">';
        container.appendChild(group);
    }
}

function _onCreateRecipeStepTapInput(inputEl) {
    if (!inputEl) return;
    var idx = parseInt(inputEl.getAttribute('data-step-index'), 10);
    if (isNaN(idx) || idx < 0) return;
    var v = parseInt(inputEl.value, 10);
    if (!window._createRecipeStepTaps) window._createRecipeStepTaps = [];
    window._createRecipeStepTaps[idx] = isNaN(v) ? 0 : v;
}

function goToCreateRecipeCylinderPage() {
    var container = document.getElementById('create-recipe-step-inputs');
    var stepCountEl = document.getElementById('create-recipe-step-count');
    var stepCount = stepCountEl ? parseInt(stepCountEl.value, 10) || 10 : 10;
    var taps = [];
    if (container) {
        var inputs = container.querySelectorAll('input.create-recipe-step-tap');
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Create Recipe');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
    }
    if (taps.length !== stepCount) {
        showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Create Recipe');
        return;
    }
    window._createRecipeStepTaps = taps;
    window.currentRecipeStepCount = stepCount;
    goToPage('create-recipe-step3');
}

function getRecipes() {
    return apiRequest(API_BASE + '/api/data/recipes', {
        method: 'GET'
    }).then(function (data) {
        return (data && data.recipes) ? data.recipes : [];
    }).catch(function (err) {
        console.error('Failed to fetch recipes:', err);
        return [];
    });
}

function loadViewRecipes() {
    var tbody = document.getElementById('view-recipes-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    getRecipes().then(function (recipes) {
        if (!recipes.length) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="2">No recipes.</td>';
            tbody.appendChild(tr);
            return;
        }
        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td class="view-col"><button class="reports-open-btn view-recipe-btn" onclick="openRecipePrintPreview(' + (r.id || 0) + ')" title="View">View</button></td>';
            tbody.appendChild(tr);
        });
    }).catch(function () {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">Unable to load recipes.</td>';
        tbody.appendChild(tr);
    });
}

function recipeDropHeightMm(r) {
    if (!r) return null;
    if (r.dropHeight != null && r.dropHeight !== '') {
        var d = parseFloat(r.dropHeight);
        return isNaN(d) ? null : d;
    }
    if (r.steps && r.steps[0] && r.steps[0].dropHeight != null && r.steps[0].dropHeight !== '') {
        var d2 = parseFloat(r.steps[0].dropHeight);
        return isNaN(d2) ? null : d2;
    }
    return null;
}

function recipeTotalTapCount(r) {
    if (!r || !r.steps || !r.steps.length) return null;
    var total = 0;
    for (var i = 0; i < r.steps.length; i++) {
        total += parseInt(r.steps[i].tapCount, 10) || 0;
    }
    return total;
}

function recipeTapSpeed(r) {
    if (!r) return null;
    if (r.speed != null && r.speed !== '') {
        var s = parseInt(r.speed, 10);
        return isNaN(s) ? null : s;
    }
    if (r.steps && r.steps[0] && r.steps[0].speed != null && r.steps[0].speed !== '') {
        var s2 = parseInt(r.steps[0].speed, 10);
        return isNaN(s2) ? null : s2;
    }
    return null;
}

function loadManageRecipes() {
    var msgEl = document.getElementById('manage-recipes-message');
    var tableEl = document.querySelector('.manage-recipes-table');
    var tbody = document.getElementById('manage-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    refreshActiveQaCount();

    getRecipes().then(function (recipes) {
        var mode = recipeListMode === 'load' ? 'load' : 'manage';
        var createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
        if (createBtn) createBtn.style.display = (mode === 'load') ? 'none' : '';

        // Adjust header to match mode (Actions vs Load).
        if (tableEl) {
            var headRow = tableEl.querySelector('thead tr');
            if (headRow) {
                if (mode === 'load') {
                    headRow.innerHTML =
                        '<th>Product</th>' +
                        '<th>Cylinder</th>' +
                        '<th>Steps</th>' +
                        '<th>Height (mm)</th>' +
                        '<th>Tap speed</th>' +
                        '<th class="actions-col">Load</th>';
                } else {
                    headRow.innerHTML =
                        '<th>Product</th>' +
                        '<th>Cylinder</th>' +
                        '<th>Steps</th>' +
                        '<th>Height (mm)</th>' +
                        '<th>Tap speed</th>' +
                        '<th>Approval</th>' +
                        '<th class="actions-col">Actions</th>';
                }
            }
        }

        if (mode === 'load') {
            recipes = (recipes || []).filter(function (r) { return getEffectiveRecipeApprovalStatus(r) === 'approved'; });
        }

        if (!recipes.length) {
            if (msgEl) msgEl.style.display = '';
            if (tableEl) tableEl.style.display = 'none';
            if (mode === 'load' && msgEl) {
                msgEl.textContent = 'No approved recipes available.';
            }
            return;
        }

        lastDisplayedRecipes = recipes;
        if (msgEl) msgEl.style.display = 'none';
        if (tableEl) tableEl.style.display = '';

        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            var cylVol = '';
            if (r.cylinder && (r.cylinder.volume != null || r.cylinder.volumeMl != null)) {
                cylVol = (r.cylinder.volume || r.cylinder.volumeMl) + ' ml';
            } else {
                cylVol = '--';
            }
            var stepsCount = r.stepCount || (r.steps && r.steps.length) || '--';
            var dh = recipeDropHeightMm(r);
            var heightStr = (dh != null && !isNaN(dh)) ? String(dh) : '--';
            var speed = recipeTapSpeed(r);
            var speedStr = (speed != null) ? (String(speed) + ' Taps/Min') : '--';

            if (mode === 'load') {
                var loadBtnHtml = '<button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + cylVol + '</td>' +
                    '<td>' + stepsCount + '</td>' +
                    '<td>' + heightStr + '</td>' +
                    '<td>' + speedStr + '</td>' +
                    '<td class="actions-cell actions-col">' + loadBtnHtml + '</td>';
            } else {
                var appr = getEffectiveRecipeApprovalStatus(r);
                var apprLabel = appr === 'pending' ? 'Pending' : 'Approved';
                var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Edit / Delete / Load">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + cylVol + '</td>' +
                    '<td>' + stepsCount + '</td>' +
                    '<td>' + heightStr + '</td>' +
                    '<td>' + speedStr + '</td>' +
                    '<td>' + apprLabel + '</td>' +
                    '<td class="actions-cell">' +
                        actionsBtnHtml +
                    '</td>';
            }

            tbody.appendChild(tr);
        });
    });
}

function loadDisableRecipes() {
    var msgEl = document.getElementById('disable-recipes-message');
    var tableEl = document.querySelector('#page-disable-recipes .manage-recipes-table');
    var tbody = document.getElementById('disable-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    var disabled = [];
    try {
        var raw = localStorage.getItem('disabledRecipes');
        if (raw) disabled = JSON.parse(raw) || [];
    } catch (e) {}

    if (!disabled || !disabled.length) {
        if (msgEl) {
            msgEl.textContent = 'No disabled recipes.';
            msgEl.style.display = '';
        }
        if (tableEl) tableEl.style.display = 'none';
        return;
    }

    if (msgEl) msgEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';

    disabled.forEach(function (r) {
        var tr = document.createElement('tr');
        var name = r.name || '--';
        var cylVol = r.cylinderVolume != null ? (r.cylinderVolume + ' ml') : '--';
        var stepsCount = r.stepsCount || '--';
        tr.innerHTML =
            '<td>' + name + '</td>' +
            '<td>' + cylVol + '</td>' +
            '<td>' + stepsCount + '</td>';

        tbody.appendChild(tr);
    });
}

function completeRecipeFromStep2() {
    // Read from Step 1
    var nameEl = document.getElementById('recipe-product-name');
    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';

    var mode = getCreateUspMode();
    var speedRadio = document.querySelector('input[name="create-speed"]:checked');
    var heightRadio = document.querySelector('input[name="create-height"]:checked');
    var speed = speedRadio ? parseInt(speedRadio.value, 10) || 300 : null;
    var dropHeight = heightRadio ? parseFloat(heightRadio.value) || 14 : null;
    if (mode === 'USP1') {
        speed = 300;
        dropHeight = 14;
    } else if (mode === 'USP2') {
        speed = 250;
        dropHeight = 3;
    }

    // Cylinder (from step 3 if chosen; default 100 ml)
    var cylinderRadio = document.querySelector('input[name="create-cylinder"]:checked');
    var cylinderVolume = cylinderRadio ? parseFloat(cylinderRadio.value) || 100 : 100;

    var stepCount = (typeof window.currentRecipeStepCount === 'number' && window.currentRecipeStepCount > 0)
        ? window.currentRecipeStepCount
        : 10;

    if (!productName || speed == null || dropHeight == null) {
        showAppModal('Please complete recipe name, speed and height before saving.', 'Save Recipe');
        return;
    }

    var taps = window._createRecipeStepTaps;
    if (!taps || taps.length !== stepCount) {
        taps = computeCreateRecipeStepTapsForStepCount(stepCount);
    }
    if (mode === 'CUSTOM' && !taps) {
        showAppModal('Invalid custom tap total for this step count.', 'Save Recipe');
        return;
    }
    if (!taps || taps.length !== stepCount) {
        taps = computeStandardUspTaps(stepCount);
    }

    var steps = [];
    for (var i = 0; i < stepCount; i++) {
        steps.push({
            speed: speed,
            dropHeight: dropHeight,
            tapCount: taps[i]
        });
    }

    var uspLabel = mode === 'USP1' ? 'USP 1' : (mode === 'USP2' ? 'USP 2' : 'Custom');
    var recipe = {
        productName: productName,
        steps: steps,
        stepCount: stepCount,
        cylinder: { volume: cylinderVolume },
        createdAt: new Date().toISOString(),
        speed: speed,
        dropHeight: dropHeight,
        usp: uspLabel,
        uspMode: mode
    };
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var ct = totalEl ? parseInt(totalEl.value, 10) : 0;
        if (!isNaN(ct) && ct > 0) recipe.customTotalTaps = ct;
        else {
            var s2 = 0;
            for (var ti = 0; ti < taps.length; ti++) s2 += parseInt(taps[ti], 10) || 0;
            recipe.customTotalTaps = s2;
        }
    }
    var editId = window.currentEditingRecipeId;
    if (editId) {
        recipe.id = editId;
    }

    var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
    var method = editId ? 'PUT' : 'POST';
    apiRequest(url, {
        method: method,
        body: recipe
    }).then(function (result) {
        window.currentEditingRecipeId = null;
        var rid = (result && result.id != null) ? result.id : ((result && result.recipe && result.recipe.id != null) ? result.recipe.id : null);
        goToPage('manage-recipes');
        loadManageRecipes();
        if (rid != null) {
            var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
            if (role === 'factory') {
                showAppModal('Recipe saved and approved.', 'Save Recipe');
            } else {
                setTimeout(function () {
                    approveSavedRecipeWithCredentials(rid, 'Save Recipe', '').then(function (res) {
                        if (res && res.cancelled) {
                            showAppModal('Recipe saved. It stays pending until a QA or Admin approves it.', 'Save Recipe');
                        }
                    });
                }, 50);
            }
        } else {
            showAppModal('Recipe saved, but approval could not be started (missing recipe id).', 'Save Recipe');
        }
    }).catch(function (err) {
        console.error('Failed to save recipe:', err);
        var msg = (err && err.message) ? String(err.message) : 'Unknown error';
        showAppModal('Failed to save recipe: ' + msg, 'Save Recipe');
    });
}
function validationRunTick() {
    validationRunCurrentCount++;
    setValRunEl('val-run-tap-count', String(validationRunCurrentCount));
    if (validationRunCurrentCount >= validationRunExpected) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
        validationRunState = 'idle';
        stopValidationOnBackend().catch(function () {});
        setValRunEl('val-run-status', 'Completed');
        setValRunEl('val-run-status-sub', 'Validation run finished');
        var resultCard = document.getElementById('val-result-card');
        var resultEl = document.getElementById('val-run-result');
        var detailEl = document.getElementById('val-run-result-detail');
        var isPass = validationRunCurrentCount >= validationRunMin && validationRunCurrentCount <= validationRunMax;
        if (resultCard) resultCard.style.display = '';
        if (resultEl) resultEl.textContent = isPass ? 'Pass' : 'Fail';
        if (detailEl) detailEl.textContent = 'Expected ' + validationRunTarget + ' (+/- ' + validationRunTolerance + '), actual ' + validationRunCurrentCount + '.';
        var btn = document.getElementById('btn-validation-start-abort');
        var label = document.getElementById('btn-validation-label');
        if (btn) {
            btn.className = 'btn btn-primary validation-action-btn';
            btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
        }
        if (label) label.textContent = 'Start Validation';

        var usp = lastValidationType === 'load' ? 'USP 2' : 'USP 1';
        var tapsMin = lastValidationType === 'load' ? 250 : 300;
        var dropHeight = lastValidationType === 'load' ? 3 : 14;
        var user = window.currentUser || {};
        var reportPayload = {
            name: 'Validation - ' + (isPass ? 'Pass' : 'Fail'),
            type: 'validation',
            validationSubtype: lastValidationType,
            status: isPass ? 'Pass' : 'Fail',
            usp: usp,
            tapsMin: tapsMin,
            dropHeight: dropHeight,
            expectedTapCount: validationRunTarget,
            expectedTolerance: validationRunTolerance,
            expectedTapCountMin: validationRunMin,
            expectedTapCountMax: validationRunMax,
            actualTapCount: validationRunCurrentCount,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            testData: {
                usp: usp,
                tapsMin: tapsMin,
                dropHeight: dropHeight,
                expectedTapCount: validationRunTarget,
                expectedTolerance: validationRunTolerance,
                expectedTapCountMin: validationRunMin,
                expectedTapCountMax: validationRunMax,
                actualTapCount: validationRunCurrentCount,
                status: isPass ? 'Pass' : 'Fail',
                operatorName: user.name || user.username || '--',
                employeeId: user.username || '--',
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString()
            }
        };
        // mark completion for the procedure we just ran
        if (lastValidationType === 'distance' || lastValidationType === 'load') {
            validationCompletion[lastValidationType] = true;
        }

        apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
            .then(function (result) {
                // Do not close validation until BOTH USP 1 and USP 2 are completed.
                if (!isValidationFullyCompleted()) {
                    var missing = getMissingValidationLabel();
                    showAppModal('Validation saved. Please complete ' + missing + ' to close validation.', 'Validation');
                    goToPage('validate-type-select');
                    return;
                }

                var reportId = result && result.id;
                currentReportFilter = 'validation';
                if (reportId) {
                    _saveReportPdfSilent(reportId);
                    if (typeof openReportPreview === 'function') openReportPreview(reportId);
                    else goToPage('reports');
                } else {
                    goToPage('reports');
                }
            })
            .catch(function (err) {
                console.error('Failed to save validation report', err);
                currentReportFilter = 'validation';
                goToPage('reports');
            });
    }
}

function startValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    return apiRequest(API_BASE + '/api/hardware/validation/load/start', { method: 'POST' });
}

function stopValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    return apiRequest(API_BASE + '/api/hardware/validation/load/stop', { method: 'POST' });
}

function toggleValidationRunState() {
    if (validationRunBackendPending) return;
    if (validationRunState === 'idle') {
        var btn = document.getElementById('btn-validation-start-abort');
        var label = document.getElementById('btn-validation-label');
        validationRunBackendPending = true;
        if (btn) btn.disabled = true;
        setValRunEl('val-run-status', 'Starting');
        setValRunEl('val-run-status-sub', validationHardwareEnabled ? 'Waiting for hardware' : 'Starting');
        startValidationOnBackend().then(function (res) {
            if (!res || res.ok !== true) {
                throw new Error((res && (res.error || res.response)) || 'Hardware did not acknowledge start');
            }
            validationRunState = 'running';
            validationRunCurrentCount = 0;
            setValRunEl('val-run-tap-count', '0');
            setValRunEl('val-run-status', 'Running');
            setValRunEl('val-run-status-sub', 'Tap count in progress');
            var resultCard = document.getElementById('val-result-card');
            if (resultCard) resultCard.style.display = 'none';
            if (btn) {
                btn.className = 'btn btn-primary validation-action-btn danger';
                btn.innerHTML = '<span class="ctrl-icon">&#9726;</span><span id="btn-validation-label">Abort</span>';
            }
            if (label) label.textContent = 'Abort';
            validationRunIntervalId = setInterval(validationRunTick, 30);
        }).catch(function (err) {
            validationRunState = 'idle';
            setValRunEl('val-run-status', 'Ready');
            setValRunEl('val-run-status-sub', 'Failed to start hardware validation');
            showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
        }).finally(function () {
            validationRunBackendPending = false;
            if (btn) btn.disabled = false;
        });
    } else {
        validationRunBackendPending = true;
        var btn = document.getElementById('btn-validation-start-abort');
        if (btn) btn.disabled = true;
        stopValidationOnBackend().catch(function () {}).finally(function () {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        validationRunState = 'idle';
        setValRunEl('val-run-status', 'Aborted');
        setValRunEl('val-run-status-sub', 'Tap count: ' + validationRunCurrentCount);
        var label = document.getElementById('btn-validation-label');
        if (btn) {
            btn.className = 'btn btn-primary validation-action-btn';
            btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
            btn.disabled = false;
        }
        if (label) label.textContent = 'Start Validation';
            validationRunBackendPending = false;
        });
    }
}

function selectRole(roleName) {
    var hidden = document.getElementById('selected-role');
    if (hidden) {
        hidden.value = roleName;
    }
    var container = document.querySelector('.role-selection-container .role-options');
    if (container) {
        var buttons = container.querySelectorAll('.role-btn');
        var roleNorm = String(roleName || '').trim();
        buttons.forEach(function (btn) {
            btn.classList.remove('active');
            var btnRole = (btn.getAttribute('data-role') || '').trim();
            if (btnRole && btnRole === roleNorm) {
                btn.classList.add('active');
            }
        });
    }
    var permPanel = document.getElementById('add-member-permissions-panel');
    if (permPanel && permPanel.style.display !== 'none' && typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
}

function getStrongPasswordError(password) {
    var pwd = String(password || '');
    if (
        pwd.length >= 8 &&
        /[A-Z]/.test(pwd) &&
        /[a-z]/.test(pwd) &&
        /[0-9]/.test(pwd) &&
        /[^A-Za-z0-9]/.test(pwd)
    ) {
        return '';
    }
    return (
        'Password must meet all of the following:\n\n' +
        '• At least 8 characters long.\n' +
        '• At least one uppercase letter (A–Z).\n' +
        '• At least one lowercase letter (a–z).\n' +
        '• At least one number (0–9).\n' +
        '• At least one symbol (not only letters and digits).\n\n' +
        'Update your password to satisfy every item, then try again.'
    );
}

function saveNewMember() {
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';

    if (!fullName || !username || !password || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Add Member');
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account and cannot be used.', 'Add Member');
        return;
    }
    if (password !== confirmPassword) {
        showAppModal('Password and Confirm Password do not match.', 'Add Member');
        return;
    }
    var passwordError = getStrongPasswordError(password);
    if (passwordError) {
        showAppModal(passwordError, 'Add Member');
        return;
    }

    var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
    var hasOverrides = (overrides.allow && overrides.allow.length) || (overrides.deny && overrides.deny.length);
    var sessionRole = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    if (hasOverrides && sessionRole !== 'factory' && sessionRole !== 'admin') {
        showAppModal('Only Factory or Admin can assign permission cards when creating a member.', 'Add Member');
        return;
    }

    var payload = {
        name: fullName,
        username: username,
        password: password,
        role: role,
        featureOverrides: {
            allow: (overrides.allow || []).slice(),
            deny: []
        }
    };

    var verifyOptions = {
        purpose: 'user_admin',
        titleText: 'Admin verification required',
        subtitleText: 'Enter Admin or Factory credentials to create this member.',
        usernameLabelText: 'Admin / Factory username',
        usernamePlaceholder: 'Enter Admin or Factory username',
        emptyCredentialsMessage: 'Enter Admin/Factory username and password.'
    };

    openApprovalVerifyModal(verifyOptions).then(function (token) {
        if (!token) return;
        apiRequest(API_BASE + '/api/data/members', {
            method: 'POST',
            headers: { 'X-Approval-Verify-Token': token },
            body: payload
        }).then(function (data) {
            if (data && data.id) {
                _addMemberLastSavedId = data.id;
                var savedMember = (data && data.member) ? data.member : {
                    id: data.id, name: fullName, username: username, role: role
                };
                _clearAddMemberForm();
                if (biometricEnabledSetting) {
                    _populateMemberBiometricSummary(savedMember);
                    goToPage('member-biometric');
                } else {
                    showAppModal('Member saved successfully.', 'Add Member');
                    goToPage('user-profile');
                }
            } else {
                showAppModal((data && data.error) || 'Failed to save member.', 'Add Member');
            }
        }).catch(function (err) {
            showAppModal('Failed to save member: ' + (err && err.message ? err.message : 'Network error'), 'Add Member');
        });
    }).catch(function (err) {
        showAppModal('Verification failed: ' + (err && err.message ? err.message : 'Error'), 'Add Member');
    });
}
function closeRoleModal() {
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentMemberIdForRoleEdit = null;
}

function openRoleModal(id) {
    if (!id) return;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var member = members.find(function (m) { return m.id === id; });
    if (!member) return;
    currentMemberIdForRoleEdit = id;
    var titleEl = document.getElementById('role-modal-title');
    var currentEl = document.getElementById('role-modal-current');
    if (titleEl) titleEl.textContent = 'Change Role for ' + (member.name || member.username || '');
    if (currentEl) currentEl.textContent = 'Current Role: ' + displayRoleLabel(member.role);
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function confirmRoleChange(newRole) {
    if (!currentMemberIdForRoleEdit) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-change-role', 'change')) {
            showAppModal('You do not have permission to change user roles.', 'Permission');
            closeRoleModal();
            return;
        }
    }
    var id = currentMemberIdForRoleEdit;
    apiRequest(API_BASE + '/api/data/members/' + id, {
        method: 'GET'
    }).then(function (data) {
        var member = data && data.member ? data.member : null;
        if (!member) throw new Error('Member not found');
        member.role = newRole;
        return apiRequest(API_BASE + '/api/data/members/' + id, {
            method: 'PUT',
            body: JSON.stringify(member)
        });
    }).then(function () {
        closeRoleModal();
        loadMembersAndRender();
    }).catch(function (err) {
        console.error('Failed to update member role', err);
        showAppModal('Failed to update role: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
    });
}

function disableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-delete', 'delete')) {
            showAppModal('You do not have permission to disable members.', 'Permission');
            return;
        }
    }
    showConfirmModal('Are you sure you want to disable this member?', 'Disable Member').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
            .then(function (data) {
                var member = (data && data.member) ? data.member : data;
                if (!member || member.id == null) throw new Error('Member not found');
                member.status = 'disabled';
                return apiRequest(API_BASE + '/api/data/members/' + id, {
                    method: 'PUT',
                    body: member
                });
            })
            .then(function () {
                loadMembersAndRender();
            })
            .catch(function (err) {
                console.error('Failed to disable member', err);
                showAppModal('Failed to disable member: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
            });
    });
}

// ----- Add Member: form, permission overrides, biometric enrollment -----
var _addMemberFeatureOverrides = { allow: [], deny: [] };
var _addMemberLastSavedId = null;

function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    var role = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    return role === 'factory' || role === 'admin';
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.style.display = show ? '' : 'none';
    if (show) renderAddMemberPermissionCards();
}

function renderAddMemberPermissionCards() {
    var grid = document.getElementById('permission-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var catalog = (typeof getPermissionCardCatalog === 'function')
        ? getPermissionCardCatalog()
        : ((typeof getFeatureCatalog === 'function') ? getFeatureCatalog() : []);
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    _addMemberFeatureOverrides.deny = [];
    catalog.forEach(function (feature) {
        var key = feature.key;
        if (_isProtectedFeatureKey(key)) return;
        var selected = _addMemberFeatureOverrides.allow.indexOf(key) !== -1;
        var accent = feature.accent != null ? feature.accent : 0;
        var card = document.createElement('div');
        card.className = 'permission-card' + (selected ? ' is-selected permission-card--accent-' + accent : '');
        card.setAttribute('data-feature-key', key);
        card.setAttribute('title', 'Tap to grant or remove access');
        card.innerHTML =
            '<div class="permission-card-title">' + feature.label + '</div>' +
            '<div class="permission-card-desc">' + (feature.description || '') + '</div>';
        card.addEventListener('click', function () { togglePermissionCardAllow(key); });
        grid.appendChild(card);
    });
}

function togglePermissionCardAllow(featureKey) {
    if (!featureKey || _isProtectedFeatureKey(featureKey)) return;
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    var i = _addMemberFeatureOverrides.allow.indexOf(featureKey);
    if (i === -1) _addMemberFeatureOverrides.allow.push(featureKey);
    else _addMemberFeatureOverrides.allow.splice(i, 1);
    _addMemberFeatureOverrides.deny = [];
    renderAddMemberPermissionCards();
}

function cyclePermissionCardState(featureKey) {
    togglePermissionCardAllow(featureKey);
}

function resetPermissionOverrides() {
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    renderAddMemberPermissionCards();
}

function setAllPermissionOverrides() {
    renderAddMemberPermissionCards();
}

function _clearAddMemberForm() {
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
}

function openAddMember() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        var who = (typeof window !== 'undefined' && window.currentUser) ? window.currentUser : role;
        if (!canPerformAction(who, 'user-add', 'create')) {
            showAppModal('You do not have permission to add new members.', 'Permission');
            return;
        }
    }
    _clearAddMemberForm();
    _refreshAddMemberPermissionsPanelVisibility();
    goToPage('add-member');
    setTimeout(function () {
        var f = document.getElementById('add-fullname');
        if (f) f.focus();
    }, 60);
}

function cancelAddMemberEdit() {
    _clearAddMemberForm();
    goToPage('user-profile');
}

function _populateMemberBiometricSummary(member) {
    if (!member) return;
    var nameEl = document.getElementById('member-biometric-name');
    var userEl = document.getElementById('member-biometric-username');
    var roleEl = document.getElementById('member-biometric-role');
    if (nameEl) nameEl.textContent = member.name || '--';
    if (userEl) userEl.textContent = member.username || '--';
    if (roleEl) {
        var roleLabel = (typeof displayRoleLabel === 'function')
            ? displayRoleLabel(member.role)
            : (member.role || '--');
        roleEl.textContent = roleLabel;
    }
}

function skipMemberBiometricEnrollment() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function backToMemberAfterBiometric() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function saveUserProfile() {
    var fullNameEl = document.getElementById('profile-fullname');
    var passwordEl = document.getElementById('profile-password');
    var newName = fullNameEl ? (fullNameEl.value || '').trim() : '';
    var newPassword = passwordEl ? (passwordEl.value || '') : '';
    if (newPassword) {
        var profilePasswordError = getStrongPasswordError(newPassword);
        if (profilePasswordError) {
            if (typeof showAppModal === 'function') showAppModal(profilePasswordError, 'User Profile');
            return;
        }
    }

    var user = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user) {
        if (typeof showAppModal === 'function') showAppModal('No user logged in.', 'User Profile');
        return;
    }

    var memberId = user.id;
    var isFactory = (memberId === 0 || memberId === undefined || memberId === null);

    function updateLocalName(name) {
        if (window.currentUser) window.currentUser.name = name;
        if (typeof currentUser !== 'undefined') { currentUser = currentUser || {}; currentUser.name = name; }
        try { localStorage.setItem('currentUser', JSON.stringify(window.currentUser || currentUser)); } catch (e) {}
        var displayEl = document.getElementById('profile-name-display');
        if (displayEl) displayEl.textContent = name || '---';
    }

    if (isFactory) {
        updateLocalName(newName || user.name || user.username || 'Factory');
        if (passwordEl) passwordEl.value = '';
        if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        return;
    }

    apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : data;
            if (!member || member.id == null) {
                if (typeof showAppModal === 'function') showAppModal('Member not found.', 'User Profile');
                return Promise.reject(new Error('Member not found'));
            }
            member.name = newName || member.name || member.username || '';
            if (newPassword) member.password = newPassword;
            return apiRequest(API_BASE + '/api/data/members/' + memberId, {
                method: 'PUT',
                body: member
            });
        })
        .then(function (result) {
            var updated = (result && result.member) ? result.member : result;
            var nameToSet = (updated && updated.name) ? updated.name : newName;
            updateLocalName(nameToSet || newName);
            if (passwordEl) passwordEl.value = '';
            if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        })
        .catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Failed to update profile.';
            if (typeof showAppModal === 'function') showAppModal(msg, 'User Profile');
        });
}

function initializeDatetime() {
    var dateInput = document.getElementById('edit-date');
    var timeInput = document.getElementById('edit-time');
    if (!dateInput || !timeInput) return;
    function applyToInputs(now) {
        if (!dateInput.value) {
            var day = String(now.getDate()).padStart(2, '0');
            var month = String(now.getMonth() + 1).padStart(2, '0');
            var year = now.getFullYear();
            dateInput.value = day + '-' + month + '-' + year;
        }
        if (!timeInput.value) {
            var hours = String(now.getHours()).padStart(2, '0');
            var minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = hours + ':' + minutes;
        }
    }
    fetchDateTimeFromBackend().then(function (data) {
        var now = null;
        if (data && data.datetime) {
            now = new Date(data.datetime.replace('Z', ''));
        }
        if (!now || isNaN(now.getTime())) {
            if (data && data.date && data.time) {
                var parts = (data.date || '').split('-');
                var tparts = (data.time || '').split(':');
                if (parts.length >= 3 && tparts.length >= 2) {
                    var d = parseInt(parts[0], 10);
                    var m = parseInt(parts[1], 10) - 1;
                    var y = parseInt(parts[2], 10);
                    var h = parseInt(tparts[0], 10) || 0;
                    var min = parseInt(tparts[1], 10) || 0;
                    now = new Date(y, m, d, h, min, 0);
                }
            }
        }
        if (!now || isNaN(now.getTime())) now = new Date();
        applyToInputs(now);
    }).catch(function () {
        applyToInputs(new Date());
    });
}

function openDatePickerForEditDate() {
    var textInput = document.getElementById('edit-date');
    var hiddenInput = document.getElementById('edit-date-picker-hidden');
    if (!textInput || !hiddenInput) return;
    var val = (textInput.value || '').trim();
    if (val) {
        var parts = val.split('-');
        if (parts.length === 3) {
            var d = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y) && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
                hiddenInput.value = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            }
        }
    }
    if (!hiddenInput.value) {
        var now = new Date();
        hiddenInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    function onDateChange() {
        var v = hiddenInput.value;
        if (!v) return;
        var ymd = v.split('-');
        if (ymd.length >= 3) {
            textInput.value = String(parseInt(ymd[2], 10)).padStart(2, '0') + '-' + String(parseInt(ymd[1], 10)).padStart(2, '0') + '-' + ymd[0];
        }
        hiddenInput.removeEventListener('change', onDateChange);
    }
    hiddenInput.addEventListener('change', onDateChange);
    hiddenInput.focus();
    if (typeof hiddenInput.showPicker === 'function') {
        try { hiddenInput.showPicker(); } catch (e) { hiddenInput.click(); }
    } else {
        hiddenInput.click();
    }
}

function applyDateTime() {
    var dateVal = (document.getElementById('edit-date').value || '').trim();
    var timeVal = (document.getElementById('edit-time').value || '').trim();
    if (!dateVal || !timeVal) {
        showAppModal('Please enter both date and time.', 'Error');
        return;
    }
    var dateParts = dateVal.split('-').map(Number);
    if (dateParts.length !== 3) {
        showAppModal('Enter date as DD-MM-YYYY.', 'Error');
        return;
    }
    var day = dateParts[0];
    var month = dateParts[1];
    var year = dateParts[2];
    var timeParts = timeVal.split(':');
    var hours = parseInt(timeParts[0], 10);
    var minutes = timeParts.length >= 2 ? parseInt(timeParts[1], 10) : 0;
    if (isNaN(hours)) hours = 0;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dtStr = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hours) + ':' + pad(minutes) + ':00';
    var headers = {};
    if (typeof window.currentUser !== 'undefined' && window.currentUser && window.currentUser.role) {
        headers['X-User-Role'] = window.currentUser.role;
    }
    fetch((API_BASE || '') + '/api/set_datetime', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ datetime: dtStr })
    }).then(function (r) {
        if (r.ok) {
            updateDateTime();
            showAppModal('Date and time updated.', 'Success', function () {
                goBack();
            });
            return;
        }
        return r.json().catch(function () { return {}; }).then(function (err) {
            showAppModal(err.error || 'Failed to set date and time.', 'Error');
        });
    }).catch(function (err) {
        showAppModal('Failed to update date and time: ' + (err && err.message ? err.message : 'Network error'), 'Error');
    });
}

function openDatePicker(inputId) {
    var el = document.getElementById(inputId);
    if (el) {
        el.focus();
        try { el.showPicker && el.showPicker(); } catch (e) {}
    }
}

function updateLoginFactorySettingsDisplay(settings) {
    var s = settings || {};
    var model = s.modelNo && String(s.modelNo).trim() ? String(s.modelNo).trim() : '';
    var serial = s.serialNo && String(s.serialNo).trim() ? String(s.serialNo).trim() : '';
    var company = s.companyName && String(s.companyName).trim() ? String(s.companyName).trim() : '';

    var modelEl = document.getElementById('login-footer-model-no');
    var serialEl = document.getElementById('login-footer-serial-no');
    var footerInfo = document.getElementById('login-footer-info');
    if (modelEl) modelEl.textContent = model || '—';
    if (serialEl) serialEl.textContent = serial || '—';

    var show = !!(model || serial || company);
    if (footerInfo) footerInfo.style.display = show ? 'block' : 'none';
}

function loadLoginFactorySettingsDisplay() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        updateLoginFactorySettingsDisplay(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            updateLoginFactorySettingsDisplay(settings);
        } catch (e) {
            updateLoginFactorySettingsDisplay({});
        }
    });
}

function initFactorySettings() {
    var screen = document.getElementById('page-factory-settings');
    if (!screen) return;
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setFactorySettingsForm(settings);
    }).catch(function () {
        var stored = null;
        try { stored = localStorage.getItem('factorySettings'); } catch (e) {}
        var settings = stored ? JSON.parse(stored) : {};
        setFactorySettingsForm(settings);
    });
}

function setFactorySettingsForm(settings) {
    var idMap = [
        ['factory-company-name', 'companyName'],
        ['factory-company-location', 'companyLocation'],
        ['factory-serial-no', 'serialNo'],
        ['factory-model-no', 'modelNo'],
        ['factory-instrument-id', 'instrumentId'],
        ['factory-installation-date', 'installationDate'],
        ['factory-firmware', null],
        ['factory-installed-by', 'installedBy'],
        ['factory-max-recipes', 'maxRecipes'],
        ['factory-max-users', 'maxUsers'],
        ['factory-max-admins', 'maxAdmins'],
        ['factory-max-supervisors', 'maxSupervisors']
    ];
    idMap.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (!el) return;
        if (pair[1] === null) {
            if (pair[0] === 'factory-firmware') el.value = 'RD-TDT v1.0.0';
            return;
        }
        var val = settings[pair[1]];
        if (pair[1] === 'maxRecipes') el.value = String(val || 150);
        else if (pair[1] === 'maxUsers') el.value = String(val || 10);
        else if (pair[1] === 'maxAdmins') el.value = String(val || 2);
        else if (pair[1] === 'maxSupervisors') el.value = String(val || 3);
        else el.value = val || '';
    });
    var biometricEl = document.getElementById('factory-biometric-enabled');
    var biometricEnabled = normalizeBiometricEnabled(settings.biometricEnabled);
    if (biometricEl) biometricEl.value = biometricEnabled ? 'enabled' : 'disabled';
    applyBiometricSetting(biometricEnabled);
    updateLoginFactorySettingsDisplay(settings);
}

function saveFactorySettings() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'factory-settings', 'save')) {
            showAppModal('You do not have permission to save factory settings.', 'Permission');
            return;
        }
    }
    var companyNameEl = document.getElementById('factory-company-name');
    var companyLocationEl = document.getElementById('factory-company-location');
    var serialNoEl = document.getElementById('factory-serial-no');
    var modelNoEl = document.getElementById('factory-model-no');
    var instrumentIdEl = document.getElementById('factory-instrument-id');
    var installationDateEl = document.getElementById('factory-installation-date');
    var installedByEl = document.getElementById('factory-installed-by');
    var maxRecipesEl = document.getElementById('factory-max-recipes');
    var maxUsersEl = document.getElementById('factory-max-users');
    var maxAdminsEl = document.getElementById('factory-max-admins');
    var maxSupervisorsEl = document.getElementById('factory-max-supervisors');
    var biometricEnabledEl = document.getElementById('factory-biometric-enabled');

    var companyName = companyNameEl && companyNameEl.value ? companyNameEl.value.trim() : '';
    var companyLocation = companyLocationEl && companyLocationEl.value ? companyLocationEl.value.trim() : '';
    if (!companyName || !companyLocation) {
        showAppModal('Company Name and Company Location are required.', 'Factory Settings');
        return;
    }
    var maxRecipes = Math.max(1, Math.min(999, parseInt(maxRecipesEl && maxRecipesEl.value ? maxRecipesEl.value : 150, 10)));
    var maxUsers = Math.max(1, Math.min(999, parseInt(maxUsersEl && maxUsersEl.value ? maxUsersEl.value : 10, 10)));
    var maxAdmins = Math.max(1, Math.min(99, parseInt(maxAdminsEl && maxAdminsEl.value ? maxAdminsEl.value : 2, 10)));
    var maxSupervisors = Math.max(1, Math.min(99, parseInt(maxSupervisorsEl && maxSupervisorsEl.value ? maxSupervisorsEl.value : 3, 10)));

    var data = {
        companyName: companyName,
        companyLocation: companyLocation,
        serialNo: serialNoEl && serialNoEl.value ? serialNoEl.value.trim() : '',
        modelNo: modelNoEl && modelNoEl.value ? modelNoEl.value.trim() : '',
        instrumentId: instrumentIdEl && instrumentIdEl.value ? instrumentIdEl.value.trim() : '',
        installationDate: installationDateEl && installationDateEl.value ? installationDateEl.value : '',
        firmware: 'RD-TDT v1.0.0',
        installedBy: installedByEl && installedByEl.value ? installedByEl.value.trim() : '',
        maxRecipes: maxRecipes,
        maxUsers: maxUsers,
        maxAdmins: maxAdmins,
        maxSupervisors: maxSupervisors,
        biometricEnabled: normalizeBiometricEnabled(biometricEnabledEl ? biometricEnabledEl.value : true)
    };
    showConfirmModal('Save factory settings?', 'Factory Settings').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/factory-settings', { method: 'POST', body: data }).then(function () {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved successfully.', 'Factory Settings');
        }).catch(function (err) {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved locally.', 'Factory Settings');
        });
    });
}

function showFactoryResetConfirm() {
    showConfirmModal(
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, and users. This action cannot be undone.',
        'Factory Reset'
    ).then(function (ok) {
        if (!ok) return;
        apiRequest((API_BASE || '') + '/api/data/factory-reset', { method: 'POST', body: {} })
            .then(function (result) {
                showAppModal('Factory reset completed. All reports, recipes, and users have been deleted.', 'Factory Reset');
                if (typeof loadManageRecipes === 'function') loadManageRecipes();
                if (typeof loadReports === 'function') loadReports();
                if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
            })
            .catch(function (err) {
                var msg = (err && err.message) ? err.message : 'Factory reset failed.';
                showAppModal(msg, 'Factory Reset');
            });
    });
}

function loadBiometricSetting() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        applyBiometricSetting(settings.biometricEnabled);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            applyBiometricSetting(settings.biometricEnabled);
        } catch (e) {
            applyBiometricSetting(true);
        }
    });
}

// ----- On-Screen Keyboard: attach to text-like inputs on focus / click -----
function attachKeyboardToInputs() {
    if (typeof window.openOSKForInput !== 'function') return;
    var selectors = [
        'input[type="text"]',
        'input[type="number"]',
        'input[type="password"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[type="search"]',
        'input[type="url"]',
        'textarea'
    ].join(', ');
    document.querySelectorAll(selectors).forEach(function (input) {
        if (!input || input.closest('#keyboard-root')) return;
        if (input.readOnly || input.disabled) return;
        if (input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio' || input.type === 'file' || input.type === 'range' || input.type === 'color') return;

        if (input._keyboardFocusHandler) {
            input.removeEventListener('focus', input._keyboardFocusHandler);
        }
        input._keyboardFocusHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('focus', input._keyboardFocusHandler);

        if (input._keyboardClickHandler) {
            input.removeEventListener('click', input._keyboardClickHandler);
        }
        input._keyboardClickHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('click', input._keyboardClickHandler);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    attachKeyboardToInputs();
    loadBiometricSetting();
    loadLoginFactorySettingsDisplay();

    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var page = btn.getAttribute('data-page');
            if (page) goToPage(page);
        });
    });

    var originalGoToPage = goToPage;
    goToPage = function (pageName) {
        if (originalGoToPage) originalGoToPage(pageName);
        setTimeout(function () {
            attachKeyboardToInputs();
        }, 200);
    };

    // Wire up Create Recipe Step 1 inputs to enable Continue button
    var recipeNameEl = document.getElementById('recipe-product-name');
    if (recipeNameEl) {
        recipeNameEl.addEventListener('input', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="create-speed"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-height"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
        });
    });
    var createTotalTaps = document.getElementById('create-custom-total-taps');
    if (createTotalTaps) {
        createTotalTaps.addEventListener('input', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="quick-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
        });
    });
    if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
    if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();

    function resetKioskSessionAndShowLogin() {
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        window.currentUser = null;
        if (typeof currentUser !== 'undefined') currentUser = null;
        var resetUrl = (API_BASE || '') + '/api/data/auth/session-ui-reset';
        fetch(resetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .catch(function () {})
            .finally(function () {
                showLoginScreen();
            });
    }
    resetKioskSessionAndShowLogin();
});
