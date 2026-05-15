// Tap Density - navigation + API
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
});
document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
}, { passive: false });

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
var validationRunTarget = 300;
var validationRunTolerance = 15;
var validationRunMin = 285;
var validationRunMax = 315;
var validationRunBackendPending = false;
var validationHardwareEnabled = true;
var validationCompletion = { distance: false, load: false }; // distance=USP 1, load=USP 2
/** USP1 (distance) and USP2 (load) results held until both validations complete. */
var validationSessionResults = { distance: null, load: null };
/** 60s timed validation: hardware tap count via SSE */
var validationRunHardwareEs = null;
var validationRunSseListener = null;
var VALIDATION_RUN_DURATION_SEC = 60;
var validationRunSecondsRemaining = 60;
var biometricEnabledSetting = true;
var currentReportId = null;
var currentReportData = null;
var currentRecipeForPrint = null;
var lastKnownDateTime = null;
var dateTimeClockInterval = null;
var _wallClockResyncInterval = null;
var lastDisplayedRecipes = [];
var pendingRecipeToLoad = null;
var _recipeSaveInFlight = false;
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
var _suppressValidationNavGuardOnce = false;
/** 'expired' | 'mandatory' — which POST to use from the shared reset page. */
var _passwordResetScreenMode = 'expired';
var _mandatoryPasswordResetPending = false;

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

/** Audit trail details: hide inactivity limits; show Reviewer instead of Supervisor. */
function formatAuditDetailsText(details) {
    var s = String(details || '');
    s = s.replace(/\s*\(\s*\d+\s*min\s+limit\s*\)/gi, '');
    s = s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
    return s.trim();
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

function isValidationOperationActive() {
    return validationRunState === 'running' || validationRunBackendPending === true;
}

function isValidationRunActive() {
    return isValidationOperationActive();
}

function applyValidationRunLockUi(locked) {
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('validation-run-locked', !!locked);
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
    });
    var logoEl = document.getElementById('header-logo');
    if (logoEl) logoEl.style.pointerEvents = locked ? 'none' : '';
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
    if (testRunButtonState === 'abort' && typeof abortTestRunAndSave === 'function') {
        return abortTestRunAndSave();
    }

    // Abort active validation hardware run before logout.
    if (validationRunState === 'running' || validationRunBackendPending) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        _closeValidationRunHardwareEs();
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

/** USB export verify/retention modals (audit trails and reports). */
function showUsbExportVerifyModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            resolve(window.confirm(opts.fallbackConfirm || 'Was the export successful?'));
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = opts.title || 'Verify Export';
        msgEl.textContent = opts.message || 'Verify the files on the USB pendrive.\n\nWas the export successful?';
        buttonsEl.innerHTML = '';
        var noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'btn-role-select btn-confirm-cancel';
        noBtn.textContent = opts.noLabel || 'No — Export again';
        noBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.className = 'btn-role-select btn-audit-export-verify-ok';
        yesBtn.textContent = opts.yesLabel || 'Yes — Verified';
        yesBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(noBtn);
        buttonsEl.appendChild(yesBtn);
        overlay.style.display = 'flex';
    });
}

function showUsbExportRetentionModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            window.alert(opts.message || 'Export verified.');
            resolve(true);
            return;
        }
        titleEl.textContent = opts.title || 'Export Verified';
        msgEl.textContent = opts.message || 'Export verified successfully.';
        buttonsEl.innerHTML = '';
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-audit-export-verify-ok';
        okBtn.textContent = 'OK';
        okBtn.onclick = function () {
            overlay.style.display = 'none';
            resolve(true);
        };
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
    });
}

function showAuditExportVerifyModal() {
    return showUsbExportVerifyModal({
        title: 'Verify Audit Export',
        message: 'Verify the PDF on the USB pendrive.\n\nWas the audit trail export successful?'
    });
}

/** Shown after operator confirms USB OK; 24h purge is scheduled. */
function showAuditExportRetentionModal(entriesScheduled) {
    var n = parseInt(entriesScheduled, 10);
    if (isNaN(n) || n < 0) n = 0;
    return showUsbExportRetentionModal({
        title: 'Audit Export Verified',
        message:
            'Export verified successfully.\n\n' +
            'The ' + n + ' audit entries included in this export will be permanently removed from this device after 24 hours.\n\n' +
            'Ensure your USB copy is complete and stored safely.'
    });
}

function showReportExportVerifyModal() {
    return showUsbExportVerifyModal({
        title: 'Verify Report Export',
        message: 'Verify the report PDF(s) on the USB pendrive.\n\nWas the report export successful?'
    });
}

function showReportExportRetentionModal(reportsScheduled) {
    var n = parseInt(reportsScheduled, 10);
    if (isNaN(n) || n < 0) n = 0;
    return showUsbExportRetentionModal({
        title: 'Report Export Verified',
        message:
            'Export verified successfully.\n\n' +
            'The ' + n + ' report(s) included in this export will be permanently removed from this device after 24 hours.\n\n' +
            'Ensure your USB copy is complete and stored safely.'
    });
}

function _confirmReportExportAfterUsb(evt, titleText) {
    var exportId = evt && evt.export_id ? evt.export_id : '';
    showReportExportVerifyModal().then(function (verified) {
        if (!verified) {
            showAppModal(
                'Export not verified. Check the USB pendrive and use Export Reports again when ready.\n\nNo data will be erased until you confirm a successful export.',
                titleText
            );
            return;
        }
        if (!exportId) {
            showAppModal('Could not confirm export (missing session). Please export again.', titleText);
            return;
        }
        showLoadingOverlay(titleText, 'Confirming export...', { cancellable: false });
        apiRequest(API_BASE + '/api/reports/export/confirm', {
            method: 'POST',
            body: { export_id: exportId, verified: true }
        }).then(function (confirmRes) {
            hideLoadingOverlay();
            if (confirmRes && confirmRes.success && confirmRes.scheduled) {
                showReportExportRetentionModal(confirmRes.reports_scheduled).then(function () {
                    if (typeof loadReports === 'function') {
                        loadReports(typeof currentReportFilter !== 'undefined' ? currentReportFilter : null);
                    }
                });
            } else {
                showAppModal(
                    _friendlyExportError((confirmRes && confirmRes.error) || 'Could not schedule retention'),
                    titleText
                );
            }
        }).catch(function (confirmErr) {
            hideLoadingOverlay();
            showAppModal(_friendlyExportError(confirmErr), titleText);
        });
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
    runBiometricVerifyWithRetry({
        purpose: _approvalVerifyPurpose,
        title: 'Verify Fingerprint',
        message: 'Place an Admin/QA fingerprint on the scanner to authorize this action.',
        failureHint: 'Place your finger on the scanner and tap Try again.'
    }).then(function (result) {
        if (!result || !result.ok) {
            if (result && result.error !== 'cancelled' && errEl) {
                errEl.textContent = result.message || result.error || 'Fingerprint verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(result.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    });
}

function _getApprovalVerifyModalElements() {
    var overlay = document.getElementById('page-approval-verify');
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    if (!overlay || !usernameEl || !passwordEl || !errEl) return null;
    var usernameLabelEl = overlay.querySelector('label[for="approval-verify-username"]');
    var actionsRow = overlay.querySelector('.add-member-actions');
    var userBtn = actionsRow ? actionsRow.querySelector('button.btn-primary') : null;
    var cancelBtn = null;
    if (actionsRow) {
        var secs = actionsRow.querySelectorAll('button.btn-secondary');
        for (var i = 0; i < secs.length; i++) {
            var oc = secs[i].getAttribute('onclick') || '';
            if (oc.indexOf('cancelApprovalVerifyModal') >= 0 || oc.indexOf('cancelAdminApprovalVerifyModal') >= 0) {
                cancelBtn = secs[i];
                break;
            }
        }
    }
    var titleEl = document.getElementById('approval-verify-title');
    var subtitleEl = document.getElementById('approval-verify-subtitle');
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

var USP_DEFAULT_STEP_COUNT = 10;

function isUspStandardProcedureMode(mode) {
    mode = String(mode || '').toUpperCase();
    return mode === 'USP1' || mode === 'USP2';
}

function applyStandardUspStepDefaults(target) {
    var n = USP_DEFAULT_STEP_COUNT;
    var taps = computeStandardUspTaps(n);
    if (target === 'quick' || target === 'both') {
        window._quickStepCount = n;
        window._quickStepTaps = taps.slice();
    }
    if (target === 'create' || target === 'both') {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = taps.slice();
    }
}

function formatUspStandardTapsSummary(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 1));
    var taps = computeStandardUspTaps(n);
    var parts = [];
    for (var i = 0; i < n; i++) {
        parts.push('Step ' + (i + 1) + ': ' + taps[i]);
    }
    return parts.join('  |  ');
}

function computeCreateRecipeStepTapsForStepCount(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    if (getCreateUspMode() === 'CUSTOM') {
        if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            return window._createRecipeStepTaps.slice();
        }
        return null;
    }
    return computeStandardUspTaps(n);
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
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'recipe-approve');
    }
    return false;
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


window._reportApprovalGate = null;
var _reportApprovalPollTimerId = null;

function normalizeReportUsername(u) {
    return String(u || '').trim().toLowerCase();
}

function getCurrentReportUsername() {
    var u = window.currentUser;
    if (!u) return '';
    return normalizeReportUsername(u.username || u.name || '');
}

function getReportOperatedByUsername(preview) {
    var p = preview || window._lastReportPreview || {};
    var td = p.testData || {};
    return normalizeReportUsername(p.operatedByUsername || td.operatedByUsername || td.employeeId || p.employeeId);
}

function isReportPendingApproval(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'pending';
}

function isReportApproved(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'approved';
}

function isCurrentUserReportOperator(preview) {
    var op = getReportOperatedByUsername(preview);
    var cur = getCurrentReportUsername();
    return !!(op && cur && op === cur);
}

function isReportPreviewLockedForCurrentUser(preview) {
    if (typeof isFactorySessionUser === 'function' && isFactorySessionUser()) return false;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    if (reportTypeNorm !== 'test' && reportTypeNorm !== 'validation') return false;
    if (!isReportPendingApproval(p)) return false;
    return isCurrentUserReportOperator(p);
}

function setReportApprovalGate(reportId, operatedByUsername) {
    if (reportId == null) {
        window._reportApprovalGate = null;
        return;
    }
    window._reportApprovalGate = {
        reportId: reportId,
        operatedByUsername: normalizeReportUsername(operatedByUsername)
    };
}

function clearReportApprovalGate() {
    window._reportApprovalGate = null;
    stopReportApprovalPoll();
}

function setReportApprovalGateFromPreview(preview, reportId) {
    if (!isReportPendingApproval(preview)) {
        clearReportApprovalGate();
        return;
    }
    if (isReportPreviewLockedForCurrentUser(preview)) {
        setReportApprovalGate(reportId, getReportOperatedByUsername(preview));
    } else {
        clearReportApprovalGate();
    }
}

function stopReportApprovalPoll() {
    if (_reportApprovalPollTimerId != null) {
        clearInterval(_reportApprovalPollTimerId);
        _reportApprovalPollTimerId = null;
    }
}

function startReportApprovalPollIfLocked() {
    stopReportApprovalPoll();
    if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) return;
    var rid = currentReportId;
    if (rid == null) return;
    _reportApprovalPollTimerId = setInterval(function () {
        if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
            stopReportApprovalPoll();
            return;
        }
        apiRequest(API_BASE + '/api/reports/' + rid + '/preview').then(function (data) {
            if (!data || !data.preview) return;
            var st = String(data.preview.reportApprovalStatus || '').trim().toLowerCase();
            if (st === 'approved') {
                populateReportPreview(data.preview);
                clearReportApprovalGate();
                applyReportPreviewLockUi(data.preview);
                _saveReportPdfSilent(rid);
                showAppModal('Report has been approved. You may now print or leave this screen.', 'Report');
            }
        }).catch(function () {});
    }, 5000);
}

function setReportApproveBiometricRetryVisible(visible) {
    var btn = document.getElementById('btn-report-approve-biometric-retry');
    if (btn) btn.style.display = visible ? '' : 'none';
}

function clearReportApproveVerifyError() {
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.style.display = 'none';
    setReportApproveBiometricRetryVisible(false);
}

function resetReportApproveForm() {
    var ta = document.getElementById('report-approve-remarks-input');
    if (ta) ta.value = '';
    var userEl = document.getElementById('report-approve-verifier-username');
    var passEl = document.getElementById('report-approve-verifier-password');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    var passRadio = document.querySelector('input[name="report-approve-pass-fail"][value="PASS"]');
    if (passRadio) passRadio.checked = true;
    clearReportApproveVerifyError();
}

function setReportApproveVerifyError(message, options) {
    options = options || {};
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = message ? String(message) : '';
    errEl.style.display = message ? 'block' : 'none';
    if (options.showBiometricRetry) {
        setReportApproveBiometricRetryVisible(true);
    }
}

function wireReportApproveVerifierListeners() {
    if (window._reportApproveVerifierListenersWired) return;
    window._reportApproveVerifierListenersWired = true;
    var userEl = document.getElementById('report-approve-verifier-username');
    if (!userEl) return;
    userEl.addEventListener('input', function () {
        setReportApprovePanelInteractionState(window._lastReportPreview);
    });
}

function setReportApprovePanelInteractionState(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    wireReportApproveVerifierListeners();
    var pending = isReportPendingApproval(preview);
    var isOp = isCurrentUserReportOperator(preview);
    var isFactory = typeof isFactorySessionUser === 'function' && isFactorySessionUser();
    var fieldsEnabled = !!pending;
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var entered = usernameEl && typeof normalizeReportUsername === 'function'
        ? normalizeReportUsername(usernameEl.value)
        : (usernameEl ? String(usernameEl.value || '').trim().toLowerCase() : '');
    var opUser = typeof getReportOperatedByUsername === 'function'
        ? getReportOperatedByUsername(preview) : '';
    var canCredentialSubmit = fieldsEnabled && (!isOp || isFactory || (entered && opUser && entered !== opUser));
    apprPanel.classList.toggle('is-operator-view', !!(pending && isOp && !isFactory));
    var hintEl = document.getElementById('report-approve-operator-hint');
    if (hintEl) hintEl.style.display = (pending && isOp && !isFactory) ? 'block' : 'none';
    ['#report-approve-remarks-input', 'input[name="report-approve-pass-fail"]',
        '#report-approve-verifier-username', '#report-approve-verifier-password'].forEach(function (sel) {
        apprPanel.querySelectorAll(sel).forEach(function (el) { el.disabled = !fieldsEnabled; });
    });
    var submitBtn = document.getElementById('btn-report-approve-submit');
    if (submitBtn) submitBtn.disabled = !canCredentialSubmit;
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    if (bioBtn) bioBtn.disabled = !fieldsEnabled;
    apprPanel.querySelectorAll('.report-approve-card-wrap').forEach(function (wrap) {
        if (fieldsEnabled) wrap.classList.remove('is-disabled');
        else wrap.classList.add('is-disabled');
    });
}

function updateReportApprovePanelForPreview(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    var pending = isReportPendingApproval(preview);
    var rid = currentReportId;
    if (pending && rid != null && rid !== window._reportApproveFormReportId) {
        resetReportApproveForm();
        window._reportApproveFormReportId = rid;
    }
    if (!pending) {
        window._reportApproveFormReportId = null;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    var titleEl = document.getElementById('report-approve-panel-title') || apprPanel.querySelector('h3');
    if (titleEl) {
        titleEl.textContent = reportTypeNorm === 'validation'
            ? 'Validation report approval'
            : 'Test report approval';
    }
    apprPanel.style.display = pending ? 'block' : 'none';
    if (!pending) clearReportApproveVerifyError();
    setReportApprovePanelInteractionState(preview);
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    var bioWrap = document.getElementById('report-approve-biometric-wrap');
    var showBio = typeof biometricEnabledSetting === 'undefined' || biometricEnabledSetting;
    if (bioBtn) bioBtn.style.display = showBio ? '' : 'none';
    if (bioWrap) bioWrap.style.display = showBio ? '' : 'none';
}

function scrollReportApprovePanelIntoView() {
    var panel = document.getElementById('report-approve-panel');
    if (!panel || panel.style.display === 'none') return;
    try {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        panel.scrollIntoView(true);
    }
}

function scrollReportPendingBannerIntoView() {
    var banner = document.getElementById('report-pending-lock-banner');
    if (!banner || banner.style.display === 'none') return;
    try {
        banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        banner.scrollIntoView(true);
    }
}

function applyReportPreviewLockUi(preview) {
    preview = preview || window._lastReportPreview;
    var locked = isReportPreviewLockedForCurrentUser(preview);
    var pending = isReportPendingApproval(preview);
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('report-approval-locked', !!locked);
    var banner = document.getElementById('report-pending-lock-banner');
    if (banner) banner.style.display = locked ? 'block' : 'none';
    var closeBtn = document.querySelector('#report-preview-actions .btn-close');
    if (closeBtn) closeBtn.style.display = locked ? 'none' : '';
    var backBtn = document.getElementById('header-back-btn');
    if (backBtn) backBtn.style.visibility = locked ? 'hidden' : '';
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
        if (locked) el.setAttribute('aria-disabled', 'true');
        else el.removeAttribute('aria-disabled');
    });
    updateReportApprovePanelForPreview(preview);
    updateReportPreviewPrintExportButtons(preview);
}

function stampOperatorOnTestReportPayload(payload) {
    if (!payload) return payload;
    var u = window.currentUser || {};
    var un = normalizeReportUsername(u.username || u.name || '');
    var name = String(u.name || u.username || '—').trim();
    var emp = String(u.username || un || '').trim();
    payload.operatedByUsername = un;
    payload.operatorName = name;
    payload.employeeId = emp;
    payload.testData = payload.testData || {};
    payload.testData.operatedByUsername = un;
    payload.testData.operatorName = name;
    payload.testData.employeeId = emp;
    return payload;
}

function abortPendingReportOnLogout() {
    var gate = window._reportApprovalGate;
    if (!gate || gate.reportId == null) return Promise.resolve();
    if (typeof isFactorySessionUser === 'function' && isFactorySessionUser()) {
        clearReportApprovalGate();
        return Promise.resolve();
    }
    return apiRequest(API_BASE + '/api/data/reports/' + gate.reportId + '/abort', { method: 'POST' }).then(function () {
        clearReportApprovalGate();
    }).catch(function () {
        clearReportApprovalGate();
    });
}

function reportActionsBlockedForPreview(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    return approvalSt === 'pending' && (reportTypeNorm === 'test' || reportTypeNorm === 'validation');
}

function finishTestRunReportSaved(reportId) {
    resetQuickTestFormAfterRunIfPending();
    if (reportId) {
        if (typeof openReportPreview === 'function') {
            openReportPreview(reportId, { setGate: true });
        } else {
            goToPage('reports');
        }
    } else {
        goToPage('reports');
        if (typeof loadReports === 'function') loadReports();
    }
}

/** Recipe approval modal copy; verifier must have recipe-approve permission card. */
function _approvalVerifyModalOptionsForRecipe() {
    return {
        purpose: 'recipe',
        titleText: 'Recipe approval required',
        subtitleText: 'Enter credentials for a user with Recipe approval permission.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Approver username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

/** Test report approval: verifier must have test-report-approve permission card. */
function _approvalVerifyModalOptionsForReport() {
    return {
        purpose: 'report',
        titleText: 'Test report approval',
        subtitleText: 'Enter credentials for a user with Test report approval permission.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Approver username',
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
    var stepsSec = document.getElementById('create-recipe-steps-section');
    if (stepsSec) stepsSec.style.display = mode === 'CUSTOM' ? '' : 'none';
    if (isUspStandardProcedureMode(mode)) {
        applyStandardUspStepDefaults('create');
        if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
    }
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
    if (typeof _updateCreateStepsPageUspUi === 'function') _updateCreateStepsPageUspUi();
}

function applyQuickUspModeToSpeedHeight() {
    var mode = getQuickUspMode();
    var speedWrap = document.getElementById('quick-custom-speed-height-wrap');
    if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var totalWrap = document.getElementById('quick-custom-total-wrap');
    if (totalWrap) totalWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var quickStepsSec = document.getElementById('quick-recipe-steps-section');
    if (quickStepsSec) quickStepsSec.style.display = mode === 'CUSTOM' ? '' : 'none';
    if (isUspStandardProcedureMode(mode)) {
        applyStandardUspStepDefaults('quick');
        if (typeof _refreshQuickStepSummary === 'function') _refreshQuickStepSummary();
    }
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
    if (typeof _updateQuickStepsPageUspUi === 'function') _updateQuickStepsPageUspUi();
}

function _updateQuickStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getQuickUspMode());
    var tapsWrap = document.getElementById('quick-steps-taps-wrap');
    var infoEl = document.getElementById('quick-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="quick-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._quickStepCount || 10);
            infoEl.textContent = 'Taps per step are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

function _updateCreateStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getCreateUspMode());
    var tapsWrap = document.getElementById('create-steps-taps-wrap');
    var infoEl = document.getElementById('create-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="create-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._createRecipeStepCount || 10);
            infoEl.textContent = 'Taps per step are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

var PAGE_TITLES = {
    'home': 'Tap Density Apparatus',
    'quick-test': 'Quick Test',
    'quick-test-steps': 'Quick Test — Steps',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Create Recipe — Steps',
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
    'validation-run': 'Validation Test',
    'ip-configure': 'IP Configure'
};

var _auditActivePage = null;
var _auditSkipPages = { login: true, 'password-expired-reset': true };
var _testRunAdapterInterruptAudited = false;

var PAGE_AUDIT_LABELS = {
    home: 'Home',
    'quick-test': 'Quick Test',
    'quick-test-steps': 'Quick Test — Steps',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Create Recipe — Steps',
    'manage-recipes': 'Manage Recipes',
    'manage-members': 'Manage Profiles',
    'locked-members': 'Locked Members',
    'disabled-members': 'Disabled Members',
    'load-validation': 'USP 2 Validation',
    'distance-validation': 'USP 1 Validation',
    'add-member': 'Add New Member',
    validate: 'Validation',
    'validate-type-select': 'Select Validation Type',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    settings: 'Settings',
    datetime: 'Date and Time',
    'factory-settings': 'Factory Settings',
    reports: 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'USP 1 validation',
    'usp2-detail': 'USP 2 validation',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test',
    'disable-recipes': 'Disabled Recipes'
};

function logAuditEvent(action, details, options) {
    options = options || {};
    if (!window.currentUser) return Promise.resolve();
    var body = {
        action: action,
        details: details || '',
        outcome: options.outcome || 'success',
        eventType: options.eventType || 'lifecycle',
        entityType: options.entityType || '',
        entityName: options.entityName || '',
        entityId: options.entityId,
        reason: options.reason || '',
        extra: options.extra || {}
    };
    return apiRequest(API_BASE + '/api/data/audit-log/event', {
        method: 'POST',
        body: body
    }).catch(function () {});
}

function auditPageLabel(pageName) {
    if (pageName === 'manage-recipes') {
        return (typeof recipeListMode !== 'undefined' && recipeListMode === 'load')
            ? 'Load Recipe'
            : 'Manage Recipes';
    }
    if (PAGE_AUDIT_LABELS[pageName]) return PAGE_AUDIT_LABELS[pageName];
    if (PAGE_TITLES[pageName]) return PAGE_TITLES[pageName];
    return pageName;
}

function auditNavPageChange(newPage) {
    if (_auditSkipPages[newPage]) {
        _auditActivePage = null;
        return;
    }
    if (newPage === _auditActivePage) return;
    var prev = _auditActivePage;
    _auditActivePage = newPage;
    if (prev && !_auditSkipPages[prev]) {
        logAuditEvent('Exited screen', auditPageLabel(prev), { eventType: 'navigation' });
    }
    if (newPage === 'usp1-detail') {
        logAuditEvent('Entered USP 1 validation', 'USP 1 validation screen', { eventType: 'navigation' });
    } else if (newPage === 'usp2-detail') {
        logAuditEvent('Entered USP 2 validation', 'USP 2 validation screen', { eventType: 'navigation' });
    } else {
        logAuditEvent('Entered screen', auditPageLabel(newPage), { eventType: 'navigation' });
    }
}

/** Audit action for adapter/holder faults: USP 1 → holder error; USP 2 → check adaptor and holder. */
function adapterErrorAuditActionForKind(kind) {
    return kind === 'usp2' ? 'check adaptor and holder' : 'holder error';
}

function adapterErrorAuditActionForRecipe(recipe) {
    return adapterErrorAuditActionForKind(recipeExpectedAdapterKind(recipe));
}

function adapterErrorAuditActionForValidation() {
    return adapterErrorAuditActionForKind(validationExpectedAdapterKind());
}

function adapterErrorTitleForKind(kind) {
    return kind === 'usp2' ? 'Check adaptor and holder' : 'Holder error';
}

function adapterErrorTitleForRecipe(recipe) {
    return adapterErrorTitleForKind(recipeExpectedAdapterKind(recipe));
}

function adapterErrorTitleForValidation() {
    return adapterErrorTitleForKind(validationExpectedAdapterKind());
}

function auditTestUspHolderAction(recipe) {
    return adapterErrorAuditActionForRecipe(recipe);
}

function logTestAdapterError(recipe, extra) {
    logAuditEvent(auditTestUspHolderAction(recipe), 'Holder check failed for test run', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'holder',
        outcome: 'failed',
        extra: extra || {}
    });
}

function logValidationAdapterError(extra) {
    var action = adapterErrorAuditActionForValidation();
    logAuditEvent(action, 'Holder check failed for ' + validationHolderLabel() + ' validation', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'holder',
        outcome: 'failed',
        extra: extra || {}
    });
}

function auditTestRunStarted(rec) {
    var recipe = rec || lastTestRunRecipe;
    if (!recipe) return;
    var isQuick = String(recipe.productName || '').trim() === 'Quick Test';
    var steps = (recipe.steps && recipe.steps.length) || recipe.stepCount || testRunTotalSteps || 0;
    var action = isQuick ? 'Quick test started' : 'Test started';
    var details = (recipe.productName || 'Test') + ', ' + (recipe.usp || recipe.uspMode || 'USP') + ', ' + steps + ' step(s)';
    logAuditEvent(action, details, {
        eventType: 'lifecycle',
        entityType: 'test',
        entityName: recipe.productName || '',
        extra: {
            productName: recipe.productName,
            batchNumber: recipe.batchNumber,
            usp: recipe.usp || recipe.uspMode,
            stepCount: steps
        }
    });
}

function auditTestRunFinished(reportId) {
    var completed = (testRunStepResults && testRunStepResults.length) ? testRunStepResults.length : 0;
    logAuditEvent('Test finished', 'Test run completed, ' + completed + ' step(s) recorded', {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId || '',
        extra: { reportId: reportId, completedSteps: completed }
    });
}

function auditTestRunAborted(reason) {
    var completed = (testRunStepResults && testRunStepResults.length) ? testRunStepResults.length : 0;
    logAuditEvent('Test aborted', reason || ('User aborted test, ' + completed + ' step(s) recorded'), {
        eventType: 'lifecycle',
        entityType: 'test',
        extra: { completedSteps: completed }
    });
}

function auditTestRunAutoAborted(reason, stepIndex) {
    logAuditEvent('Test auto-aborted', reason || 'Hardware stopped the test run', {
        eventType: 'lifecycle',
        entityType: 'test',
        outcome: 'failed',
        extra: { stepIndex: stepIndex != null ? stepIndex : testRunCurrentStepIndex, reason: reason }
    });
}

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

/** Parse API naive ISO wall time (YYYY-MM-DDTHH:MM:SS) as local components — not UTC via Date(). */
function parseWallDatetimeIso(isoStr) {
    var s = String(isoStr || '').trim().replace('Z', '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return {
        y: parseInt(m[1], 10),
        mo: parseInt(m[2], 10),
        d: parseInt(m[3], 10),
        h: parseInt(m[4], 10),
        mi: parseInt(m[5], 10),
        sec: parseInt(m[6] || '0', 10)
    };
}

function formatWallClockParts(p) {
    return {
        dateString: String(p.d).padStart(2, '0') + '/' + String(p.mo).padStart(2, '0') + '/' + p.y,
        timeString: String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0') + ':' + String(p.sec).padStart(2, '0')
    };
}

function wallClockPartsPlusSeconds(parts, extraSec) {
    var t = new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.sec + (extraSec || 0));
    return {
        y: t.getFullYear(),
        mo: t.getMonth() + 1,
        d: t.getDate(),
        h: t.getHours(),
        mi: t.getMinutes(),
        sec: t.getSeconds()
    };
}

var _wallClockAnchor = null;

function applyWallClockToTopBar(parts) {
    if (!parts) return;
    var fmt = formatWallClockParts(parts);
    lastKnownDateTime = { timeString: fmt.timeString, dateString: fmt.dateString };
    var timeEl = document.getElementById('current-time');
    var dateEl = document.getElementById('current-date');
    if (timeEl) timeEl.textContent = fmt.timeString;
    if (dateEl) dateEl.textContent = fmt.dateString;
}

function tickWallClockFromAnchor() {
    if (!_wallClockAnchor || !_wallClockAnchor.parts) return;
    var elapsed = Math.floor((Date.now() - _wallClockAnchor.at) / 1000);
    applyWallClockToTopBar(wallClockPartsPlusSeconds(_wallClockAnchor.parts, elapsed));
}

function updateDateTime() {
    fetchDateTimeFromBackend().then(function (data) {
        var timeString = '--:--:--';
        var dateString = '--/--/----';
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                _wallClockAnchor = { parts: parts, at: Date.now() };
                var fmt = formatWallClockParts(parts);
                dateString = fmt.dateString;
                timeString = fmt.timeString;
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
        if (_wallClockAnchor && _wallClockAnchor.parts) {
            applyWallClockToTopBar(_wallClockAnchor.parts);
        } else {
            var timeEl = document.getElementById('current-time');
            var dateEl = document.getElementById('current-date');
            if (timeEl) timeEl.textContent = timeString;
            if (dateEl) dateEl.textContent = dateString;
        }
    });
}

function showLoginScreen() {
    _auditActivePage = null;
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (app) app.style.display = 'none';
    if (login) login.style.display = 'flex';
    stopAutoLogoutWatcher();
    resetLoginFormFields();
    if (typeof loadLoginFactorySettingsDisplay === 'function') loadLoginFactorySettingsDisplay();
}

/** Clear login ID and password fields (call on logout / session end). */
function resetLoginFormFields() {
    var loginUid = document.getElementById('login-uid');
    var loginPwd = document.getElementById('login-pwd');
    if (loginUid) loginUid.value = '';
    if (loginPwd) loginPwd.value = '';
}

function completeSuccessfulLogin(user) {
    window.currentUser = user;
    try { localStorage.setItem('currentUser', JSON.stringify(user)); } catch (e) {}
    if (typeof currentUser !== 'undefined') currentUser = user;
    updateProfileFromCurrentUser(user);
    refreshFactoryPolicyFromServer().finally(function () {
        showAppContainer();
        if (typeof refreshActiveQaCount === 'function') refreshActiveQaCount();
        goToPage('home');
    });
}

function showAppContainer() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';
    updateDateTime();
    if (!dateTimeClockInterval) {
        dateTimeClockInterval = setInterval(function () {
            tickWallClockFromAnchor();
            if (!_wallClockResyncInterval) {
                _wallClockResyncInterval = setInterval(updateDateTime, 5000);
            }
        }, 1000);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
        ensureAutoLogoutWatcher();
    }
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
    showIf('.settings-recipes', 'recipe-manage');
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
    var ipCard = document.querySelector('.settings-ip-configure');
    if (ipCard) ipCard.style.display = '';
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
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
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
    if (!_suppressValidationNavGuardOnce && isValidationOperationActive() && pageName !== 'validation-run') {
        showConfirmModal('Validation is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            abortValidationRun().then(function () {
                _suppressValidationNavGuardOnce = true;
                goToPage(pageName);
            });
        });
        return;
    }
    _suppressValidationNavGuardOnce = false;
    if (pageName !== 'report-preview' && typeof isReportPreviewLockedForCurrentUser === 'function' &&
        isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
        showAppModal('This report is awaiting approval. You must stay on the report screen until a reviewer approves it.', 'Report');
        var active = document.querySelector('.page.active');
        if (!active || active.id !== 'page-report-preview') {
            var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
            if (rid) openReportPreview(rid);
        }
        return;
    }
    if (window._mandatoryPasswordResetPending && pageName !== 'password-expired-reset') {
        showAppModal('Please reset your password to continue.', 'Reset Password');
        return;
    }
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
        var skipNavForEditMember = (pageName === 'add-member' && editingMemberId != null);
        if (!skipNavForEditMember && typeof checkNavigationAccess === 'function' && !checkNavigationAccess(pageName)) {
            showAppModal('You do not have permission to open this screen.', 'Permission');
            return;
        }
        if (skipNavForEditMember && typeof canEditMembers === 'function' && !canEditMembers()) {
            showAppModal('You do not have permission to edit profiles.', 'Permission');
            return;
        }
    }
    if (pageName === 'quick-test-steps' && typeof isUspStandardProcedureMode === 'function' &&
            isUspStandardProcedureMode(getQuickUspMode())) {
        pageName = 'quick-test';
    }
    if (pageName === 'create-recipe-step2' && typeof isUspStandardProcedureMode === 'function' &&
            isUspStandardProcedureMode(getCreateUspMode())) {
        pageName = 'create-recipe-step1';
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
        if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
        setTimeout(function () { loadReports(currentReportFilter || null); }, 50);
    }
    if (pageName === 'report-preview' && typeof refreshReportsActionButtons === 'function') {
        setTimeout(refreshReportsActionButtons, 50);
    }
    if (pageName === 'settings') {
        setTimeout(function () {
            if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
        }, 50);
    }
    if (pageName === 'ip-configure' && typeof refreshIpConfigureAddresses === 'function') {
        refreshIpConfigureAddresses();
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
        logAuditEvent('Opened disabled recipes', 'Disabled recipes list opened', { eventType: 'navigation' });
        setTimeout(function () {
            if (typeof loadDisableRecipes === 'function') loadDisableRecipes();
        }, 50);
    }
    if (pageName === 'create-recipe-step1') {
        setTimeout(function () {
            if (window._createRecipePreserveStep1) {
                window._createRecipePreserveStep1 = false;
                if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
                if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
                return;
            }
            if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
            if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
            if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
            if (window.currentEditingRecipeId && typeof loadRecipeForEdit === 'function') {
                loadRecipeForEdit();
            }
        }, 50);
    }
    if (pageName === 'create-recipe-step2') {
        setTimeout(function () {
            if (typeof isUspStandardProcedureMode === 'function' && isUspStandardProcedureMode(getCreateUspMode())) {
                goToPage('create-recipe-step1');
                return;
            }
            if (typeof initCreateRecipeStepsPage === 'function') initCreateRecipeStepsPage();
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
    if (pageName === 'add-member') {
        setTimeout(function () {
            if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
                _refreshAddMemberPermissionsPanelVisibility();
            }
            if (typeof ensureAddMemberPageScroll === 'function') {
                ensureAddMemberPageScroll();
            }
        }, 50);
    }
    if (pageName === 'validate-type-select' || pageName === 'usp1-detail' ||
            pageName === 'usp2-detail') {
        setTimeout(function () {
            if (typeof ensureValidationPageScroll === 'function') {
                ensureValidationPageScroll(pageName);
            }
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
    auditNavPageChange(pageName);
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
    } else if (pageId === 'page-report-preview') {
        if (typeof isReportPreviewLockedForCurrentUser === 'function' &&
            isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
            showAppModal('This report must be approved before you can leave. Ask a reviewer to verify approval on this screen.', 'Report');
            return;
        }
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
        if (isValidationOperationActive()) {
            showConfirmModal('Validation is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                abortValidationRun().then(function () {
                    _suppressValidationNavGuardOnce = true;
                    goToPage('validate-type-select');
                });
            });
            return;
        }
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
    } else if (pageId === 'page-password-expired-reset') {
        if (window._mandatoryPasswordResetPending) {
            showAppModal('Please reset your password before leaving this screen.', 'Reset Password');
            return;
        }
        _restoreSidebarAndHeaderAfterExpiredReset();
        showLoginScreen();
    } else {
        goToPage('home');
    }
}

function login() {
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    var username = (uidEl && uidEl.value) ? String(uidEl.value).trim() : '';
    var password = (pwdEl && pwdEl.value) ? String(pwdEl.value) : '';
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
            completeSuccessfulLogin(data.user);
            return;
        }
        var msg = data.error || '';
        var remaining = (typeof data.remainingAttempts === 'number') ? data.remainingAttempts : null;
        if (result.status === 403 && data && data.passwordChangeRequired) {
            showMandatoryPasswordResetScreen(data.username || username);
            return;
        }
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
    window._passwordResetScreenMode = 'expired';
    window._mandatoryPasswordResetPending = false;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset Expired Password';
    if (subEl) subEl.textContent = 'Your password has expired. Set a new password to continue.';
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

function showMandatoryPasswordResetScreen(username) {
    window._passwordResetScreenMode = 'mandatory';
    window._mandatoryPasswordResetPending = true;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset your password';
    if (subEl) {
        subEl.textContent = 'Your account was created with a temporary password. Choose a new password that only you know before you can use the app.';
    }
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
        if (oldEl) oldEl.value = '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (oldEl && typeof oldEl.focus === 'function') oldEl.focus();
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

function submitPasswordResetFromLoginPage() {
    if (window._passwordResetScreenMode === 'mandatory') {
        submitMandatoryPasswordReset();
    } else {
        submitExpiredPasswordReset();
    }
}

function submitMandatoryPasswordReset() {
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

    fetch((API_BASE || '') + '/api/data/auth/mandatory-password-reset', {
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
        if (result.ok && data.ok && data.user) {
            window._mandatoryPasswordResetPending = false;
            window._passwordResetScreenMode = 'expired';
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            _restoreSidebarAndHeaderAfterExpiredReset();
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
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
    var pendingGate = window._reportApprovalGate && window._reportApprovalGate.reportId != null &&
        !(typeof isFactorySessionUser === 'function' && isFactorySessionUser());

    var doLogout = function () {
        abortPendingReportOnLogout().then(function () {
            return stopActiveRunForLogout();
        }).finally(function () {
            apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'user' } }).catch(function () {});
            window.currentUser = null;
            try { localStorage.removeItem('currentUser'); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = null;
            clearReportApprovalGate();
            showLoginScreen();
        });
    };

    if (runActive) {
        var logoutConfirmMsg = (validationRunState === 'running' || validationRunBackendPending)
            ? 'Validation is running. Do you want to abort and logout?'
            : 'Test is running. Do you want to abort and logout?';
        showConfirmModal(logoutConfirmMsg, 'Operation in progress').then(function (ok) {
            if (!ok) return;
            doLogout();
        });
        return;
    }

    if (pendingGate) {
        showAppModal('You cannot log out until this report has been approved by a reviewer.', 'Report');
        var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
        if (rid && typeof openReportPreview === 'function') openReportPreview(rid);
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

/** Minutes (0 = off). Updated from factory settings API / localStorage. */
var factoryAutoLogoutMinutes = 0;
var _autoLogoutLastActivityMs = 0;
var _autoLogoutIntervalId = null;
var _autoLogoutListenersAttached = false;

function applyFactoryAutoLogoutSetting(settings) {
    var raw = settings && settings.autoLogoutMinutes != null ? settings.autoLogoutMinutes : 0;
    var m = parseInt(raw, 10);
    if (isNaN(m)) m = 0;
    m = Math.max(0, Math.min(10080, m));
    factoryAutoLogoutMinutes = m;
    if (m < 1) {
        stopAutoLogoutWatcher();
    } else {
        markAutoLogoutActivity();
        if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
            ensureAutoLogoutWatcher();
        }
    }
}

function markAutoLogoutActivity() {
    _autoLogoutLastActivityMs = Date.now();
}

function isAutoLogoutRunBlocked() {
    return (testRunButtonState === 'abort') ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);
}

function ensureAutoLogoutListeners() {
    if (_autoLogoutListenersAttached) return;
    _autoLogoutListenersAttached = true;
    var opts = { capture: true, passive: true };
    ['pointerdown', 'touchstart', 'click', 'keydown', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, markAutoLogoutActivity, opts);
    });
}

function stopAutoLogoutWatcher() {
    if (_autoLogoutIntervalId != null) {
        clearInterval(_autoLogoutIntervalId);
        _autoLogoutIntervalId = null;
    }
}

function ensureAutoLogoutWatcher() {
    ensureAutoLogoutListeners();
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) return;
    if (factoryAutoLogoutMinutes < 1) return;
    markAutoLogoutActivity();
    if (_autoLogoutIntervalId != null) return;
    _autoLogoutIntervalId = setInterval(autoLogoutTick, 10000);
}

function autoLogoutTick() {
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
        stopAutoLogoutWatcher();
        return;
    }
    var app = document.querySelector('.app-container');
    if (!app || app.style.display === 'none') return;
    if (isAutoLogoutRunBlocked()) {
        markAutoLogoutActivity();
        return;
    }
    if (factoryAutoLogoutMinutes < 1) return;
    var limitMs = factoryAutoLogoutMinutes * 60000;
    if (Date.now() - _autoLogoutLastActivityMs >= limitMs) {
        stopAutoLogoutWatcher();
        performAutoLogoutDueToInactivity();
    }
}

function performAutoLogoutDueToInactivity() {
    var pendingGate = window._reportApprovalGate && window._reportApprovalGate.reportId != null &&
        !(typeof isFactorySessionUser === 'function' && isFactorySessionUser());
    var finish = function () {
        apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'inactivity' } }).catch(function () {});
        window.currentUser = null;
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        if (typeof currentUser !== 'undefined') currentUser = null;
        clearReportApprovalGate();
        showLoginScreen();
        setTimeout(function () {
            showAppModal('You were logged out due to inactivity.', 'Session');
        }, 200);
    };
    if (pendingGate) {
        markAutoLogoutActivity();
        return;
    }
    if (testRunButtonState === 'abort' && typeof abortTestRunAndSave === 'function') {
        abortTestRunAndSave().finally(finish);
        return;
    }
    finish();
}

function loginBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric login is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    if (window._loginBiometricInFlight) return;
    window._loginBiometricInFlight = true;
    var abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    window._loginBiometricAbort = function () {
        if (abortCtrl) abortCtrl.abort();
    };
    showBiometricProgressOverlay(
        'Biometric Login',
        'Activating fingerprint scanner. Place your finger on the sensor.'
    );
    var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    };
    if (abortCtrl) fetchOpts.signal = abortCtrl.signal;
    fetch((API_BASE || '') + '/api/data/auth/login-biometric', fetchOpts).then(function (res) {
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
            completeSuccessfulLogin(data.user);
            return;
        }
        if (result.status === 403 && data && data.passwordChangeRequired && data.username) {
            showMandatoryPasswordResetScreen(data.username);
            return;
        }
        var msg = (data && data.error) ? String(data.error) : 'Biometric login failed.';
        showAppModal(msg, 'Biometric Login');
    }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showAppModal('Biometric login failed: ' + (err && err.message ? err.message : 'Network error'), 'Biometric Login');
    }).finally(function () {
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
    });
}

var _biometricEnrollUsername = null;
var _biometricEnrollCancelled = false;

function _getBiometricEnrollUsername() {
    var bioUserEl = document.getElementById('member-biometric-username');
    var formUserEl = document.getElementById('add-userid');
    if (bioUserEl && bioUserEl.textContent && bioUserEl.textContent.trim() !== '--') {
        return bioUserEl.textContent.trim();
    }
    if (formUserEl && formUserEl.value) return formUserEl.value.trim();
    return '';
}

function _setBioEnrollStepActive(step) {
    var steps = document.querySelectorAll('#bio-enroll-steps .bio-enroll-step');
    steps.forEach(function (el) {
        var n = parseInt(el.getAttribute('data-step'), 10);
        el.classList.remove('active', 'done');
        if (n < step) el.classList.add('done');
        else if (n === step) el.classList.add('active');
    });
}

function _setBioFingerAnimState(state) {
    var stage = document.getElementById('bio-finger-stage');
    if (!stage) return;
    stage.classList.remove('state-place', 'state-scan', 'state-remove', 'state-done');
    if (state) stage.classList.add('state-' + state);
}

function setBiometricOverlayRetryVisible(visible) {
    var retryBtn = document.getElementById('biometric-progress-retry-btn');
    if (retryBtn) retryBtn.style.display = visible ? '' : 'none';
}

function showBiometricEnrollUi(opts) {
    opts = opts || {};
    var overlay = document.getElementById('biometric-progress-overlay');
    var titleEl = document.getElementById('biometric-progress-title');
    var msgEl = document.getElementById('biometric-progress-message');
    var hintEl = document.getElementById('biometric-progress-hint');
    var spinner = document.getElementById('biometric-progress-spinner');
    var stepsWrap = document.getElementById('bio-enroll-steps');
    var fingerStage = document.getElementById('bio-finger-stage');
    var enrollMode = !!opts.enrollMode;
    var verifyMode = !!opts.verifyMode;
    if (stepsWrap) stepsWrap.style.display = enrollMode ? 'flex' : 'none';
    if (fingerStage) fingerStage.style.display = (enrollMode || verifyMode) ? 'block' : 'none';
    if (titleEl && opts.title) titleEl.textContent = opts.title;
    if (msgEl && opts.message !== undefined) msgEl.textContent = opts.message || '';
    if (hintEl) hintEl.textContent = opts.hint || '';
    if (spinner) spinner.style.display = opts.scanning ? 'block' : 'none';
    if (opts.step) _setBioEnrollStepActive(opts.step);
    if (opts.fingerState) _setBioFingerAnimState(opts.fingerState);
    else if (verifyMode && opts.scanning) _setBioFingerAnimState('scan');
    else if (verifyMode && !opts.scanning) _setBioFingerAnimState('place');
    if (overlay) overlay.style.display = 'flex';
}

function showBiometricProgressOverlay(title, message) {
    setBiometricOverlayRetryVisible(false);
    showBiometricEnrollUi({
        title: title,
        message: message,
        enrollMode: false,
        verifyMode: true,
        scanning: true
    });
}

function showBiometricVerifyFailedOverlay(message, hint) {
    showBiometricEnrollUi({
        title: 'Fingerprint not recognized',
        message: message || 'Fingerprint verification failed.',
        hint: hint || 'Place your finger on the scanner and tap Try again.',
        enrollMode: false,
        verifyMode: true,
        scanning: false,
        fingerState: 'place'
    });
    setBiometricOverlayRetryVisible(true);
}

function hideBiometricProgressOverlay() {
    var overlay = document.getElementById('biometric-progress-overlay');
    if (overlay) overlay.style.display = 'none';
    _setBioFingerAnimState('');
    _biometricEnrollUsername = null;
    _biometricEnrollCancelled = false;
    setBiometricOverlayRetryVisible(false);
    window._biometricVerifyRetryFn = null;
    window._biometricVerifyCancelResolve = null;
    window._biometricVerifyActive = false;
}

function retryBiometricProgress() {
    setBiometricOverlayRetryVisible(false);
    if (typeof window._biometricVerifyRetryFn === 'function') {
        window._biometricVerifyRetryFn();
    }
}

function runBiometricVerifyWithRetry(opts) {
    opts = opts || {};
    var purpose = opts.purpose || 'report';
    if (window._biometricVerifyActive) {
        return Promise.resolve({ ok: false, error: 'cancelled', message: '' });
    }
    return new Promise(function (resolve) {
        if (!biometricEnabledSetting) {
            resolve({ ok: false, error: 'Biometric verification is disabled by Factory Settings.' });
            return;
        }
        window._biometricVerifyActive = true;
        var cancelled = false;
        var lastError = 'Fingerprint verification failed.';

        function finish(result) {
            window._biometricVerifyActive = false;
            resolve(result);
        }

        function finishCancel() {
            cancelled = true;
            hideBiometricProgressOverlay();
            finish({ ok: false, error: 'cancelled', message: lastError });
        }

        function attempt() {
            if (cancelled) return;
            showBiometricProgressOverlay(
                opts.title || 'Verify Fingerprint',
                opts.message || 'Place your finger on the scanner.'
            );
            apiRequest(API_BASE + '/api/data/auth/approval-verify', {
                method: 'POST',
                body: Object.assign({ method: 'biometric', purpose: purpose }, opts.verifyBody || {})
            }).then(function (data) {
                if (cancelled) return;
                if (data && data.ok && data.token) {
                    hideBiometricProgressOverlay();
                    finish({
                        ok: true,
                        token: String(data.token),
                        approved: !!data.approved,
                        pdfGenerated: !!data.pdfGenerated,
                        report: data.report || null
                    });
                    return;
                }
                lastError = (data && data.error) ? String(data.error) : 'Fingerprint verification failed.';
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            }).catch(function (err) {
                if (cancelled) return;
                lastError = 'Fingerprint verification failed: ' + (err && err.message ? err.message : 'Error');
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            });
        }

        window._biometricVerifyCancelResolve = finishCancel;
        window._biometricVerifyRetryFn = attempt;
        attempt();
    });
}

function _cancelBiometricEnrollSession() {
    var username = _biometricEnrollUsername;
    if (!username) return Promise.resolve();
    return apiRequest(API_BASE + '/api/biometric/enroll/cancel', {
        method: 'POST',
        body: { username: username }
    }).catch(function () {});
}

function cancelBiometricProgress() {
    _biometricEnrollCancelled = true;
    if (typeof window._loginBiometricAbort === 'function') {
        window._loginBiometricAbort();
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
        return;
    }
    if (typeof window._biometricVerifyCancelResolve === 'function') {
        var cancelVerify = window._biometricVerifyCancelResolve;
        window._biometricVerifyCancelResolve = null;
        cancelVerify();
        return;
    }
    _cancelBiometricEnrollSession().finally(function () {
        hideBiometricProgressOverlay();
    });
}

function _delayMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function _biometricEnrollCaptureStep(username, step) {
    return apiRequest(API_BASE + '/api/biometric/enroll/capture', {
        method: 'POST',
        body: { username: username, step: step }
    });
}

function enrollMemberBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric enrollment is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    var username = _getBiometricEnrollUsername();
    if (!username) {
        showAppModal('No member selected for fingerprint enrollment. Save the member first.', 'Register Fingerprint');
        return;
    }
    _biometricEnrollUsername = username;
    _biometricEnrollCancelled = false;

    showBiometricEnrollUi({
        enrollMode: true,
        title: 'Register Fingerprint — Scan 1 of 2',
        message: 'Place your finger flat on the scanner.',
        hint: 'Hold still until the first scan is captured.',
        step: 1,
        fingerState: 'scan',
        scanning: true
    });

    _biometricEnrollCaptureStep(username, 1).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data || !data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'First scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Remove your finger',
            message: 'Lift your finger off the scanner.',
            hint: 'Wait a moment, then you will scan the same finger again.',
            step: 1,
            fingerState: 'remove',
            scanning: false
        });
        return _delayMs(1800);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Register Fingerprint — Scan 2 of 2',
            message: 'Place the same finger on the scanner again.',
            hint: 'Use the same finger as the first scan. Hold still until complete.',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _biometricEnrollCaptureStep(username, 2);
    }).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data) return;
        if (!data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'Second scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Saving fingerprint',
            message: 'Matching scans and saving template…',
            hint: '',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _delayMs(400).then(function () { return data; });
    }).then(function (data) {
        if (_biometricEnrollCancelled || !data || !data.ok) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Fingerprint registered',
            message: 'Both scans captured successfully.',
            hint: '',
            step: 2,
            fingerState: 'done',
            scanning: false
        });
        document.querySelectorAll('#bio-enroll-steps .bio-enroll-step').forEach(function (el) {
            el.classList.add('done');
            el.classList.remove('active');
        });
        return _delayMs(900);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        _addMemberLastSavedId = null;
        showAppModal('Fingerprint enrolled successfully.', 'Register Fingerprint');
        goToPage('user-profile');
    }).catch(function (err) {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        showAppModal('Fingerprint enrollment failed: ' + (err && err.message ? err.message : 'Network error'), 'Register Fingerprint');
    });
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


var _auditLoadMessageTimers = [];

function showAuditTrailsLoadingOverlay() {
    hideAuditTrailsLoadingOverlay();
    showLoadingOverlay('Audit Trails', 'Fetching audit trails...', { cancellable: false });
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Processing audit trails...', 'Please wait.');
    }, 450));
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Loading audit trails...', 'Please wait.');
    }, 950));
}

function hideAuditTrailsLoadingOverlay() {
    _auditLoadMessageTimers.forEach(function (id) { clearTimeout(id); });
    _auditLoadMessageTimers = [];
    hideLoadingOverlay();
}

function _populateAuditFilterDropdowns(userEl, actionEl, fullList) {
    var users = [];
    var actions = [];
    (fullList || []).forEach(function (e) {
        var u = e.user || '--';
        if (users.indexOf(u) === -1) users.push(u);
        var a = e.action || '';
        if (a && actions.indexOf(a) === -1) actions.push(a);
    });
    var coreActions = [
        'Login', 'Logout', 'Logout (inactivity timeout)', 'User logged in',
        'Entered screen', 'Exited screen',
        'Opened Quick Test', 'Opened Load Recipe', 'Opened Manage Recipe', 'Loaded recipe',
        'Opened disabled recipes',
        'Test started', 'Quick test started', 'Test finished', 'Test aborted', 'Test auto-aborted',
        'Test performed', 'Quick test performed',
        'Entered USP 1 validation', 'Entered USP 2 validation',
        'Validation started', 'Validation finished', 'Validation aborted',
        'holder error', 'check adaptor and holder', 'Holder check error',
        'Validation performed', 'Report saved', 'Report generated', 'Report approved',
        'Report aborted', 'Report aborted (power loss)', 'Report PDF generated',
        'Recipe created', 'Recipe edited', 'Recipe approved', 'Power interruption',
        'Audit trail exported', 'Audit export verified', 'Audit cycle started',
        'Reports exported', 'Report export verified', 'Report cycle started',
        'Approval verification', 'Disable Recipe', 'Recipe disabled',
        'Added new user', 'Password changed', 'User create', 'User update', 'User permissions updated',
        'User disabled', 'User enabled', 'User unlocked', 'User locked', 'Desktop login', 'Desktop logout',
        'Validation due date set', 'Power interruption logout'
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
        actions.forEach(function (a) { actionEl.appendChild(new Option(a, a)); });
    }
}

function _renderAuditLogRows(tbody, list) {
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!list || !list.length) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="5">No audit entries match the filters.</td>';
        tbody.appendChild(emptyRow);
        return;
    }
    list.forEach(function (entry) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + (entry.dateTime || '') + '</td><td>' + (entry.user || '--') + '</td><td>' + displayRoleLabel(entry.role || '--') + '</td><td>' + (entry.action || '') + '</td><td>' + formatAuditDetailsText(entry.details || '') + '</td>';
        tbody.appendChild(row);
    });
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
    if (!userCanExportToUsb(u)) {
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
                // Server builds PDF from A4 plain-text layout (====, ----, ****) — same as print.
                showLoadingOverlay(titleText, 'Exporting reports...', { cancellable: false, progress: true });
                setLoadingProgress(0, 'Starting export...', '');
                var payload = { report_ids: ids, device_path: devicePath };
                return _streamExportReports(payload, titleText, exportHeaders);
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
        setTimeout(function () {
            hideLoadingOverlay();
            if (evt.ok && evt.export_id) {
                _confirmReportExportAfterUsb(evt, titleText);
            } else if (evt.ok) {
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

/** Generate/overwrite report PDF from server A4 text layout (approved or aborted reports only). */
function _saveReportPdfSilent(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.resolve(false);
    return apiRequest(API_BASE + '/api/reports/' + id + '/preview').then(function (data) {
        var st = String((data && data.preview && data.preview.reportApprovalStatus) || '').trim().toLowerCase();
        if (st !== 'approved' && st !== 'aborted') return false;
        return apiRequest(API_BASE + '/api/reports/' + id + '/pdf', {
            method: 'POST',
            body: {}
        });
    }).then(function () { return true; }).catch(function () { return false; });
}

function startQuickTest() {
    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });
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
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._quickStepTaps.length; u++) {
                totalU += parseInt(window._quickStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._quickStepTaps && window._quickStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._quickStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function goToQuickTestStepsPage() {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        return;
    }
    var current = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('quick-test-steps');
    setTimeout(function () {
        var radio = document.querySelector('input[name="quick-step-card"][value="' + current + '"]');
        if (radio) radio.checked = true;
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(current);
            _updateQuickStepsPageUspUi();
        } else {
            _renderQuickStepTapInputs(current);
        }
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
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        window._quickStepCount = n;
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        _refreshQuickStepSummary();
        return;
    }
    setTimeout(function () { _renderQuickStepTapInputs(n); }, 0);
}

function _renderQuickStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        return;
    }
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
    var taps;
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#quick-step-tap-inputs input.quick-step-tap');
        taps = [];
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
    }
    window._quickStepCount = stepCount;
    window._quickStepTaps = taps;
    _refreshQuickStepSummary();
    goToPage('quick-test');
}


function _refreshCreateStepSummary() {
    var summaryEl = document.getElementById('create-step-count-summary');
    var subEl = document.getElementById('create-step-count-summary-sub');
    var n = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (isUspStandardProcedureMode(getCreateUspMode())) {
            window._createRecipeStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._createRecipeStepTaps.length; u++) {
                totalU += parseInt(window._createRecipeStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._createRecipeStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function openCreateRecipeStepsPage() {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        return;
    }
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('create-recipe-step2');
    setTimeout(function () {
        initCreateRecipeStepsPage();
    }, 60);
}

function initCreateRecipeStepsPage() {
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    var radio = document.querySelector('input[name="create-step-card"][value="' + current + '"]');
    if (radio) radio.checked = true;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepTaps = computeStandardUspTaps(current);
        _updateCreateStepsPageUspUi();
    } else {
        _renderCreateStepTapInputs(current);
    }
    var cards = document.querySelectorAll('#create-step-cards-grid label.create-recipe-card');
    cards.forEach(function (label) {
        label.removeEventListener('click', _onCreateStepCardClick);
        label.addEventListener('click', _onCreateStepCardClick);
    });
}

function _onCreateStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="create-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        _refreshCreateStepSummary();
        return;
    }
    setTimeout(function () { _renderCreateStepTapInputs(n); }, 0);
}

function _renderCreateStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        return;
    }
    var container = document.getElementById('create-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n)
        ? window._createRecipeStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="create-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="create-step-tap-' + stepNum + '" ' +
                'class="input-field create-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmCreateRecipeStepSetup() {
    var radio = document.querySelector('input[name="create-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Create Recipe');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Create Recipe');
        return;
    }
    var taps;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#create-step-tap-inputs input.create-step-tap');
        taps = [];
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Create Recipe');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
        if (taps.length !== stepCount) {
            showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Create Recipe');
            return;
        }
    }
    window._createRecipeStepCount = stepCount;
    window._createRecipeStepTaps = taps;
    window._createRecipePreserveStep1 = true;
    _refreshCreateStepSummary();
    updateCreateRecipeContinueButton();
    goToPage('create-recipe-step1');
}

function onCreateRecipeContinueClick() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) {
        showAppModal('Enter the recipe name and select procedure (and speed/height for Custom) before saving.', 'Create Recipe');
        return;
    }
    var mode = getCreateUspMode();
    if (isUspStandardProcedureMode(mode)) {
        applyStandardUspStepDefaults('create');
    } else {
        var n = window._createRecipeStepCount;
        if (!n || n < 1 || n > 10) {
            showAppModal('Tap Number of steps to choose how many steps (1\u201310).', 'Create Recipe');
            return;
        }
        if (!window._createRecipeStepTaps || window._createRecipeStepTaps.length !== n) {
            showAppModal('Tap Number of steps to configure taps for each step.', 'Create Recipe');
            return;
        }
    }
    completeRecipeFromStep2();
}

function startRecipeTest() {
    recipeListMode = 'load';
    logAuditEvent('Opened Load Recipe', 'Load Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function manageRecipes() {
    var u = window.currentUser;
    if (u && typeof canAccess === 'function' && !canAccess(u, 'recipe-manage')) {
        if (typeof denyPermission === 'function') denyPermission('manage recipes');
        return;
    }
    recipeListMode = 'manage';
    logAuditEvent('Opened Manage Recipe', 'Manage Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function resetCreateRecipeStep1Form() {
    var nameEl = document.getElementById('recipe-product-name');
    if (nameEl) nameEl.value = '';
    var um = document.querySelector('input[name="create-usp-mode"][value="USP1"]');
    if (um) um.checked = true;
    if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
    if (getCreateUspMode() === 'CUSTOM') {
        window._createRecipeStepCount = null;
        window._createRecipeStepTaps = null;
    }
    if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function startRecipeCreation() {
    window.currentEditingRecipeId = null;
    window._createRecipePreserveStep1 = false;
    goToPage('create-recipe-step1');
    setTimeout(resetCreateRecipeStep1Form, 0);
}

function selectOperation(type) {
    if (type === 'validate') {
        if (!userCanRunValidation()) {
            denyPermission('run validation');
            return;
        }
        validationCompletion = { distance: false, load: false };
        validationSessionResults = { distance: null, load: null };
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
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    var radio = document.querySelector('input[name="val-type"]:checked');
    lastValidationType = radio ? radio.value : 'distance'; // 'distance' = USP 1, 'load' = USP 2
    goToPage('validation-run');
}

function startUspValidation(type) {
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    var t = String(type || '').toLowerCase();
    lastValidationType = t === 'usp2' ? 'load' : 'distance';
    goToPage('validation-run');
}

function goBackFromValidationRun() {
    if (isValidationOperationActive()) {
        return abortValidationRun().then(function () {
            _suppressValidationNavGuardOnce = true;
            goToPage('validate-type-select');
        });
    }
    _suppressValidationNavGuardOnce = true;
    goToPage('validate-type-select');
}

/** Stop validation hardware/timer and reset UI (returns a promise). */
function abortValidationRun() {
    if (!isValidationOperationActive()) {
        return Promise.resolve();
    }
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    var btn = document.getElementById('btn-validation-start-abort');
    if (btn) btn.disabled = true;
    validationRunBackendPending = true;
    return stopValidationOnBackend().catch(function () {}).finally(function () {
        validationRunState = 'idle';
        validationRunBackendPending = false;
        _closeValidationRunHardwareEs();
        updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
        setValRunEl('val-run-status', 'Aborted');
        setValRunEl('val-run-status-sub', 'Tap count: ' + validationRunCurrentCount);
        _setValRunStatusStyle('ready');
        _setValResultVisible(false);
        _resetValidationRunActionButtonToStart();
        logAuditEvent('Validation aborted', validationAdapterLabel() + ' validation aborted by user', {
            eventType: 'lifecycle',
            entityType: 'validation',
            extra: {
                validationType: lastValidationType,
                actualTapCount: validationRunCurrentCount
            }
        });
        if (btn) btn.disabled = false;
        applyValidationRunLockUi(false);
    });
}

function setValRunEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _setValResultVisible(visible) {
    var el = document.getElementById('val-result-card');
    if (!el) return;
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
}

function _setValRunStatusStyle(kind) {
    var el = document.getElementById('val-run-status');
    if (!el) return;
    el.classList.remove('is-ready', 'is-running');
    if (kind === 'ready') el.classList.add('is-ready');
    else if (kind === 'running') el.classList.add('is-running');
}

function _setValRunResultBadge(isPass) {
    var resultEl = document.getElementById('val-run-result');
    if (!resultEl) return;
    resultEl.textContent = isPass ? 'Pass' : 'Fail';
    resultEl.className = 'val-run-result-badge ' + (isPass ? 'is-pass' : 'is-fail');
}

var VALIDATION_SCROLL_SURFACE = {
    'validate-type-select': '.validation-type-page',
    'usp1-detail': '.validation-type-page',
    'usp2-detail': '.validation-type-page'
};

function getValidationScrollSurface(pageName) {
    var page = document.getElementById('page-' + pageName);
    if (!page) return null;
    var sel = VALIDATION_SCROLL_SURFACE[pageName];
    if (!sel) return page;
    return page.querySelector(sel) || page;
}

function bindTouchPanScroll(el) {
    if (!el || el._touchPanScrollBound) return;
    el._touchPanScrollBound = true;
    var startY = 0;
    var startScroll = 0;
    var tracking = false;
    el.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        tracking = true;
        startY = e.touches[0].clientY;
        startScroll = el.scrollTop;
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
        if (!tracking || e.touches.length !== 1) return;
        var dy = startY - e.touches[0].clientY;
        var next = startScroll + dy;
        var max = Math.max(0, el.scrollHeight - el.clientHeight);
        if (next < 0) next = 0;
        if (next > max) next = max;
        el.scrollTop = next;
    }, { passive: true });
    el.addEventListener('touchend', function () { tracking = false; }, { passive: true });
    el.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
}

function ensureValidationPageScroll(pageName) {
    var surface = getValidationScrollSurface(pageName);
    if (!surface) return;
    bindTouchPanScroll(surface);
    surface.scrollTop = 0;
}

function ensureAddMemberPageScroll() {
    var page = document.getElementById('page-add-member');
    if (!page) return;
    bindTouchPanScroll(page);
    page.scrollTop = 0;
}

function initValidationRunPage() {
    var type = lastValidationType || 'distance';
    var usp = type === 'load' ? 'USP 2' : 'USP 1';
    var tapsMin = type === 'load' ? 250 : 300;
    var dropHeight = type === 'load' ? 3 : 14;
    validationRunTarget = type === 'load' ? 250 : 300;
    validationRunTolerance = 15;
    validationRunMin = validationRunTarget - validationRunTolerance;
    validationRunMax = validationRunTarget + validationRunTolerance;

    setValRunEl('val-run-usp', usp);
    setValRunEl('val-run-taps-min', String(tapsMin));
    setValRunEl('val-run-height', String(dropHeight));
    setValRunEl('val-run-expected', String(validationRunTarget) + ' (+/- ' + String(validationRunTolerance) + ')');
    setValRunEl('val-run-tap-count', '0');
    setValRunEl('val-run-status', 'Ready');
    setValRunEl('val-run-status-sub', 'Press Start to begin');
    _setValRunStatusStyle('ready');
    _setValResultVisible(false);

    validationRunCurrentCount = 0;
    validationRunState = 'idle';
    validationRunBackendPending = false;
    validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    applyValidationRunLockUi(false);
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }

    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
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
        var canEdit = typeof canEditMembers === 'function' && canEditMembers();
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
                var editBtn = canEdit
                    ? '<button class="btn-member-action btn-edit" onclick="openEditMember(' + (m.id || 0) + ')">Edit Profile</button>'
                    : '';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td><span class="' + roleClass + '">' + displayRoleLabel(role) + '</span></td>' +
                    '<td class="member-actions-cell">' +
                    editBtn +
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
                    '<td class="member-actions-cell member-actions-cell-single">' + actionBtn + '</td>';
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
            showAppModal('You do not have permission to unlock accounts.', 'Permission');
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
            showAppModal('You do not have permission to enable accounts.', 'Permission');
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
        if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
            denyPermission('view audit trails');
            return;
        }
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
        showAuditTrailsLoadingOverlay();
        apiRequest(auditUrl).then(function (data) {
            var list = (data && data.entries) ? data.entries : [];
            var filterTask = Promise.resolve();
            if (userEl && userEl.options.length <= 1) {
                filterTask = apiRequest(API_BASE + '/api/data/audit-log').then(function (full) {
                    var fullList = (full && full.entries) ? full.entries : [];
                    _populateAuditFilterDropdowns(userEl, actionEl, fullList);
                }).catch(function () {});
            }
            return filterTask.then(function () {
                _renderAuditLogRows(tbody, list);
            });
        }).catch(function () {
            tbody.innerHTML = '';
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="5">Unable to load audit log.</td>';
            tbody.appendChild(emptyRow);
        }).finally(function () {
            hideAuditTrailsLoadingOverlay();
        });
        return;
    }

    if (!userCanViewReports()) {
        denyPermission('view reports');
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
                    if (!name) name = 'Validation - ' + (r.validationSubtype === 'load' ? 'USP 2' : 'USP 1');
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

function isFactorySessionUser(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    var role = (u.role != null ? String(u.role) : '').toLowerCase();
    if (typeof isFactoryLikeRole === 'function') return isFactoryLikeRole(role, u);
    return role === 'factory';
}

function userCanViewReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'reports-view');
}

function userCanRunValidation(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'validation-test');
}

function denyPermission(actionLabel) {
    showAppModal(
        'You do not have permission to ' + (actionLabel || 'perform this action') + '.',
        'Permission'
    );
}

function userCanPrintReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return userCanViewReports(u);
}

function userCanExportToUsb(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    if (typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb')) return true;
    return false;
}

function refreshReportsActionButtons() {
    var u = window.currentUser;
    var expBtn = document.querySelector('.reports-filter-export');
    if (expBtn) {
        expBtn.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    var audEx = document.querySelector('.audit-filter-export');
    if (audEx) {
        audEx.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    if (typeof updateReportPreviewPrintExportButtons === 'function') {
        updateReportPreviewPrintExportButtons(window._lastReportPreview || null);
    }
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
    if (auditBtn) {
        auditBtn.style.display = canViewAuditLog() ? '' : 'none';
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
    if (!userCanExportToUsb(u)) {
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
                                var exportId = res.export_id || '';
                                showAuditExportVerifyModal().then(function (verified) {
                                    if (!verified) {
                                        showAppModal(
                                            'Export not verified. Check the USB pendrive and use Export Audit Trails again when ready.\n\nNo data will be erased until you confirm a successful export.',
                                            titleText
                                        );
                                        return;
                                    }
                                    if (!exportId) {
                                        showAppModal('Could not confirm export (missing session). Please export again.', titleText);
                                        return;
                                    }
                                    showLoadingOverlay(titleText, 'Confirming export...', { cancellable: false });
                                    apiRequest(API_BASE + '/api/audit/export/confirm', {
                                        method: 'POST',
                                        body: { export_id: exportId, verified: true }
                                    }).then(function (confirmRes) {
                                        hideLoadingOverlay();
                                        if (confirmRes && confirmRes.success && confirmRes.scheduled) {
                                            showAuditExportRetentionModal(confirmRes.entries_scheduled).then(function () {
                                                if (typeof applyAuditFiltersAndRefresh === 'function') {
                                                    applyAuditFiltersAndRefresh();
                                                }
                                            });
                                        } else {
                                            showAppModal(
                                                _friendlyExportError((confirmRes && confirmRes.error) || 'Could not schedule retention'),
                                                titleText
                                            );
                                        }
                                    }).catch(function (confirmErr) {
                                        hideLoadingOverlay();
                                        showAppModal(_friendlyExportError(confirmErr), titleText);
                                    });
                                });
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

function buildReportPrintPayload(preview, reportId) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (!td || typeof td !== 'object') td = {};
    var recipe = preview.recipe || td.recipe || {};
    return {
        id: reportId != null ? reportId : preview.id,
        type: preview.type || 'test',
        testData: td,
        recipe: recipe,
        factorySettings: preview.factorySettings || {},
        statistics: preview.statistics || td.statistics || {},
        remarks: preview.remarks != null ? preview.remarks : td.remarks,
        reportApprovalStatus: preview.reportApprovalStatus,
        approvalPassFail: preview.approvalPassFail,
        approvalRemarks: preview.approvalRemarks,
        approvedBy: preview.approvedBy,
        approvedAt: preview.approvedAt,
        createdAt: preview.createdAt || td.createdAt,
        completedAt: preview.completedAt || td.completedAt,
        operatorName: preview.operatorName || td.operatorName,
        employeeId: preview.employeeId || td.employeeId,
        validationRuns: preview.validationRuns || td.validationRuns,
        reportDerived: preview.reportDerived || buildTestReportDerived(td, recipe, reportId)
    };
}

function resolveReportDataForPrint(callback) {
    var rid = currentReportId;
    if (!rid) {
        callback(null);
        return;
    }
    var fromPreview = typeof buildReportPrintPayload === 'function'
        ? buildReportPrintPayload(window._lastReportPreview, rid) : null;
    if (fromPreview && fromPreview.testData) {
        currentReportData = fromPreview;
        callback(fromPreview);
        return;
    }
    if (currentReportData && currentReportData.testData) {
        callback(currentReportData);
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + rid).then(function (data) {
        var reportData = data.report || data;
        if (reportData) {
            reportData.id = reportData.id != null ? reportData.id : rid;
            currentReportData = reportData;
            callback(reportData);
        } else {
            callback(null);
        }
    }).catch(function () { callback(null); });
}

function handlePrintReport() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    var btn = document.querySelector('.btn-print');
    if (btn) btn.disabled = true;
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            if (btn) btn.disabled = false;
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
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
        }).finally(function () { if (btn) btn.disabled = false; });
    });
}

function handlePrintThermal() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    var btn = document.querySelector('.btn-print-thermal');
    if (btn) btn.disabled = true;
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            if (btn) btn.disabled = false;
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
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
        }).finally(function () { if (btn) btn.disabled = false; });
    });
}

function handleExportReport() {
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before export.', 'Export');
        return;
    }
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
    var btn = document.querySelector('.btn-print');
    if (btn) btn.disabled = true;
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
        }).finally(function () { if (btn) btn.disabled = false; });
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
    var btn = document.querySelector('.btn-print-thermal');
    if (btn) btn.disabled = true;
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
        }).finally(function () { if (btn) btn.disabled = false; });
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

function hideReportPreviewLoadingOverlayAfterRender() {
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            hideLoadingOverlay();
        });
    });
}

function ensurePreviewHasA4Text(preview, reportId) {
    if (preview && preview.a4Text) return Promise.resolve(preview);
    return apiRequest(API_BASE + '/api/reports/' + reportId + '/a4-text').then(function (data) {
        if (preview && data && data.a4Text) preview.a4Text = data.a4Text;
        return preview;
    }).catch(function () {
        return preview;
    });
}

function openReportPreview(reportId, options) {
    if (!reportId) return;
    if (!userCanViewReports()) {
        denyPermission('view reports');
        return;
    }
    options = options || {};
    showLoadingOverlay('Report Preview', 'Loading report preview...', { cancellable: false });
    apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (!data.preview) {
            showAppModal('Report preview is not available.', 'Reports');
            return;
        }
        return ensurePreviewHasA4Text(data.preview, reportId).then(function (preview) {
            if (!preview || !preview.a4Text) {
                showAppModal('Report preview is not available.', 'Reports');
                return;
            }
            currentReportId = reportId;
            currentReportData = null;
            populateReportPreview(preview);
            setReportApprovalGateFromPreview(preview, reportId);
            applyReportPreviewLockUi(preview);
            goToPage('report-preview');
            startReportApprovalPollIfLocked();
            setTimeout(function () {
                if (isReportPreviewLockedForCurrentUser(preview)) {
                    scrollReportPendingBannerIntoView();
                }
                if (isReportPendingApproval(preview)) {
                    scrollReportApprovePanelIntoView();
                }
            }, 250);
        });
    }).catch(function () {
        showAppModal('Could not open report preview. Check your connection and try again from Reports.', 'Reports');
    }).finally(function () {
        hideReportPreviewLoadingOverlayAfterRender();
    });
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

/** Rows in TEST DATA table: only steps that actually ran (not recipe stepCount). */
function getReportStepRowCount(td) {
    if (!td || typeof td !== 'object') return 0;
    var results = td.stepResults || [];
    if (results.length > 0) return results.length;
    var cs = td.completedSteps;
    if (cs != null && cs !== '' && !isNaN(parseInt(cs, 10))) {
        return Math.max(0, parseInt(cs, 10));
    }
    return 0;
}

function formatReportDateAndTimeParts(isoOrDateStr) {
    var full = formatReportDate(isoOrDateStr);
    if (!full || full === '--') return { date: '--', time: '--' };
    var parts = full.split(' ');
    if (parts.length >= 2) {
        return { date: parts[0], time: parts.slice(1).join(' ') };
    }
    return { date: full, time: '--' };
}

/** Format seconds as HH:MM:SS for test report duration. */
function formatDurationSeconds(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '--';
    var total = Math.floor(Number(sec));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function testDurationSecondsFromData(td, preview) {
    if (!td || typeof td !== 'object') return null;
    if (td.durationSeconds != null && !isNaN(td.durationSeconds) && td.durationSeconds >= 0) {
        return Math.floor(Number(td.durationSeconds));
    }
    var startRaw = td.testStartTime || (preview && preview.createdAt);
    var endRaw = td.testEndTime || (preview && (preview.completedAt || preview.createdAt));
    if (startRaw && endRaw) {
        var startMs = new Date(startRaw).getTime();
        var endMs = new Date(endRaw).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
            return Math.floor((endMs - startMs) / 1000);
        }
    }
    return null;
}

function buildTestReportDerived(td, recipe, reportId) {
    td = td && typeof td === 'object' ? td : {};
    recipe = recipe && typeof recipe === 'object' ? recipe : {};
    if (!recipe && td.recipe && typeof td.recipe === 'object') recipe = td.recipe;
    var results = td.stepResults || [];
    var steps = recipe.steps || td.steps || [];
    var weight = parseFloat(td.initialWeightG);
    if (isNaN(weight)) weight = null;
    var initialVol = null;
    var finalVol = null;
    if (td.initialVolumeMl != null && td.initialVolumeMl !== '') {
        var iv0 = parseFloat(td.initialVolumeMl);
        if (!isNaN(iv0) && iv0 > 0) initialVol = iv0;
    }
    if (results.length) {
        var vf = parseFloat(results[results.length - 1].volumeMl);
        if (!isNaN(vf)) finalVol = vf;
        if (initialVol == null) {
            var legacyV0 = parseFloat(results[0].volumeMl);
            if (!isNaN(legacyV0) && legacyV0 > 0) initialVol = legacyV0;
        }
    }
    var diffLastTwo = null;
    if (results.length >= 2) {
        var v1 = parseFloat(results[results.length - 2].volumeMl);
        var v2 = parseFloat(results[results.length - 1].volumeMl);
        if (!isNaN(v1) && !isNaN(v2)) diffLastTwo = Math.abs(v1 - v2);
    } else if (results.length === 1 && results[0].volumeDeltaMl != null) {
        var dv = parseFloat(results[0].volumeDeltaMl);
        if (!isNaN(dv)) diffLastTwo = dv;
    }
    var initialDensity = null;
    var tappedDensity = null;
    if (weight != null && initialVol != null && initialVol > 0) {
        initialDensity = Math.round((weight / initialVol) * 1000) / 1000;
    }
    if (weight != null && finalVol != null && finalVol > 0) {
        tappedDensity = Math.round((weight / finalVol) * 1000) / 1000;
    }
    var compressibility = null;
    var hausner = null;
    if (initialVol != null && finalVol != null && initialVol > 0 && finalVol > 0) {
        compressibility = Math.round((1 - (finalVol / initialVol)) * 10000) / 100;
        hausner = Math.round((initialVol / finalVol) * 1000) / 1000;
    }
    var testType = typeof recipeUspLabel === 'function' ? recipeUspLabel(recipe) : (recipe.usp || td.usp || '--');
    var cylMl = (recipe.cylinder && (recipe.cylinder.volume || recipe.cylinder.volumeMl)) || td.sampleVolumeMl;
    var testMethod = testType;
    if (cylMl != null && cylMl !== '') testMethod = testType + ', ' + cylMl + ' ml cylinder';
    var speed = recipe.speed;
    if (speed == null && steps[0] && steps[0].speed != null) speed = steps[0].speed;
    var dropH = '--';
    var dh = recipe.dropHeight;
    if (dh == null && steps[0] && steps[0].dropHeight != null) dh = steps[0].dropHeight;
    if (dh == null && td.dropHeight != null) dh = td.dropHeight;
    if (dh != null && dh !== '') {
        var dhn = parseFloat(dh);
        dropH = !isNaN(dhn) ? (Math.round(dhn) + ' mm +/- ' + (dhn > 5 ? '2' : '0.2') + ' mm') : String(dh);
    }
    var completedN = getReportStepRowCount(td);
    var stepDropCounts = [];
    for (var si = 0; si < completedN && si < steps.length; si++) {
        if (steps[si] && steps[si].tapCount != null) stepDropCounts.push(steps[si].tapCount);
    }
    var totalDrops = 0;
    var hasDropTotal = false;
    for (var di = 0; di < stepDropCounts.length; di++) {
        var dn = parseInt(stepDropCounts[di], 10);
        if (!isNaN(dn) && dn > 0) {
            totalDrops += dn;
            hasDropTotal = true;
        }
    }
    var testNo = '--';
    if (reportId != null) {
        var nid = parseInt(reportId, 10);
        testNo = !isNaN(nid) ? String(nid).padStart(4, '0') : String(reportId);
    }
    return {
        testNumber: testNo,
        testType: testType,
        testMethod: testMethod,
        dropsPerMin: speed != null ? speed : '--',
        dropHeight: dropH,
        totalDrops: hasDropTotal ? totalDrops : null,
        totalTaps: hasDropTotal ? totalDrops : null,
        stepDropCounts: stepDropCounts,
        stepTapCounts: stepDropCounts,
        sampleWeightG: weight,
        initialVolumeMl: initialVol,
        finalVolumeMl: finalVol,
        diffLastTwoVolumesMl: diffLastTwo,
        initialDensityGPerMl: initialDensity,
        tappedDensityGPerMl: tappedDensity,
        compressibilityIndexPct: compressibility,
        hausnerRatio: hausner
    };
}

function populateReportPreview(preview) {
    if (!preview) return;
    var preEl = document.getElementById('report-a4-pre');
    if (preEl) {
        var text = preview.a4Text != null ? String(preview.a4Text) : '';
        preEl.textContent = text || 'Report preview is not available.';
    }
    window._lastReportPreview = preview;
    if (currentReportId != null && typeof buildReportPrintPayload === 'function') {
        currentReportData = buildReportPrintPayload(preview, currentReportId);
    }
    applyReportPreviewLockUi(preview);
}

function updateReportPreviewPrintExportButtons(preview) {
    var peGroup = document.getElementById('report-preview-print-export-group');
    if (!peGroup) return;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    var blockActions = approvalSt === 'pending' &&
        (reportTypeNorm === 'test' || reportTypeNorm === 'validation');
    var canPrint = typeof userCanPrintReports === 'function' && userCanPrintReports() && !blockActions;
    var canExport = typeof userCanExportToUsb === 'function' && userCanExportToUsb() && !blockActions;
    peGroup.style.display = (canPrint || canExport) ? 'flex' : 'none';
    peGroup.querySelectorAll('.btn-print, .btn-print-thermal').forEach(function (btn) {
        btn.style.display = canPrint ? '' : 'none';
    });
    var expBtn = peGroup.querySelector('.btn-export');
    if (expBtn) expBtn.style.display = canExport ? '' : 'none';
}

function verifyReportApproverInline(method, extraBody) {
    method = method === 'biometric' ? 'biometric' : 'credentials';
    extraBody = extraBody || {};
    clearReportApproveVerifyError();
    if (method === 'biometric') {
        return runBiometricVerifyWithRetry({
            purpose: 'report',
            title: 'Verify Fingerprint',
            message: 'Place a Reviewer or Admin fingerprint on the scanner to approve this report.',
            failureHint: 'Place your finger on the scanner and tap Try again.',
            verifyBody: extraBody
        }).then(function (result) {
            if (!result || !result.ok) {
                if (result && result.error !== 'cancelled') {
                    setReportApproveVerifyError(
                        result.message || result.error || 'Fingerprint verification failed.',
                        { showBiometricRetry: true }
                    );
                } else if (result && result.error === 'cancelled' && result.message) {
                    setReportApproveVerifyError(result.message, { showBiometricRetry: true });
                }
                return null;
            }
            setReportApproveBiometricRetryVisible(false);
            return result;
        });
    }
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var passwordEl = document.getElementById('report-approve-verifier-password');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        setReportApproveVerifyError('Enter Reviewer or Admin User ID and password.');
        return Promise.resolve(null);
    }
    if (typeof isCurrentUserReportOperator === 'function' && isCurrentUserReportOperator(window._lastReportPreview)) {
        var opUser = typeof getReportOperatedByUsername === 'function'
            ? getReportOperatedByUsername(window._lastReportPreview) : '';
        var enteredNorm = typeof normalizeReportUsername === 'function'
            ? normalizeReportUsername(username) : String(username).trim().toLowerCase();
        if (opUser && enteredNorm && enteredNorm === opUser) {
            setReportApproveVerifyError('You cannot approve your own report. A Reviewer or Admin must sign below.');
            return Promise.resolve(null);
        }
    }
    var body = Object.assign({
        method: 'credentials',
        username: username,
        password: password,
        purpose: 'report'
    }, extraBody);
    return apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: body
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            setReportApproveVerifyError((data && data.error) ? String(data.error) : 'Verification failed.');
            return null;
        }
        return data;
    }).catch(function (err) {
        setReportApproveVerifyError('Verification failed: ' + (err && err.message ? err.message : 'Error'));
        return null;
    });
}

function approveReportWithVerifier(reportId, passFail, remarks, verifyMethod) {
    verifyMethod = verifyMethod === 'biometric' ? 'biometric' : 'credentials';
    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
    var extraBody = {
        reportId: reportId,
        passFail: passFail,
        remarks: remarks || ''
    };

    function postReportApprove(extraHeaders) {
        return apiRequest(API_BASE + '/api/data/reports/' + reportId + '/approve', {
            method: 'POST',
            headers: extraHeaders || {},
            body: { passFail: passFail, remarks: remarks }
        }).then(function (data) {
            if (data && data.ok) return data;
            var msg = (data && data.error) ? String(data.error) : 'Approval failed.';
            setReportApproveVerifyError(msg);
            return null;
        });
    }

    if (role === 'factory') {
        return postReportApprove({}).then(function (data) { return data && data.ok; });
    }

    return verifyReportApproverInline(verifyMethod, extraBody).then(function (result) {
        if (!result) return null;
        if (result.approved && result.report) return true;
        var token = result.token || result;
        if (!token) return null;
        return postReportApprove({ 'X-Approval-Verify-Token': token }).then(function (data) {
            return data && data.ok;
        });
    });
}

function submitReportApprove() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    approveReportWithVerifier(id, pf, remarks, 'credentials').then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

function submitReportApproveBiometric() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    setReportApproveBiometricRetryVisible(false);
    approveReportWithVerifier(id, pf, remarks, 'biometric').then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
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

function confirmTestRunCompletionSaveRemarks() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
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
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
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
/** Set when starting a test from Quick Test; cleared after report save so the form resets. */
var _quickTestRunPendingFormReset = false;
var testRunButtonState = 'start'; // 'start' | 'abort'
/** ISO timestamp when the operator presses START (after weight/volume entry). */
var testRunStartTime = null;
var _testRunCheckpointTimer = null;
var _testRunStableStartIso = null;
var testRunIntervalId = null;
var testRunCurrentStepIndex = 0;
var testRunCurrentTapCount = 0;
/** Taps completed in the current step before the latest hardware session (survives adapter pause). */
var testRunStepTapsBase = 0;
var testRunAdapterWaitActive = false;
var testRunAdapterPollTimerId = null;
var _testRunStepResumeInFlight = false;
var _adapterPollOkStreak = 0;
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

/** EventSource for MCU SSE during hardware-backed test run */
var testRunHardwareEs = null;
var _testRunHardwareTapListener = null;

function _getHardwareSseUrl() {
    var base = API_BASE || '';
    var path = '/api/hardware/stream';
    if (base && String(base).indexOf('http') === 0) {
        return String(base).replace(/\/$/, '') + path;
    }
    return path;
}

function _closeTestRunHardwareEs() {
    if (testRunHardwareEs) {
        if (_testRunHardwareTapListener) {
            try {
                testRunHardwareEs.removeEventListener('message', _testRunHardwareTapListener);
            } catch (e) {}
            _testRunHardwareTapListener = null;
        }
        try {
            testRunHardwareEs.close();
        } catch (e2) {}
        testRunHardwareEs = null;
    }
}

function hardwareTapStopSilently() {
    return apiRequest(API_BASE + '/api/hardware/tap/stop', { method: 'POST' }).catch(function () {});
}

function recipeExpectedAdapterKind(recipe) {
    if (!recipe) return null;
    var mode = String(recipe.uspMode || '').toUpperCase();
    if (mode === 'USP1') return 'usp1';
    if (mode === 'USP2') return 'usp2';
    if (mode === 'CUSTOM') {
        var dh = null;
        if (recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
            dh = parseFloat(recipe.steps[0].dropHeight);
        } else if (recipe.dropHeight != null) {
            dh = parseFloat(recipe.dropHeight);
        }
        if (dh == null || isNaN(dh)) return 'usp1';
        return dh <= 5 ? 'usp2' : 'usp1';
    }
    var usp = String(recipe.usp || '').toLowerCase();
    if (usp.indexOf('usp 2') >= 0 || usp.indexOf('usp2') >= 0) return 'usp2';
    if (usp.indexOf('custom') >= 0) {
        var dh2 = null;
        if (recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
            dh2 = parseFloat(recipe.steps[0].dropHeight);
        } else if (recipe.dropHeight != null) {
            dh2 = parseFloat(recipe.dropHeight);
        }
        if (dh2 == null || isNaN(dh2)) return 'usp1';
        return dh2 <= 5 ? 'usp2' : 'usp1';
    }
    return 'usp1';
}


function validationExpectedAdapterKind() {
    return lastValidationType === 'load' ? 'usp2' : 'usp1';
}

function validationAdapterLabel() {
    return lastValidationType === 'load' ? 'USP 2' : 'USP 1';
}

function validationHolderLabel() {
    return validationAdapterLabel();
}

function testHolderLabelForRecipe(recipe) {
    var expected = recipeExpectedAdapterKind(recipe);
    return expected === 'usp2' ? 'USP 2' : 'USP 1';
}

function verifyValidationAdapter() {
    var expected = validationExpectedAdapterKind();
    return apiRequest(API_BASE + '/api/hardware/adapter/check', { method: 'POST' }).then(function (checkRes) {
        if (!checkRes || checkRes.ok === false) {
            return { ok: false, expected: expected, detected: null };
        }
        var detected = detectedAdapterKindFromCheckResult(checkRes);
        if (!detected || detected === 'error') {
            return { ok: false, expected: expected, detected: detected || 'none' };
        }
        return { ok: detected === expected, expected: expected, detected: detected };
    }).catch(function () {
        return { ok: false, expected: expected, detected: null };
    });
}

function showValidationAdapterCheckModal(extra) {
    logValidationAdapterError(extra);
    var kind = validationExpectedAdapterKind();
    var title = adapterErrorTitleForValidation();
    var body = kind === 'usp2'
        ? 'Please check the adaptor and holder. Fit the correct USP 2 holder on the instrument, then try again.'
        : 'Holder error. Fit the correct USP 1 holder on the instrument, then try again.';
    showAppModal(body, title);
}

function _validationErrorIsAdapterRelated(msg) {
    var s = String(msg || '').toLowerCase();
    return s.indexOf('holder') >= 0 || s.indexOf('adapter') >= 0 || s.indexOf('adapt,') >= 0 || s.indexOf('adapt_') >= 0;
}

function detectedAdapterKindFromCheckResult(result) {
    if (!result || result.ok === false) return null;
    var s = String(result.normalized != null ? result.normalized : (result.response || '')).toLowerCase();
    if (s.indexOf('adapt') >= 0 && s.indexOf('error') >= 0) return 'error';
    if (s.indexOf('usp1') >= 0 && (s.indexOf('ok') >= 0 || s.indexOf('ready') >= 0)) return 'usp1';
    if (s.indexOf('usp2') >= 0 && (s.indexOf('ok') >= 0 || s.indexOf('ready') >= 0)) return 'usp2';
    return null;
}

function stepSpeedToSpdMode(speed) {
    var n = parseInt(speed, 10);
    if (n === 300) return 'spd1';
    if (n === 250) return 'spd2';
    return null;
}

function recipeDropHeightMm(recipe, step) {
    if (step && step.dropHeight != null && step.dropHeight !== '') {
        var d = parseFloat(step.dropHeight);
        if (!isNaN(d)) return d;
    }
    if (recipe && recipe.dropHeight != null && recipe.dropHeight !== '') {
        var d2 = parseFloat(recipe.dropHeight);
        if (!isNaN(d2)) return d2;
    }
    if (recipe && recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
        var d3 = parseFloat(recipe.steps[0].dropHeight);
        if (!isNaN(d3)) return d3;
    }
    return null;
}

/** Custom mode: hardware spd command must match drop-height adapter (3 mm → USP2, 14 mm → USP1). */
function hardwareSpeedModeForRecipeStep(step, recipe) {
    var mode = String(recipe && recipe.uspMode ? recipe.uspMode : '').toUpperCase();
    if (mode !== 'CUSTOM') {
        return stepSpeedToSpdMode(getTestRunStepSpeed(step, recipe));
    }
    var dh = recipeDropHeightMm(recipe, step);
    if (dh != null && !isNaN(dh)) {
        return dh <= 5 ? 'spd2' : 'spd1';
    }
    return stepSpeedToSpdMode(getTestRunStepSpeed(step, recipe));
}

function isCustomRecipeMode(recipe) {
    if (!recipe) return false;
    var mode = String(recipe.uspMode || '').toUpperCase();
    if (mode === 'CUSTOM') return true;
    return String(recipe.usp || '').toLowerCase().indexOf('custom') >= 0;
}

function getTestRunStepSpeed(step, recipe) {
    if (step && step.speed != null && !isNaN(parseInt(step.speed, 10))) {
        return parseInt(step.speed, 10);
    }
    if (recipe && recipe.speed != null && !isNaN(parseInt(recipe.speed, 10))) {
        return parseInt(recipe.speed, 10);
    }
    var mode = String(recipe && recipe.uspMode ? recipe.uspMode : '').toUpperCase();
    if (mode === 'USP1') return 300;
    if (mode === 'USP2') return 250;
    var usp = String(recipe && recipe.usp ? recipe.usp : '').toLowerCase();
    if (usp.indexOf('usp 2') >= 0 || usp.indexOf('usp2') >= 0) return 250;
    return 300;
}

function getTestRunStepTapTarget(stepIndex) {
    var step = testRunSteps[stepIndex];
    if (!step) return 0;
    return parseInt(step.tapCount, 10) || 0;
}

function updateTestRunTapDisplay(sessionCount) {
    var target = getTestRunStepTapTarget(testRunCurrentStepIndex);
    var session = parseInt(sessionCount, 10) || 0;
    var cumulative = (testRunStepTapsBase || 0) + session;
    testRunCurrentTapCount = cumulative;
    setRunCard('run-tap-count-card', String(cumulative));
    setRunCard('run-tap-count-of-card', 'of ' + target);
}

function verifyTestRunAdapter() {
    var recipe = lastTestRunRecipe;
    return apiRequest(API_BASE + '/api/hardware/adapter/check', { method: 'POST' }).then(function (checkRes) {
        if (!checkRes || checkRes.ok === false) return false;
        var expected = recipeExpectedAdapterKind(recipe);
        if (!expected) return true;
        var detected = detectedAdapterKindFromCheckResult(checkRes);
        if (!detected || detected === 'error') return false;
        if (detected === expected) return true;
        /* Custom: adapter must match drop height only (not USP1/USP2 procedure mode). */
        if (isCustomRecipeMode(recipe)) return false;
        return false;
    }).catch(function () {
        return false;
    });
}

function stopTestRunAdapterPoll() {
    if (testRunAdapterPollTimerId != null) {
        clearInterval(testRunAdapterPollTimerId);
        testRunAdapterPollTimerId = null;
    }
    testRunAdapterWaitActive = false;
    _adapterPollOkStreak = 0;
}

function pauseTestRunForAdapterInterrupt() {
    testRunStepTapsBase = Math.max(testRunStepTapsBase || 0, testRunCurrentTapCount || 0);
    testRunCurrentTapCount = testRunStepTapsBase;
    updateTestRunTapDisplay(0);

    if (_testRunHardwareTapListener && testRunHardwareEs) {
        try {
            testRunHardwareEs.removeEventListener('message', _testRunHardwareTapListener);
        } catch (e) {}
        _testRunHardwareTapListener = null;
    }
    hardwareTapStopSilently();

    var holderKind = recipeExpectedAdapterKind(lastTestRunRecipe);
    setRunCard('run-status-text', adapterErrorTitleForKind(holderKind));
    setRunCard('run-status-subtext', holderKind === 'usp2'
        ? 'Check the adaptor and holder, then wait to resume'
        : 'Fit the correct USP 1 holder to continue');

    if (testRunAdapterWaitActive) return;

    if (!_testRunAdapterInterruptAudited) {
        _testRunAdapterInterruptAudited = true;
        auditTestRunAutoAborted('Holder removed during test run', testRunCurrentStepIndex);
    }

    testRunAdapterWaitActive = true;
    _adapterPollOkStreak = 0;
    testRunAdapterPollTimerId = setInterval(function () {
        if (testRunButtonState !== 'abort' || _testRunStepResumeInFlight) return;
        verifyTestRunAdapter().then(function (ok) {
            if (ok) {
                _adapterPollOkStreak++;
                if (_adapterPollOkStreak >= 2) {
                    resumeTestRunAfterAdapter();
                }
            } else {
                _adapterPollOkStreak = 0;
            }
        });
    }, 1500);
}

function resumeTestRunAfterAdapter() {
    if (_testRunStepResumeInFlight) return;
    _testRunStepResumeInFlight = true;
    stopTestRunAdapterPoll();

    setRunCard('run-status-text', 'Running');
    setRunCard('run-status-subtext', 'Resuming taps…');

    verifyTestRunAdapter().then(function (ok) {
        if (!ok) {
            _testRunStepResumeInFlight = false;
            pauseTestRunForAdapterInterrupt();
            return;
        }
        return runTestRunHardwareStep(testRunCurrentStepIndex, { resume: true });
    }).catch(function (err) {
        if (err && err.message === 'adapter_interrupt') return;
        var msg = err && err.message ? String(err.message) : 'Hardware error';
        auditTestRunAutoAborted(msg, testRunCurrentStepIndex);
        showAppModal('Test run failed: ' + msg, 'Test Run');
        hardwareTapStopSilently();
        _closeTestRunHardwareEs();
        _testRunRevertUiToStartAfterHardwareFail();
    }).finally(function () {
        _testRunStepResumeInFlight = false;
    });
}

function _testRunFinishStepVolumeAndResults(stepIndex) {
    return askVolumeForStep(stepIndex).then(function (vol) {
        if (vol === null || vol === '') {
            showAppModal('Enter the volume in ml to record results for this step.', 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
        }
        var curr = parseFloat(vol);
        if (isNaN(curr) || curr <= 0) {
            showAppModal('Please enter a valid volume in ml greater than 0.', 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
        }
        var volDecreaseCheck = validateTestRunVolumeNotIncreasing(curr);
        if (!volDecreaseCheck.ok) {
            showAppModal(volDecreaseCheck.message, 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
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
        testRunStepTapsBase = 0;
        return true;
    }).then(function (ok) {
        if (!ok) return;
        var isLastStep = (stepIndex + 1) >= testRunTotalSteps;
        showTestRunStepCompleteModal(isLastStep);
    });
}

function _testRunRevertUiToStartAfterHardwareFail() {
    stopTestRunCheckpointHeartbeat();
    _testRunStableStartIso = null;
    stopTestRunAdapterPoll();
    testRunStepTapsBase = 0;
    testRunButtonState = 'start';
    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }
    var statusText = document.getElementById('run-status-text');
    var statusSubtext = document.getElementById('run-status-subtext');
    if (statusText) statusText.textContent = 'Ready';
    if (statusSubtext) statusSubtext.textContent = 'Waiting to start';
    _closeTestRunHardwareEs();
}

function waitForHardwareTapSequence(remainingTaps, speedMode, opts) {
    opts = opts || {};
    var baseCompleted = opts.baseCompleted != null ? opts.baseCompleted : (testRunStepTapsBase || 0);
    return new Promise(function (resolve, reject) {
        if (!testRunHardwareEs) {
            reject(new Error('Hardware stream not connected.'));
            return;
        }
        var tapGoal = Math.max(1, parseInt(remainingTaps, 10) || 1);
        var handler = function (ev) {
            try {
                var raw = ev.data;
                if (raw == null || raw === '') return;
                var data = JSON.parse(raw);
                if (data.ping) return;
                var kind = String(data.kind || '');
                var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
                var lineStr = String(data.line != null ? data.line : '').trim();
                if (kind === 'ok' || norm === 'ok') return;
                if (kind === 'progress' || /^\d+$/.test(norm)) {
                    var n = parseInt(norm || lineStr, 10);
                    if (!isNaN(n) && n >= 0) {
                        updateTestRunTapDisplay(n);
                    }
                }
                if (kind === 'completed' || norm === 'completed' || norm === 'complete.') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    testRunCurrentTapCount = baseCompleted + tapGoal;
                    updateTestRunTapDisplay(tapGoal);
                    resolve();
                    return;
                }
                if (kind === 'adapter_error') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    reject(new Error('adapter_interrupt'));
                    return;
                }
                if (kind === 'error') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    reject(new Error(lineStr || norm || 'Hardware reported an error.'));
                }
            } catch (ex) {
                // ignore malformed SSE payloads
            }
        };
        _testRunHardwareTapListener = handler;
        testRunHardwareEs.addEventListener('message', handler);
        apiRequest(API_BASE + '/api/hardware/tap/start', {
            method: 'POST',
            body: { speedMode: speedMode, tapCount: tapGoal }
        }).then(function (res) {
            if (!res || res.ok === false) {
                if (testRunHardwareEs) {
                    testRunHardwareEs.removeEventListener('message', handler);
                }
                if (_testRunHardwareTapListener === handler) {
                    _testRunHardwareTapListener = null;
                }
                reject(new Error((res && res.error) ? String(res.error) : 'Tap start rejected by device.'));
            }
        }).catch(function (err) {
            if (testRunHardwareEs) {
                testRunHardwareEs.removeEventListener('message', handler);
            }
            if (_testRunHardwareTapListener === handler) {
                _testRunHardwareTapListener = null;
            }
            reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
}

function runTestRunHardwareStep(stepIndex, opts) {
    opts = opts || {};
    if (stepIndex < 0 || stepIndex >= testRunTotalSteps) return Promise.resolve();
    var recipe = lastTestRunRecipe;
    var step = testRunSteps[stepIndex];
    if (!step) return Promise.reject(new Error('Invalid step.'));

    testRunCurrentStepIndex = stepIndex;
    var speedMode = hardwareSpeedModeForRecipeStep(step, recipe);
    var target = getTestRunStepTapTarget(stepIndex);
    if (!speedMode) {
        return Promise.reject(new Error('Unsupported step speed for hardware (use 300 or 250 taps/min).'));
    }
    if (target < 1) {
        return Promise.reject(new Error('Invalid tap count for this step.'));
    }

    if (!opts.resume) {
        testRunStepTapsBase = 0;
    }

    var remaining = target - (testRunStepTapsBase || 0);

    setRunCard('run-current-step-card', String(stepIndex + 1));
    setRunCard('run-tap-count-of-card', 'of ' + target);
    updateTestRunTapDisplay(0);

    if (opts.resume) {
        setRunCard('run-status-text', 'Running');
        setRunCard('run-status-subtext', 'Test in progress');
    }

    if (remaining <= 0) {
        return _testRunFinishStepVolumeAndResults(stepIndex);
    }

    return waitForHardwareTapSequence(remaining, speedMode, { baseCompleted: testRunStepTapsBase })
        .then(function () {
            return _testRunFinishStepVolumeAndResults(stepIndex);
        })
        .catch(function (err) {
            if (err && err.message === 'adapter_interrupt') {
                pauseTestRunForAdapterInterrupt();
                return;
            }
            return Promise.reject(err);
        });
}

function runTestRunHardwareOrchestration() {
    var steps = getTestRunSteps();
    if (!steps || steps.length === 0) return;
    testRunSteps = steps;
    testRunTotalSteps = steps.length;
    testRunCurrentStepIndex = 0;
    testRunCurrentTapCount = 0;
    testRunStepTapsBase = 0;
    stopTestRunAdapterPoll();
    testRunStepResults = [];
    renderTestRunResultsTable();

    _closeTestRunHardwareEs();
    try {
        testRunHardwareEs = new EventSource(_getHardwareSseUrl());
    } catch (esErr) {
        showAppModal('Could not connect to the hardware stream. Check the server and try again.', 'Test Run');
        _testRunRevertUiToStartAfterHardwareFail();
        return;
    }

    runTestRunHardwareStep(0).catch(function (err) {
        if (err && err.message === 'adapter_interrupt') return;
        hardwareTapStopSilently();
        _closeTestRunHardwareEs();
        if (err && err.message === 'adapter') return;
        var msg = err && err.message ? String(err.message) : 'Hardware error';
        auditTestRunAutoAborted(msg, testRunCurrentStepIndex);
        showAppModal('Test run failed: ' + msg, 'Test Run');
        _testRunRevertUiToStartAfterHardwareFail();
    });
}

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

/** Allow digits and a single decimal point while the operator is typing (e.g. "12."). */
function sanitizeDecimalInputString(raw) {
    var s = String(raw == null ? '' : raw).replace(/,/g, '.');
    var cleaned = '';
    var seenDot = false;
    for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (c >= '0' && c <= '9') {
            cleaned += c;
        } else if (c === '.' && !seenDot) {
            cleaned += '.';
            seenDot = true;
        }
    }
    return cleaned;
}

function attachDecimalInputHandlers(input) {
    if (!input || input._decimalInputBound) return;
    input._decimalInputBound = true;
    input.addEventListener('input', function () {
        var el = input;
        var before = el.value;
        var after = sanitizeDecimalInputString(before);
        if (after === before) return;
        var pos = (typeof el.selectionStart === 'number') ? el.selectionStart : after.length;
        el.value = after;
        var nextPos = Math.min(pos, after.length);
        try {
            el.setSelectionRange(nextPos, nextPos);
        } catch (e) {}
    });
}

function bindTestRunDecimalInputs() {
    ['test-run-volume-input', 'test-run-initial-weight-input'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) attachDecimalInputHandlers(el);
    });
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

function _parseReportDensityNumber(val) {
    if (val == null || val === '' || val === '--') return null;
    var n = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
}

function _aggMeanMinMax(values) {
    if (!values || !values.length) return null;
    var sum = 0;
    var min = values[0];
    var max = values[0];
    for (var i = 0; i < values.length; i++) {
        sum += values[i];
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
    }
    return {
        mean: Math.round((sum / values.length) * 1000) / 1000,
        min: Math.round(min * 1000) / 1000,
        max: Math.round(max * 1000) / 1000
    };
}

/** Option A statistics for completed test reports; null if aborted or no step data. */
function computeTestReportStatistics(testData) {
    if (!testData || typeof testData !== 'object') return null;
    if (String(testData.status || '').trim().toLowerCase() === 'aborted') return null;
    var results = testData.stepResults || [];
    if (!results.length) return null;

    var bulkVals = [];
    var tapVals = [];
    for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        var b = _parseReportDensityNumber(r.bulkDensity);
        var t = _parseReportDensityNumber(r.tapDensity);
        if (b != null) bulkVals.push(b);
        if (t != null) tapVals.push(t);
    }

    var stats = {};
    var bulkAgg = _aggMeanMinMax(bulkVals);
    var tapAgg = _aggMeanMinMax(tapVals);
    if (bulkAgg) stats['Bulk density (g/mL)'] = bulkAgg;
    if (tapAgg) stats['Tap density (g/mL)'] = tapAgg;

    var last = results[results.length - 1] || {};
    var bulkF = _parseReportDensityNumber(last.bulkDensity);
    var tapF = _parseReportDensityNumber(last.tapDensity);
    if (bulkF == null && bulkVals.length) bulkF = bulkVals[0];
    if (tapF == null && tapVals.length) tapF = tapVals[tapVals.length - 1];
    if (bulkF != null && tapF != null && tapF > 0 && bulkF > 0) {
        stats['Compressibility index (%)'] = {
            value: Math.round(((tapF - bulkF) / tapF) * 10000) / 100
        };
        stats['Hausner ratio'] = { value: Math.round((tapF / bulkF) * 1000) / 1000 };
    }
    return Object.keys(stats).length ? stats : null;
}

function isTestRunInitialVolumeEntry() {
    return testRunButtonState === 'start';
}

function validateTestRunVolumeNotIncreasing(volumeMl) {
    if (isTestRunInitialVolumeEntry()) {
        return { ok: true };
    }
    var prev = testRunPreviousVolumeMl;
    if (prev == null || isNaN(prev)) {
        return { ok: true };
    }
    var num = parseFloat(volumeMl);
    if (isNaN(num)) {
        return { ok: true };
    }
    if (num > prev) {
        return {
            ok: false,
            message: 'Please check the value entered. The volume cannot increase.'
        };
    }
    return { ok: true };
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
        attachDecimalInputHandlers(input);
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
    r(val);
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
                var volCheck = validateTestRunVolumeNotIncreasing(num);
                if (!volCheck.ok) {
                    window.alert(volCheck.message);
                    continue;
                }
                resolve(String(vol).trim());
                return;
            }
        }

        titleEl.textContent = 'VOLUME IN ML - STEP ' + (stepIndex + 1);
        msgEl.textContent = message;
        input.value = '';
        attachDecimalInputHandlers(input);
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
        showAppModal('Enter the volume in ml to record results for this step.', 'Volume');
        if (input) input.focus();
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

    var decreasingCheck = validateTestRunVolumeNotIncreasing(num);
    if (!decreasingCheck.ok) {
        showAppModal(decreasingCheck.message, 'Volume');
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
    var recipeId = recipe.id || recipe.recipeId || '';
    logAuditEvent('Loaded recipe', (recipe.productName || 'Recipe') + ', batch ' + (recipe.batchNumber || '--'), {
        eventType: 'lifecycle',
        entityType: 'recipe',
        entityName: recipe.productName || '',
        entityId: recipeId,
        extra: {
            productName: recipe.productName,
            batchNumber: recipe.batchNumber,
            recipeId: recipeId,
            usp: recipe.usp || recipe.uspMode
        }
    });
    resetTestRunPageForNewLoad();

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

    var totalSteps = Math.max(1, parseInt(recipe.stepCount, 10) || (recipe.steps && recipe.steps.length) || 10);
    setText('run-total-steps-card', String(totalSteps));
    var firstStepTapCount = (recipe.steps && recipe.steps[0] && recipe.steps[0].tapCount != null)
        ? String(recipe.steps[0].tapCount) : '--';
    setRunCard('run-tap-count-of-card', 'of ' + firstStepTapCount);

    goToPage('test-run');
}

function startQuickTestRun() {
    var productName = (document.getElementById('quick-product-name') && document.getElementById('quick-product-name').value) || '';
    var batchNumber = (document.getElementById('quick-batch-number') && document.getElementById('quick-batch-number').value) || '';
    if (!String(productName).trim()) {
        showAppModal('Product name is required before starting a quick test.', 'Quick Test');
        return;
    }
    if (!String(batchNumber).trim()) {
        showAppModal('Batch number is required before starting a quick test.', 'Quick Test');
        return;
    }
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
    if (isUspStandardProcedureMode(qmode)) {
        stepCount = USP_DEFAULT_STEP_COUNT;
        applyStandardUspStepDefaults('quick');
    } else if (typeof window._quickStepCount === 'number' && window._quickStepCount >= 1) {
        stepCount = window._quickStepCount;
    } else {
        var stepCountEl = document.getElementById('quick-step-count');
        stepCount = stepCountEl ? (parseInt(stepCountEl.value, 10) || USP_DEFAULT_STEP_COUNT) : USP_DEFAULT_STEP_COUNT;
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
    if (isUspStandardProcedureMode(qmode)) {
        taps = computeStandardUspTaps(USP_DEFAULT_STEP_COUNT);
    } else if (window._quickStepTaps && window._quickStepTaps.length === stepCount) {
        taps = window._quickStepTaps.slice();
    } else {
        showAppModal('Tap Number of steps to configure steps and taps for each step.', 'Quick Test');
        return;
    }
    var uspLabel = qmode === 'USP1' ? 'USP 1' : (qmode === 'USP2' ? 'USP 2' : 'Custom');
    var steps = [];
    for (var s = 0; s < stepCount; s++) {
        steps.push({ speed: speed, dropHeight: dropHeight, tapCount: taps[s] });
    }
    var recipe = {
        productName: String(productName).trim(),
        batchNumber: String(batchNumber).trim(),
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
    _quickTestRunPendingFormReset = true;
    startTestRun(recipe);
}

function resetQuickTestFormAfterRunIfPending() {
    if (!_quickTestRunPendingFormReset) return;
    _quickTestRunPendingFormReset = false;
    var pn = document.getElementById('quick-product-name');
    var bn = document.getElementById('quick-batch-number');
    if (pn) pn.value = '';
    if (bn) bn.value = '';
    window._quickStepTaps = null;
    window._quickStepCount = null;
    var qtot = document.getElementById('quick-custom-total-taps');
    if (qtot) qtot.value = '';
    if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
    if (typeof _refreshQuickStepSummary === 'function') {
        _refreshQuickStepSummary();
    }
    document.querySelectorAll('input[name="quick-cylinder"]').forEach(function (el) {
        el.checked = el.value === '100';
    });
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


function resetTestRunPageForNewLoad() {
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    stopTestRunAdapterPoll();
    if (typeof hardwareTapStopSilently === 'function') hardwareTapStopSilently();
    if (typeof _closeTestRunHardwareEs === 'function') _closeTestRunHardwareEs();

    testRunButtonState = 'start';
    testRunStartTime = null;
    testRunCurrentStepIndex = 0;
    testRunCurrentTapCount = 0;
    testRunStepTapsBase = 0;
    testRunSteps = [];
    testRunTotalSteps = 0;
    testRunStepResults = [];
    testRunStepVolumes = [];
    testRunInitialWeightG = null;
    testRunInitialVolumeMl = null;
    testRunPreviousVolumeMl = null;
    testRunLastStepVolumeDeltaMl = null;
    testRunLastStepPreviousMl = null;
    testRunLastStepCurrentMl = null;
    _pendingStepVolumeDeltaMl = null;
    _testRunStepResumeInFlight = false;
    _adapterPollOkStreak = 0;
    _testRunAdapterInterruptAudited = false;

    if (_testRunVolumeResolve) {
        var rv = _testRunVolumeResolve;
        _testRunVolumeResolve = null;
        try { rv(null); } catch (e) {}
    }
    if (_testRunInitialWeightResolve) {
        var rw = _testRunInitialWeightResolve;
        _testRunInitialWeightResolve = null;
        try { rw(null); } catch (e) {}
    }

    if (typeof closeTestRunStepCompleteModal === 'function') closeTestRunStepCompleteModal();
    if (typeof closeTestRunCompletionApprovalModal === 'function') closeTestRunCompletionApprovalModal();
    ['test-run-volume-overlay', 'test-run-initial-weight-overlay', 'test-run-completion-overlay', 'test-run-abort-overlay'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    if (typeof window.closeOSK === 'function') window.closeOSK();

    setRunCard('run-sample-volume', '--');
    setRunCard('run-initial-weight', '--');
    setRunCard('run-bulk-density', '--');
    setRunCard('run-tap-density', '--');
    setRunCard('run-result', '--');
    setRunCard('run-tap-count-card', '0');
    setRunCard('run-tap-count-of-card', 'of --');
    setRunCard('run-current-step-card', '1');
    setRunCard('run-status-text', 'Ready');
    setRunCard('run-status-subtext', 'Waiting to start');

    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }

    if (typeof renderTestRunResultsTable === 'function') renderTestRunResultsTable();
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
    syncTestRunCheckpoint();
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

function stopTestRunCheckpointHeartbeat() {
    if (_testRunCheckpointTimer) {
        clearInterval(_testRunCheckpointTimer);
        _testRunCheckpointTimer = null;
    }
}

function startTestRunCheckpointHeartbeat() {
    stopTestRunCheckpointHeartbeat();
    _testRunCheckpointTimer = setInterval(function () {
        if (testRunButtonState === 'abort') {
            syncTestRunCheckpoint();
        }
    }, 1000);
}

function buildTestRunCheckpointPayload() {
    var payload = buildTestRunReportPayload();
    if (!payload) return null;
    payload.testData = payload.testData || {};
    payload.testData.status = 'running';
    if (!_testRunStableStartIso && testRunStartTime) {
        _testRunStableStartIso = new Date(testRunStartTime).toISOString();
    }
    var startIso = _testRunStableStartIso || payload.testData.testStartTime;
    var nowIso = new Date().toISOString();
    var durationSeconds = null;
    if (testRunStartTime) {
        durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(testRunStartTime).getTime()) / 1000));
    }
    if (startIso) {
        payload.testStartTime = startIso;
        payload.testData.testStartTime = startIso;
    }
    payload.testEndTime = nowIso;
    payload.testData.testEndTime = nowIso;
    if (durationSeconds != null) {
        payload.durationSeconds = durationSeconds;
        payload.testData.durationSeconds = durationSeconds;
    }
    payload._checkpointAt = nowIso;
    payload._checkpointPhase = 'running';
    var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : null;
    if (u) {
        var un = (u.username || u.name || '').trim();
        payload.operatedByUsername = un;
        payload.operatorName = (u.name || u.username || '').trim();
        payload.employeeId = un;
        payload.testData.operatedByUsername = un;
        payload.testData.operatorName = payload.operatorName;
        payload.testData.employeeId = un;
    }
    return payload;
}

function syncTestRunCheckpoint() {
    if (testRunButtonState !== 'abort') return Promise.resolve();
    var body = buildTestRunCheckpointPayload();
    if (!body) return Promise.resolve();
    return apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'PUT', body: body }).catch(function () {});
}

function clearTestRunCheckpoint() {
    stopTestRunCheckpointHeartbeat();
    _testRunStableStartIso = null;
    return apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'DELETE' }).catch(function () {});
}

function buildTestRunReportPayload() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return null;
    var completedSteps = (testRunStepResults && testRunStepResults.length)
        ? testRunStepResults.length
        : Math.min(testRunCurrentStepIndex + 1, testRunTotalSteps);
    var now = new Date().toISOString();
    var startIso = testRunStartTime || now;
    var durationSec = null;
    if (testRunStartTime) {
        var durMs = new Date(now).getTime() - new Date(testRunStartTime).getTime();
        if (durMs >= 0) durationSec = Math.floor(durMs / 1000);
    }
    var testData = {
        recipe: recipe,
        productName: recipe.productName,
        batchNumber: recipe.batchNumber,
        status: 'completed',
        completedSteps: completedSteps,
        steps: recipe.steps || testRunSteps,
        stepCount: completedSteps,
        stepResults: testRunStepResults,
        sampleVolumeMl: recipe.sampleVolumeMl,
        initialWeightG: testRunInitialWeightG,
        initialVolumeMl: (testRunInitialVolumeMl != null && !isNaN(testRunInitialVolumeMl))
            ? testRunInitialVolumeMl
            : null,
        usp: recipe.usp,
        testStartTime: startIso,
        testEndTime: now,
        durationSeconds: durationSec,
        createdAt: startIso,
        completedAt: now
    };
    var stats = computeTestReportStatistics(testData);
    if (stats) {
        testData.statistics = stats;
    }

    var payload = {
        name: 'Test Report - ' + (recipe.productName || 'Tap Density Apparatus Test'),
        type: 'test',
        recipe: recipe,
        testData: testData,
        createdAt: startIso,
        completedAt: now
    };
    if (stats) payload.statistics = stats;
    return stampOperatorOnTestReportPayload(payload);
}

var _abortSaveInFlight = false;
var _testRunAbortRemarksResolve = null;

function closeTestRunAbortRemarksModal() {
    var overlay = document.getElementById('test-run-abort-overlay');
    if (overlay) overlay.style.display = 'none';
    var err = document.getElementById('test-run-abort-error');
    if (err) {
        err.style.display = 'none';
        err.textContent = '';
    }
    if (typeof window.closeOSK === 'function') window.closeOSK();
}

function openTestRunAbortRemarksModal() {
    return new Promise(function (resolve) {
        _testRunAbortRemarksResolve = resolve;
        var overlay = document.getElementById('test-run-abort-overlay');
        var ta = document.getElementById('test-run-abort-remarks');
        var err = document.getElementById('test-run-abort-error');
        if (!overlay || !ta) {
            _testRunAbortRemarksResolve = null;
            resolve('Test aborted');
            return;
        }
        ta.value = '';
        if (err) {
            err.style.display = 'none';
            err.textContent = '';
        }
        overlay.style.display = 'flex';
        setTimeout(function () {
            try {
                ta.focus();
                if (typeof openOSKForInput === 'function') openOSKForInput(ta);
            } catch (e) {}
        }, 0);
    });
}

function confirmTestRunAbortRemarks() {
    var ta = document.getElementById('test-run-abort-remarks');
    var err = document.getElementById('test-run-abort-error');
    var remarks = ta ? String(ta.value || '').trim() : '';
    if (!remarks) {
        if (err) {
            err.textContent = 'Abort remarks are required.';
            err.style.display = 'block';
        } else if (typeof showAppModal === 'function') {
            showAppModal('Abort remarks are required.', 'Abort Test');
        }
        if (ta) ta.focus();
        return;
    }
    closeTestRunAbortRemarksModal();
    if (!_testRunAbortRemarksResolve) return;
    var r = _testRunAbortRemarksResolve;
    _testRunAbortRemarksResolve = null;
    r(remarks);
}

function abortTestRunAndSave() {
    if (_abortSaveInFlight) return Promise.resolve();

    stopTestRunCheckpointHeartbeat();
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    stopTestRunAdapterPoll();
    testRunStepTapsBase = 0;
    hardwareTapStopSilently();
    _closeTestRunHardwareEs();
    closeTestRunStepCompleteModal();
    cancelTestRunVolume();

    return openTestRunAbortRemarksModal().then(function (remarks) {
        if (!remarks || !String(remarks).trim()) return Promise.resolve();
        return _abortTestRunAndSaveWithRemarks(String(remarks).trim());
    });
}

function _abortTestRunAndSaveWithRemarks(remarks) {
    if (_abortSaveInFlight) return Promise.resolve();
    _abortSaveInFlight = true;
    auditTestRunAborted('User aborted test run: ' + remarks);

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
        return Promise.resolve();
    }

    // Override status + completed steps to reflect actual recorded steps
    var completedSteps = (testRunStepResults && testRunStepResults.length) ? testRunStepResults.length : 0;
    payload.testData = payload.testData || {};
    payload.testData.status = 'aborted';
    payload.testData.completedSteps = completedSteps;
    payload.testData.stepCount = completedSteps;
    payload.testData.remarks = remarks;
    payload.remarks = remarks;
    payload.completedAt = new Date().toISOString();
    payload.testData.completedAt = payload.completedAt;
    stampOperatorOnTestReportPayload(payload);

    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            _abortSaveInFlight = false;
            clearTestRunCheckpoint();
            resetQuickTestFormAfterRunIfPending();
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
        _closeTestRunHardwareEs();
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            clearTestRunCheckpoint();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            hardwareTapStopSilently();
            _closeTestRunHardwareEs();
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
            auditTestRunFinished(reportId);
            finishTestRunReportSaved(reportId);
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
        _closeTestRunHardwareEs();
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            clearTestRunCheckpoint();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            hardwareTapStopSilently();
            _closeTestRunHardwareEs();
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
            auditTestRunFinished(reportId);
            finishTestRunReportSaved(reportId);
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
    stopTestRunAdapterPoll();
    var volInput = document.getElementById('test-run-volume-input');
    if (volInput) volInput.value = '';
    // Move to next step (fresh tap base for new step)
    testRunCurrentStepIndex++;
    if (testRunButtonState === 'abort') {
        runTestRunHardwareStep(testRunCurrentStepIndex);
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

            return verifyTestRunAdapter().then(function (ok) {
                if (!ok) {
                    return apiRequest(API_BASE + '/api/hardware/adapter/check', { method: 'POST' }).then(function (checkRes) {
                        logTestAdapterError(lastTestRunRecipe, {
                            expected: recipeExpectedAdapterKind(lastTestRunRecipe),
                            detected: detectedAdapterKindFromCheckResult(checkRes)
                        });
                        var holderKindStart = recipeExpectedAdapterKind(lastTestRunRecipe);
                        showAppModal(
                            holderKindStart === 'usp2'
                                ? 'Please check the adaptor and holder. Fit the correct USP 2 holder for this recipe and try again.'
                                : 'Holder error. Fit the correct USP 1 holder for this recipe and try again.',
                            adapterErrorTitleForKind(holderKindStart)
                        );
                        throw new Error('adapter');
                    });
                }
            }).then(function () {
                auditTestRunStarted(lastTestRunRecipe);
                testRunStartTime = new Date().toISOString();
                _testRunStableStartIso = testRunStartTime;
                testRunButtonState = 'abort';
                syncTestRunCheckpoint();
                startTestRunCheckpointHeartbeat();
                if (btn) {
                    btn.disabled = false;
                    btn.className = 'btn-ctrl danger';
                    btn.innerHTML = '<span class="ctrl-icon">&#9726;</span><span>ABORT</span>';
                }
                if (statusText) statusText.textContent = 'Running';
                if (statusSubtext) statusSubtext.textContent = 'Test in progress';
                runTestRunHardwareOrchestration();
            });
        }).catch(function (err) {
            if (btn) btn.disabled = false;
            if (err && err.message === 'adapter') return;
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
    var rejectBtn = document.getElementById('recipe-action-reject-btn');
    if (apprBtn) {
        var st = recipe ? recipe.recipeApprovalStatus : null;
        var showAppr = !!(recipe && st === 'pending' && userCanApproveByQaRule());
        apprBtn.style.display = showAppr ? '' : 'none';
    }
    if (rejectBtn) {
        var stR = recipe ? recipe.recipeApprovalStatus : null;
        var showRej = !!(recipe && stR === 'pending' && userCanApproveByQaRule());
        rejectBtn.style.display = showRej ? '' : 'none';
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
        openRecipeApproveModal(id, 'approve');
    } else if (action === 'reject') {
        openRecipeApproveModal(id, 'reject');
    }
}

function openRecipeApproveModal(recipeId, mode) {
    window._recipeApproveId = recipeId;
    window._recipeApproveMode = mode === 'reject' ? 'reject' : 'approve';
    var ta = document.getElementById('recipe-approve-remarks');
    if (ta) ta.value = '';
    var title = document.getElementById('recipe-approve-modal-title');
    if (title) title.textContent = window._recipeApproveMode === 'reject' ? 'Reject recipe' : 'Approve recipe';
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeApproveModal() {
    window._recipeApproveId = null;
    window._recipeApproveMode = null;
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitRecipeApproveOrReject() {
    if (window._recipeApproveMode === 'reject') {
        submitRecipeReject();
        return;
    }
    submitRecipeApprove();
}

function submitRecipeReject() {
    var id = window._recipeApproveId;
    if (id == null) return;
    var ta = document.getElementById('recipe-approve-remarks');
    var remarks = ta ? ta.value.trim() : '';
    refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return;
            return apiRequest(API_BASE + '/api/data/recipes/' + id + '/reject', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarks }
            }).then(function (data) {
                closeRecipeApproveModal();
                if (data && data.ok) {
                    showAppModal('Recipe rejected.', 'Recipes');
                    loadManageRecipes();
                } else {
                    showAppModal((data && data.error) ? String(data.error) : 'Rejection failed.', 'Recipes');
                }
            });
        });
    }).catch(function (err) {
        showAppModal('Rejection failed: ' + (err && err.message ? err.message : 'Error'), 'Recipes');
    });
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
        if (isUspStandardProcedureMode(mode)) {
            applyStandardUspStepDefaults('create');
        } else {
            var stepCount = Math.max(1, parseInt(r.stepCount, 10) || (r.steps && r.steps.length) || USP_DEFAULT_STEP_COUNT);
            window._createRecipeStepCount = stepCount;
            if (r.steps && r.steps.length) {
                window._createRecipeStepTaps = [];
                for (var si = 0; si < r.steps.length; si++) {
                    window._createRecipeStepTaps.push(parseInt(r.steps[si].tapCount, 10) || 0);
                }
            } else {
                window._createRecipeStepTaps = computeStandardUspTaps(stepCount);
            }
        }
        if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
        updateCreateRecipeContinueButton();
    }).catch(function () {});
}

function disableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id, { method: 'DELETE' }).then(function () {
        loadManageRecipes();
        loadDisableRecipes();
        showAppModal('Recipe disabled.', 'Disable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to disable recipe.';
        showAppModal(msg, 'Disable Recipe');
    });
}

function enableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id + '/enable', { method: 'POST' }).then(function () {
        loadDisableRecipes();
        loadManageRecipes();
        showAppModal('Recipe re-enabled.', 'Enable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to re-enable recipe.';
        showAppModal(msg, 'Enable Recipe');
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
    if (getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'pending' || getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'rejected') {
        showAppModal('This recipe is not approved and cannot be loaded for testing.', 'Load Recipe');
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
    var n = window._createRecipeStepCount;
    var customOk = true;
    if (mode === 'CUSTOM') {
        customOk = !!(n && window._createRecipeStepTaps && window._createRecipeStepTaps.length === n);
    } else if (isUspStandardProcedureMode(mode)) {
        customOk = true;
    }
    var canContinue = !!(recipeName && speedOk && heightOk && customOk);
    if (btn) {
        btn.disabled = !canContinue;
    }

    var summaryEl = document.getElementById('create-recipe-continue-summary');
    if (summaryEl) {
        if (mode === 'USP1') {
            summaryEl.textContent = 'USP 1 — 300 Taps/Min, 14 mm — 10 steps (fixed)';
        } else if (mode === 'USP2') {
            summaryEl.textContent = 'USP 2 — 250 Taps/Min, 3 mm — 10 steps (fixed)';
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

function getRecipes(options) {
    options = options || {};
    var status = String(options.status || 'active').trim().toLowerCase();
    var suffix = '';
    if (status === 'disabled' || status === 'all') {
        suffix = '?status=' + encodeURIComponent(status);
    }
    return apiRequest(API_BASE + '/api/data/recipes' + suffix, {
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
    getRecipes({ status: 'active' }).then(function (recipes) {
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
    if (!r) return null;
    if (r.customTotalTaps != null && r.customTotalTaps !== '') {
        var ct = parseInt(r.customTotalTaps, 10);
        if (!isNaN(ct) && ct > 0) return ct;
    }
    if (!r.steps || !r.steps.length) return null;
    var total = 0;
    for (var i = 0; i < r.steps.length; i++) {
        total += parseInt(r.steps[i].tapCount, 10) || 0;
    }
    return total > 0 ? total : null;
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

/** Display label for recipe procedure: USP 1, USP 2, or Custom. */
function recipeUspLabel(r) {
    if (!r) return '--';
    var mode = String(r.uspMode || '').trim().toUpperCase();
    if (mode === 'USP1') return 'USP 1';
    if (mode === 'USP2') return 'USP 2';
    if (mode === 'CUSTOM') return 'Custom';
    var usp = String(r.usp || '').trim();
    if (!usp) return '--';
    var u = usp.toUpperCase().replace(/\s+/g, ' ');
    if (u === 'USP1' || u === 'USP 1') return 'USP 1';
    if (u === 'USP2' || u === 'USP 2') return 'USP 2';
    if (u.indexOf('CUSTOM') >= 0) return 'Custom';
    return usp;
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
        var u = window.currentUser;
        var canManage = u && typeof canAccess === 'function' && canAccess(u, 'recipe-manage');
        if (createBtn) createBtn.style.display = (mode === 'load' || !canManage) ? 'none' : '';

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
                        '<th>USP</th>' +
                        '<th class="actions-col">Load</th>';
                } else {
                    headRow.innerHTML =
                        '<th>Product</th>' +
                        '<th>Cylinder</th>' +
                        '<th>Steps</th>' +
                        '<th>Height (mm)</th>' +
                        '<th>Tap speed</th>' +
                        '<th>USP</th>' +
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
            var uspStr = recipeUspLabel(r);

            if (mode === 'load') {
                var loadBtnHtml = '<button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + cylVol + '</td>' +
                    '<td>' + stepsCount + '</td>' +
                    '<td>' + heightStr + '</td>' +
                    '<td>' + speedStr + '</td>' +
                    '<td>' + uspStr + '</td>' +
                    '<td class="actions-cell actions-col">' + loadBtnHtml + '</td>';
            } else {
                var appr = getEffectiveRecipeApprovalStatus(r);
                var apprLabel = appr === 'pending' ? 'Pending' : (appr === 'rejected' ? 'Rejected' : 'Approved');
                var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Edit / Disable / Approve">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + cylVol + '</td>' +
                    '<td>' + stepsCount + '</td>' +
                    '<td>' + heightStr + '</td>' +
                    '<td>' + speedStr + '</td>' +
                    '<td>' + uspStr + '</td>' +
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

    getRecipes({ status: 'disabled' }).then(function (disabled) {
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
            var name = r.productName || r.name || '--';
            var cylVol = (r.cylinder && (r.cylinder.volume || r.cylinder.volumeMl)) ? ((r.cylinder.volume || r.cylinder.volumeMl) + ' ml') : '--';
            var stepsCount = r.stepCount || (r.steps && r.steps.length) || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td>' + cylVol + '</td>' +
                '<td>' + stepsCount + '</td>' +
                '<td class="actions-cell"><button type="button" class="btn-action btn-load" onclick="enableRecipe(' + (r.id || 0) + ')">Re-enable</button></td>';

            tbody.appendChild(tr);
        });
    }).catch(function () {
        if (msgEl) {
            msgEl.textContent = 'Unable to load disabled recipes.';
            msgEl.style.display = '';
        }
        if (tableEl) tableEl.style.display = 'none';
    });
}

function completeRecipeFromStep2() {
    if (window._recipeSaveInFlight) return;

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

    var stepCount;
    var taps;
    if (isUspStandardProcedureMode(mode)) {
        applyStandardUspStepDefaults('create');
        stepCount = USP_DEFAULT_STEP_COUNT;
        taps = computeStandardUspTaps(stepCount);
    } else {
        stepCount = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
            ? window._createRecipeStepCount
            : 0;
        taps = window._createRecipeStepTaps;
        if (!taps || taps.length !== stepCount) {
            taps = computeCreateRecipeStepTapsForStepCount(stepCount);
        }
    }

    if (!productName || speed == null || dropHeight == null) {
        showAppModal('Please complete recipe name, speed and height before saving.', 'Save Recipe');
        return;
    }

    if (mode === 'CUSTOM' && (!stepCount || stepCount < 1)) {
        showAppModal('Tap Number of steps to configure steps and taps for each step.', 'Save Recipe');
        return;
    }
    if (mode === 'CUSTOM' && !taps) {
        showAppModal('Tap Number of steps to configure taps for each step.', 'Save Recipe');
        return;
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
        var s2 = 0;
        for (var ti = 0; ti < taps.length; ti++) s2 += parseInt(taps[ti], 10) || 0;
        recipe.customTotalTaps = s2;
    }
    var editId = window.currentEditingRecipeId;
    if (editId) {
        recipe.id = editId;
    }

    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
    var continueBtn = document.getElementById('create-recipe-continue-btn');

    function setRecipeSaveUiActive(active) {
        window._recipeSaveInFlight = !!active;
        if (continueBtn) continueBtn.disabled = !!active;
    }

    function persistRecipe(approvalToken) {
        setRecipeSaveUiActive(true);
        var headers = {};
        if (approvalToken) headers['X-Approval-Verify-Token'] = approvalToken;
        var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
        var method = editId ? 'PUT' : 'POST';
        return apiRequest(url, {
            method: method,
            headers: headers,
            body: recipe
        }).then(function (result) {
            window.currentEditingRecipeId = null;
            setRecipeSaveUiActive(false);
            if (typeof resetCreateRecipeStep1Form === 'function') resetCreateRecipeStep1Form();
            goToPage('manage-recipes');
            loadManageRecipes();
            var saved = (result && result.recipe) ? result.recipe : null;
            var st = saved ? getEffectiveRecipeApprovalStatus(saved) : 'approved';
            if (role === 'factory' || st === 'approved') {
                showAppModal('Recipe saved and approved.', 'Save Recipe');
            } else {
                showAppModal('Recipe saved. It is pending approval.', 'Save Recipe');
            }
            return result;
        }).catch(function (err) {
            setRecipeSaveUiActive(false);
            console.error('Failed to save recipe:', err);
            var msg = (err && err.message) ? String(err.message) : 'Unknown error';
            showAppModal('Failed to save recipe: ' + msg, 'Save Recipe');
            throw err;
        });
    }

    if (role === 'factory') {
        persistRecipe(null);
        return;
    }

    openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
        if (!token) {
            showAppModal('Recipe not saved. Recipe approval credentials are required.', 'Save Recipe');
            return;
        }
        return persistRecipe(token);
    }).catch(function (err) {
        if (err && err.message && err.message.indexOf('QA verification UI') >= 0) {
            showAppModal(err.message, 'Save Recipe');
        }
    });
}

function _closeValidationRunHardwareEs() {
    if (validationRunHardwareEs) {
        if (validationRunSseListener) {
            try {
                validationRunHardwareEs.removeEventListener('message', validationRunSseListener);
            } catch (e) {}
            validationRunSseListener = null;
        }
        try {
            validationRunHardwareEs.close();
        } catch (e2) {}
        validationRunHardwareEs = null;
    }
}

function updateValidationRunTimerUi(secondsRemaining) {
    var total = VALIDATION_RUN_DURATION_SEC;
    var sec = Math.max(0, Math.min(total, parseInt(secondsRemaining, 10) || 0));
    setValRunEl('val-run-timer-digital', String(sec));
    var fill = document.getElementById('val-run-timer-fill');
    if (fill && fill.style) {
        var deg = total > 0 ? (sec / total) * 360 : 0;
        fill.style.setProperty('--val-timer-sweep-deg', String(deg) + 'deg');
    }
}

function _resetValidationRunActionButtonToStart() {
    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function validationRunHardwareMessage(ev) {
    if (validationRunState !== 'running') return;
    try {
        var raw = ev.data;
        if (raw == null || raw === '') return;
        var data = JSON.parse(raw);
        if (data.ping) return;
        var kind = String(data.kind || '');
        var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
        var lineStr = String(data.line != null ? data.line : '').trim();
        if (kind === 'ok' || norm === 'ok') return;
        if (kind === 'stopped' || norm === 'stopped') return;
        if (kind === 'progress' || /^\d+$/.test(norm)) {
            var n = parseInt(norm || lineStr, 10);
            if (!isNaN(n) && n >= 0) {
                validationRunCurrentCount = n;
                setValRunEl('val-run-tap-count', String(n));
            }
            return;
        }
        if (kind === 'error' || kind === 'adapter_error') {
            if (validationRunIntervalId != null) {
                clearInterval(validationRunIntervalId);
                validationRunIntervalId = null;
            }
            validationRunState = 'idle';
            stopValidationOnBackend().catch(function () {});
            _closeValidationRunHardwareEs();
            _resetValidationRunActionButtonToStart();
            updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
            if (kind === 'adapter_error' || _validationErrorIsAdapterRelated(lineStr) || _validationErrorIsAdapterRelated(norm)) {
                showValidationAdapterCheckModal({
                    source: 'sse',
                    line: lineStr,
                    normalized: norm
                });
            } else {
                showAppModal(
                    'Hardware error during validation: ' + (lineStr || norm || 'Unknown'),
                    'Validation'
                );
            }
        }
    } catch (ex) {
        // ignore malformed SSE payloads
    }
}

function validationRunTimerTick() {
    validationRunSecondsRemaining--;
    if (validationRunSecondsRemaining < 0) validationRunSecondsRemaining = 0;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    if (validationRunSecondsRemaining <= 0) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        completeValidationRunAfterDuration();
    }
}



function buildValidationRunSnapshot(isPass) {
    var usp = lastValidationType === 'load' ? 'USP 2' : 'USP 1';
    var tapsMin = lastValidationType === 'load' ? 250 : 300;
    var dropHeight = lastValidationType === 'load' ? 3 : 14;
    var now = new Date().toISOString();
    return {
        validationSubtype: lastValidationType,
        usp: usp,
        tapsMin: tapsMin,
        dropHeight: dropHeight,
        expectedTapCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedTapCountMin: validationRunMin,
        expectedTapCountMax: validationRunMax,
        actualTapCount: validationRunCurrentCount,
        validationDurationSec: VALIDATION_RUN_DURATION_SEC,
        status: isPass ? 'Pass' : 'Fail',
        completedAt: now
    };
}

var _calibrationDueCallback = null;
var _calibrationDueReportId = null;
var _calibrationDueKind = 'validation';

function formatDateForDisplay(isoDate) {
    if (!isoDate) return '';
    var parts = String(isoDate).split('-');
    if (parts.length === 3) return parts[2] + '/' + parts[1] + '/' + parts[0];
    return isoDate;
}

function showCalibrationDueModal(callback, reportId, dueKind) {
    _calibrationDueCallback = callback || null;
    _calibrationDueReportId = (reportId != null && reportId !== '') ? reportId : null;
    _calibrationDueKind = (String(dueKind || '').toLowerCase() === 'calibration') ? 'calibration' : 'validation';
    var titleEl = document.getElementById('calibration-due-modal-title');
    var textEl = document.getElementById('calibration-due-modal-text');
    if (_calibrationDueKind === 'validation') {
        if (titleEl) titleEl.textContent = 'Set Next Validation Due Date';
        if (textEl) textEl.textContent = 'Select when the next validation is due:';
    } else {
        if (titleEl) titleEl.textContent = 'Set Next Calibration Due Date';
        if (textEl) textEl.textContent = 'Select when the next calibration is due:';
    }
    var modal = document.getElementById('calibration-due-modal');
    if (modal) modal.style.display = 'flex';
}

function closeCalibrationDueModal() {
    var modal = document.getElementById('calibration-due-modal');
    if (modal) modal.style.display = 'none';
    _calibrationDueCallback = null;
    _calibrationDueReportId = null;
    _calibrationDueKind = 'validation';
}

function confirmCalibrationDue(months) {
    var now = new Date();
    var lastDate = now.toISOString().split('T')[0];
    var nextDate = new Date(now);
    nextDate.setMonth(nextDate.getMonth() + months);
    var nextDateStr = nextDate.toISOString().split('T')[0];
    var lastFormatted = formatDateForDisplay(lastDate);
    var nextFormatted = formatDateForDisplay(nextDateStr);
    var reportId = _calibrationDueReportId;
    var dueKind = _calibrationDueKind || 'validation';
    var cb = _calibrationDueCallback;

    function finishDueModal() {
        closeCalibrationDueModal();
        if (typeof cb === 'function') {
            try { cb(); } catch (e) { console.error('Due date callback error', e); }
        }
    }

    var datesBody = {
        lastValidationDate: lastFormatted,
        nextValidationDate: nextFormatted,
        months: months,
        dueKind: dueKind
    };
    var datesReq = apiRequest(API_BASE + '/api/data/factory-settings/validation-dates', {
        method: 'POST',
        body: datesBody
    });
    var stashReq = Promise.resolve({ ok: true });
    if (reportId != null) {
        stashReq = apiRequest(API_BASE + '/api/data/reports/' + reportId + '/pending-due', {
            method: 'POST',
            body: {
                months: months,
                lastValidationDate: lastFormatted,
                nextValidationDate: nextFormatted,
                dueKind: dueKind
            }
        }).catch(function () { return { ok: false }; });
    }
    datesReq.then(function () {
        return stashReq;
    }).then(function () {
        finishDueModal();
    }).catch(function (err) {
        console.error('Failed to save due date', err);
        showAppModal('Failed to save next validation interval: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
    });
}

function buildSingleValidationReportPayload(runSnapshot) {
    if (!runSnapshot) return null;
    var user = window.currentUser || {};
    var now = new Date().toISOString();
    var usp = runSnapshot.usp || (runSnapshot.validationSubtype === 'load' ? 'USP 2' : 'USP 1');
    var overallPass = String(runSnapshot.status || '').toLowerCase() === 'pass';
    return {
        name: 'Validation - ' + usp + ' - ' + (overallPass ? 'Pass' : 'Fail'),
        type: 'validation',
        validationSubtype: runSnapshot.validationSubtype || (lastValidationType === 'load' ? 'load' : 'distance'),
        validationRuns: [runSnapshot],
        status: runSnapshot.status || (overallPass ? 'Pass' : 'Fail'),
        usp: usp,
        tapsMin: runSnapshot.tapsMin,
        dropHeight: runSnapshot.dropHeight,
        expectedTapCount: runSnapshot.expectedTapCount,
        expectedTolerance: runSnapshot.expectedTolerance,
        expectedTapCountMin: runSnapshot.expectedTapCountMin,
        expectedTapCountMax: runSnapshot.expectedTapCountMax,
        actualTapCount: runSnapshot.actualTapCount,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        testData: {
            validationRuns: [runSnapshot],
            usp: usp,
            status: runSnapshot.status || (overallPass ? 'Pass' : 'Fail'),
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
            createdAt: now,
            completedAt: now
        }
    };
}

function saveValidationReportAndPreview(runSnapshot) {
    var reportPayload = buildSingleValidationReportPayload(runSnapshot);
    if (!reportPayload) return Promise.resolve();
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
        .then(function (result) {
            var reportId = result && (result.id != null ? result.id : (result.report && result.report.id));
            currentReportFilter = 'validation';
            showCalibrationDueModal(function () {
                if (reportId && typeof openReportPreview === 'function') {
                    openReportPreview(reportId, { setGate: true });
                } else {
                    goToPage('reports');
                }
            }, reportId, 'validation');
        })
        .catch(function (err) {
            console.error('Failed to save validation report', err);
            showAppModal('Failed to save validation report. Check your connection and try again.', 'Validation');
        });
}

function getOrderedValidationSessionRuns() {
    var runs = [];
    if (validationSessionResults.distance) runs.push(validationSessionResults.distance);
    if (validationSessionResults.load) runs.push(validationSessionResults.load);
    return runs;
}

function buildCombinedValidationReportPayload() {
    var runs = getOrderedValidationSessionRuns();
    if (!runs.length) return null;
    var overallPass = true;
    for (var i = 0; i < runs.length; i++) {
        if (String(runs[i].status || '').toLowerCase() !== 'pass') overallPass = false;
    }
    var user = window.currentUser || {};
    var now = new Date().toISOString();
    var first = runs[0];
    var last = runs[runs.length - 1];
    return {
        name: 'Validation - USP 1 & USP 2 - ' + (overallPass ? 'Pass' : 'Fail'),
        type: 'validation',
        validationSubtype: 'combined',
        validationRuns: runs,
        status: overallPass ? 'Pass' : 'Fail',
        usp: 'USP 1 & USP 2',
        tapsMin: first.tapsMin,
        dropHeight: first.dropHeight,
        expectedTapCount: first.expectedTapCount,
        expectedTolerance: first.expectedTolerance,
        expectedTapCountMin: first.expectedTapCountMin,
        expectedTapCountMax: first.expectedTapCountMax,
        actualTapCount: last.actualTapCount,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        testData: {
            validationRuns: runs,
            usp: 'USP 1 & USP 2',
            status: overallPass ? 'Pass' : 'Fail',
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
            createdAt: now,
            completedAt: now
        }
    };
}

function saveCombinedValidationReport() {
    var reportPayload = buildCombinedValidationReportPayload();
    if (!reportPayload) return Promise.resolve();
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
        .then(function (result) {
            validationSessionResults = { distance: null, load: null };
            validationCompletion = { distance: false, load: false };
            var reportId = result && result.id;
            currentReportFilter = 'validation';
            if (reportId) {
                if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
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

function validationRunsFromPreview(preview) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (preview.validationRuns && preview.validationRuns.length) return preview.validationRuns;
    if (td && td.validationRuns && td.validationRuns.length) return td.validationRuns;
    return null;
}

function renderValidationDetailsInPreview(preview) {
    var titleEl = document.getElementById('report-validation-calibration-title');
    var bodyEl = document.getElementById('report-validation-calibration-body');
    if (!bodyEl) return;
    if (titleEl) titleEl.textContent = 'VALIDATION DETAILS';
    var td = preview.testData || preview;
    var runs = validationRunsFromPreview(preview);
    var rows = [];
    if (runs && runs.length) {
        runs.forEach(function (run) {
            var dateStr = formatReportDate(run.completedAt || preview.completedAt || preview.createdAt);
            var usp = run.usp || (run.validationSubtype === 'load' ? 'USP 2' : 'USP 1');
            var tapsMin = run.tapsMin != null ? run.tapsMin : '--';
            var dropHeight = run.dropHeight != null ? run.dropHeight : '--';
            var expected = run.expectedTapCount != null ? run.expectedTapCount : '--';
            var tol = run.expectedTolerance != null ? run.expectedTolerance : null;
            var expectedDisplay = (tol != null && expected !== '--') ? (String(expected) + ' (+/- ' + String(tol) + ')') : expected;
            var actual = run.actualTapCount != null ? run.actualTapCount : '--';
            var status = run.status || '--';
            rows.push('<tr><th colspan="4" class="report-validation-usp-header">' + usp + ' validation</th></tr>');
            rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
            rows.push('<tr><th>USP</th><td>' + usp + '</td><th>Taps/Min</th><td>' + tapsMin + '</td></tr>');
            rows.push('<tr><th>Drop Height (mm)</th><td>' + dropHeight + '</td><th>Status</th><td>' + status + '</td></tr>');
            rows.push('<tr><th>Expected Tap Count</th><td>' + expectedDisplay + '</td><th>Actual Tap Count</th><td>' + actual + '</td></tr>');
        });
    } else {
        var dateStr = formatReportDate(td.completedAt || preview.completedAt || preview.createdAt);
        var usp = td.usp || preview.usp || '--';
        var tapsMin = td.tapsMin != null ? td.tapsMin : (preview.tapsMin != null ? preview.tapsMin : '--');
        var dropHeight = td.dropHeight != null ? td.dropHeight : (preview.dropHeight != null ? preview.dropHeight : '--');
        var expected = td.expectedTapCount != null ? td.expectedTapCount : (preview.expectedTapCount != null ? preview.expectedTapCount : '--');
        var tol = td.expectedTolerance != null ? td.expectedTolerance : (preview.expectedTolerance != null ? preview.expectedTolerance : null);
        var expectedDisplay = (tol != null && expected !== '--') ? (String(expected) + ' (+/- ' + String(tol) + ')') : expected;
        var actual = td.actualTapCount != null ? td.actualTapCount : (preview.actualTapCount != null ? preview.actualTapCount : '--');
        var status = td.status || preview.status || '--';
        rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
        rows.push('<tr><th>USP</th><td>' + usp + '</td><th>Taps/Min</th><td>' + tapsMin + '</td></tr>');
        rows.push('<tr><th>Drop Height (mm)</th><td>' + dropHeight + '</td><th>Status</th><td>' + status + '</td></tr>');
        rows.push('<tr><th>Expected Tap Count</th><td>' + expectedDisplay + '</td><th>Actual Tap Count</th><td>' + actual + '</td></tr>');
    }
    bodyEl.innerHTML = rows.join('');
}

function completeValidationRunAfterDuration() {
    validationRunState = 'idle';
    validationRunBackendPending = false;
    applyValidationRunLockUi(false);
    stopValidationOnBackend().catch(function () {});
    _closeValidationRunHardwareEs();
    setValRunEl('val-run-status', 'Completed');
    setValRunEl('val-run-status-sub', 'Validation run finished');
    var detailEl = document.getElementById('val-run-result-detail');
    var isPass = validationRunCurrentCount >= validationRunMin && validationRunCurrentCount <= validationRunMax;
    _setValResultVisible(true);
    _setValRunResultBadge(isPass);
    if (detailEl) {
        detailEl.textContent =
            'After ' +
            String(VALIDATION_RUN_DURATION_SEC) +
            ' s: expected ' +
            validationRunTarget +
            ' (\u00b1' +
            validationRunTolerance +
            '), actual ' +
            validationRunCurrentCount +
            '.';
    }
    _resetValidationRunActionButtonToStart();

    logAuditEvent('Validation finished', (lastValidationType === 'load' ? 'USP 2' : 'USP 1') + ' validation: ' + (isPass ? 'Pass' : 'Fail'), {
        eventType: 'lifecycle',
        entityType: 'validation',
        extra: {
            validationType: lastValidationType,
            status: isPass ? 'Pass' : 'Fail',
            actualTapCount: validationRunCurrentCount,
            expectedTapCount: validationRunTarget
        }
    });

    if (lastValidationType === 'distance' || lastValidationType === 'load') {
        validationSessionResults[lastValidationType] = buildValidationRunSnapshot(isPass);
        validationCompletion[lastValidationType] = true;
    }

    var runSnapshot = buildValidationRunSnapshot(isPass);
    saveValidationReportAndPreview(runSnapshot).then(function () {
        if (!isValidationFullyCompleted()) {
            var missing = getMissingValidationLabel();
            showAppModal(
                (lastValidationType === 'distance' ? 'USP 1' : 'USP 2') + ' validation report saved. Please complete ' + missing + ' validation when ready.',
                'Validation'
            );
            goToPage('validate-type-select');
        } else {
            validationSessionResults = { distance: null, load: null };
            validationCompletion = { distance: false, load: false };
        }
    });
}

function startValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    var mode = lastValidationType === 'load' ? 'usp2' : 'usp1';
    return apiRequest(API_BASE + '/api/hardware/validation/load/start', { method: 'POST', body: { mode: mode } });
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
        applyValidationRunLockUi(true);
        if (btn) btn.disabled = true;
        setValRunEl('val-run-status', 'Starting');
        setValRunEl('val-run-status-sub', validationHardwareEnabled ? 'Checking holder…' : 'Starting');

        function _validationRunStartFailed(err) {
            validationRunState = 'idle';
            applyValidationRunLockUi(false);
            _closeValidationRunHardwareEs();
            setValRunEl('val-run-status', 'Ready');
            setValRunEl('val-run-status-sub', 'Press Start to begin');
            _setValRunStatusStyle('ready');
            if (err && err.message === 'adapter_check') {
                showValidationAdapterCheckModal({ source: 'start' });
            } else {
                showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
            }
        }

        function _runValidationHardwareStart() {
            _closeValidationRunHardwareEs();
            try {
                validationRunHardwareEs = new EventSource(_getHardwareSseUrl());
            } catch (esErr) {
                return Promise.reject(new Error('Could not connect to the hardware stream'));
            }
            validationRunSseListener = validationRunHardwareMessage;
            validationRunHardwareEs.addEventListener('message', validationRunSseListener);
            return startValidationOnBackend().then(function (res) {
                if (!res || res.ok !== true) {
                    var errText = (res && (res.error || res.response || res.message)) || 'Hardware did not acknowledge start';
                    if (_validationErrorIsAdapterRelated(errText) || (res && res.error === 'adapter_mismatch')) {
                        return Promise.reject(new Error('adapter_check'));
                    }
                    return Promise.reject(new Error(errText));
                }
                validationRunState = 'running';
                applyValidationRunLockUi(true);
                logAuditEvent('Validation started', validationAdapterLabel() + ' validation run started', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: { validationType: lastValidationType }
                });
                validationRunCurrentCount = 0;
                setValRunEl('val-run-tap-count', '0');
                validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
                updateValidationRunTimerUi(validationRunSecondsRemaining);
                setValRunEl('val-run-status', 'Running');
                setValRunEl('val-run-status-sub', String(VALIDATION_RUN_DURATION_SEC) + 's run — tap count from device');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
                if (btn) {
                    btn.className = 'btn btn-primary val-run-start-btn is-abort';
                    btn.disabled = false;
                    btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-validation-label">Abort</span>';
                }
                if (label) label.textContent = 'Abort';
                validationRunIntervalId = setInterval(validationRunTimerTick, 1000);
            });
        }

        var startPromise;
        if (!validationHardwareEnabled) {
            startPromise = _runValidationHardwareStart();
        } else {
            startPromise = verifyValidationAdapter().then(function (adapterResult) {
                if (!adapterResult || !adapterResult.ok) {
                    return Promise.reject(new Error('adapter_check'));
                }
                setValRunEl('val-run-status-sub', 'Holder OK — starting…');
                return _runValidationHardwareStart();
            });
        }

        startPromise.catch(_validationRunStartFailed).finally(function () {
            validationRunBackendPending = false;
            if (btn) btn.disabled = false;
        });
    } else {
        abortValidationRun();
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
    if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    } else if (permPanel && !permPanel.classList.contains('is-hidden') && typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
    if (typeof ensureAddMemberPageScroll === 'function') {
        ensureAddMemberPageScroll();
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

function sessionCanAssignFeatureOverrides() {
    var u = window.currentUser;
    var role = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-add', 'create');
    }
    return false;
}

function canEditMembers() {
    var u = (typeof window !== 'undefined' && window.currentUser) ? window.currentUser : null;
    var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-manage', 'edit');
    }
    return false;
}

function _isEditingOwnMemberProfile(memberId) {
    if (memberId == null) return false;
    var u = window.currentUser;
    if (!u) return false;
    if (u.id != null && Number(u.id) === Number(memberId)) return true;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var target = members.find(function (m) { return Number(m.id) === Number(memberId); });
    if (!target) return false;
    var curUn = String(u.username || '').trim().toLowerCase();
    var tgtUn = String(target.username || '').trim().toLowerCase();
    return !!(curUn && tgtUn && curUn === tgtUn);
}

function _setAddMemberPageMode(isEdit, isSelfEdit) {
    var titleEl = document.getElementById('add-member-page-title');
    var saveBtn = document.getElementById('add-member-save-btn');
    var userIdEl = document.getElementById('add-userid');
    var pwdLabel = document.getElementById('add-password-label');
    var confirmPwdLabel = document.getElementById('add-confirm-password-label');
    var roleContainer = document.querySelector('#page-add-member .role-selection-container');
    var headerTitle = document.getElementById('header-title');
    if (titleEl) titleEl.textContent = isEdit ? 'Edit Profile' : 'Add New Member';
    if (saveBtn) saveBtn.textContent = isEdit ? 'Update Profile' : 'Save Profile';
    if (headerTitle) headerTitle.textContent = isEdit ? 'Edit Profile' : (PAGE_TITLES['add-member'] || 'Add New Member');
    if (userIdEl) {
        userIdEl.readOnly = !!isEdit;
        userIdEl.disabled = !!isEdit;
        if (isEdit) userIdEl.classList.add('input-readonly');
        else userIdEl.classList.remove('input-readonly');
    }
    if (pwdLabel) pwdLabel.textContent = isEdit ? 'New Password (optional)' : 'Password';
    if (confirmPwdLabel) confirmPwdLabel.textContent = isEdit ? 'Confirm New Password (optional)' : 'Confirm Password';
    if (roleContainer) roleContainer.style.display = isSelfEdit ? 'none' : '';
    if (isSelfEdit) {
        var panel = document.getElementById('add-member-permissions-panel');
        if (panel) {
            panel.classList.add('is-hidden');
            panel.setAttribute('aria-hidden', 'true');
        }
    } else if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    }
}

function _loadMemberOverridesIntoPanel(overrides) {
    var norm = (typeof normalizeFeatureOverrides === 'function')
        ? normalizeFeatureOverrides(overrides)
        : { allow: [], deny: [] };
    _addMemberFeatureOverrides = {
        allow: (norm.allow || []).slice(),
        deny: []
    };
}

function openEditMember(id) {
    if (!id) return;
    if (typeof canEditMembers === 'function' && !canEditMembers()) {
        showAppModal('You do not have permission to edit profiles.', 'Permission');
        return;
    }
    apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member || member.id == null) throw new Error('Member not found');
            var uname = String(member.username || '').trim().toUpperCase();
            if (uname === FACTORY_USERNAME) {
                showAppModal('The factory account cannot be edited here.', 'Edit Profile');
                return;
            }
            editingMemberId = member.id;
            var isSelf = _isEditingOwnMemberProfile(member.id);
            ['add-password', 'add-confirm-password'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            var fullNameEl = document.getElementById('add-fullname');
            var userIdEl = document.getElementById('add-userid');
            if (fullNameEl) fullNameEl.value = member.name || '';
            if (userIdEl) userIdEl.value = member.username || '';
            if (!isSelf && typeof selectRole === 'function') {
                selectRole(member.role || 'User');
            }
            if (!isSelf) _loadMemberOverridesIntoPanel(member.featureOverrides);
            _setAddMemberPageMode(true, isSelf);
            goToPage('add-member');
            setTimeout(function () {
                if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
                if (fullNameEl) fullNameEl.focus();
            }, 60);
        })
        .catch(function (err) {
            showAppModal('Failed to load profile: ' + (err && err.message ? err.message : 'Unknown error'), 'Edit Profile');
        });
}

function saveMemberForm() {
    if (editingMemberId != null) {
        saveEditedMember();
        return;
    }
    saveNewMember();
}

function saveEditedMember() {
    var memberId = editingMemberId;
    if (memberId == null) return;
    var modalTitle = 'Edit Profile';
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
    var isSelf = _isEditingOwnMemberProfile(memberId);

    if (!fullName || !username) {
        showAppModal('Full name and User ID are required.', modalTitle);
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account.', modalTitle);
        return;
    }
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            showAppModal('Password and Confirm Password do not match.', modalTitle);
            return;
        }
        var pwdErr = getStrongPasswordError(password);
        if (pwdErr) {
            showAppModal(pwdErr, modalTitle);
            return;
        }
    }

    apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member) throw new Error('Member not found');
            member.name = fullName;
            member.username = username;
            if (!isSelf) {
                member.role = role;
            }
            if (password) {
                member.password = password;
            }
            if (!isSelf && typeof _addMemberPermissionsPanelShouldShow === 'function' && _addMemberPermissionsPanelShouldShow()) {
                var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
                var allowList = (overrides.allow || []).slice();
                if (allowList.length < 1) {
                    showAppModal('Select at least one user functionality to continue.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                if (!sessionCanAssignFeatureOverrides()) {
                    showAppModal('You do not have permission to change permission cards.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                member.featureOverrides = { allow: allowList, deny: [] };
            }
            return apiRequest(API_BASE + '/api/data/members/' + memberId, {
                method: 'PUT',
                body: member
            });
        })
        .then(function () {
            editingMemberId = null;
            _clearAddMemberForm();
            loadMembersAndRender();
            showAppModal('Profile updated successfully.', modalTitle);
            goToPage('manage-members');
        })
        .catch(function (err) {
            if (err && err.message === 'permissions') return;
            showAppModal('Failed to update profile: ' + (err && err.message ? err.message : 'Unknown error'), modalTitle);
        });
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
    if (hasOverrides && !sessionCanAssignFeatureOverrides()) {
        showAppModal('You do not have permission to assign permission cards when creating a member.', 'Add Member');
        return;
    }
    if (typeof _addMemberPermissionsPanelShouldShow === 'function' && _addMemberPermissionsPanelShouldShow()) {
        var allowList = (overrides.allow && overrides.allow.length) ? overrides.allow : [];
        if (allowList.length < 1) {
            showAppModal('Select at least one user functionality to continue.', 'Add Member');
            return;
        }
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

    apiRequest(API_BASE + '/api/data/members', {
        method: 'POST',
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
        return apiRequest(API_BASE + '/api/data/members/' + id, { method: 'DELETE' })
            .then(function () {
                showAppModal('Member disabled successfully.', 'Disable Member');
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
var editingMemberId = null;

function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    return typeof sessionCanAssignFeatureOverrides === 'function' && sessionCanAssignFeatureOverrides();
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.classList.toggle('is-hidden', !show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) renderAddMemberPermissionCards();
    if (show && typeof ensureAddMemberPageScroll === 'function') {
        setTimeout(ensureAddMemberPageScroll, 0);
    }
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
        card.setAttribute('title', 'Select or clear this functionality');
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
    editingMemberId = null;
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var userIdEl = document.getElementById('add-userid');
    if (userIdEl) {
        userIdEl.readOnly = false;
        userIdEl.disabled = false;
        userIdEl.classList.remove('input-readonly');
    }
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    _setAddMemberPageMode(false, false);
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
    editingMemberId = null;
    _clearAddMemberForm();
    _refreshAddMemberPermissionsPanelVisibility();
    goToPage('add-member');
    setTimeout(function () {
        if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
        var f = document.getElementById('add-fullname');
        if (f) f.focus();
    }, 60);
}

function cancelAddMemberEdit() {
    var returnToManage = editingMemberId != null;
    _clearAddMemberForm();
    goToPage(returnToManage ? 'manage-members' : 'user-profile');
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

    var payload = {};
    if (newName) payload.name = newName;
    if (newPassword) payload.password = newPassword;
    if (!payload.name && !payload.password) {
        if (typeof showAppModal === 'function') {
            showAppModal('Enter a new full name and/or password to save.', 'User Profile');
        }
        return;
    }
    if (!payload.name) {
        payload.name = (user.name || user.username || '').trim();
    }

    apiRequest(API_BASE + '/api/data/auth/profile', {
        method: 'PUT',
        body: payload
    })
        .then(function (result) {
            var updated = (result && result.member) ? result.member : result;
            var nameToSet = (updated && updated.name) ? updated.name : newName;
            updateLocalName(nameToSet || newName || (user.name || user.username));
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
            var wall = parseWallDatetimeIso(data.datetime);
            if (wall) {
                now = new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.sec);
            }
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
    apiRequest((API_BASE || '') + '/api/set_datetime', {
        method: 'POST',
        body: { datetime: dtStr }
    }).then(function (data) {
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                _wallClockAnchor = { parts: parts, at: Date.now() };
                applyWallClockToTopBar(parts);
            }
        }
        updateDateTime();
        showAppModal('Date and time updated.', 'Success', function () {
            goBack();
        });
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Network error';
        showAppModal('Failed to update date and time: ' + msg, 'Error');
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

function _factorySettingsFromApiResult(result) {
    return (result && result.settings) ? result.settings : (result || {});
}

function _persistFactorySettingsCache(settings) {
    try {
        localStorage.setItem('factorySettings', JSON.stringify(settings || {}));
    } catch (e) {}
}

function _applyFactoryPolicyFromSettings(settings) {
    applyBiometricSetting(normalizeBiometricEnabled(settings && settings.biometricEnabled));
    applyFactoryAutoLogoutSetting(settings || {});
}

/** Load factory policy from server (auto logout, biometric, password-reset period cache). */
function refreshFactoryPolicyFromServer() {
    return apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = _factorySettingsFromApiResult(result);
        _persistFactorySettingsCache(settings);
        _applyFactoryPolicyFromSettings(settings);
        updateLoginFactorySettingsDisplay(settings);
        return settings;
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            _applyFactoryPolicyFromSettings(settings);
            updateLoginFactorySettingsDisplay(settings);
            return settings;
        } catch (e) {
            _applyFactoryPolicyFromSettings({});
            updateLoginFactorySettingsDisplay({});
            return {};
        }
    });
}

function exportFromSelection(type) {
    if (type === 'audit') {
        if (typeof exportAuditTrails === 'function') exportAuditTrails();
        return;
    }
    if (typeof exportFilteredReports === 'function') {
        if (typeof currentReportFilter !== 'undefined' && currentReportFilter === 'audit') {
            currentReportFilter = 'all';
        }
        exportFilteredReports();
        return;
    }
    goToPage('reports');
}

function _escapeIpConfigureText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderIpConfigureList(payload) {
    var listEl = document.getElementById('ip-configure-list');
    if (!listEl) return;
    if (!payload || payload.ok === false) {
        var errMsg = (payload && (payload.error || payload.message)) ? (payload.error || payload.message) : 'Could not load network information.';
        listEl.innerHTML = '<div class="ip-configure-error">' + _escapeIpConfigureText(errMsg) + '</div>';
        return;
    }
    var wlan = payload.wlan != null && payload.wlan !== '' ? String(payload.wlan) : null;
    var lan = payload.lan != null && payload.lan !== '' ? String(payload.lan) : null;
    if (!wlan && !lan) {
        listEl.innerHTML = '<div class="ip-configure-empty">No IP address found. Check that this device is connected to the LAN or WLAN.</div>';
        return;
    }
    var rows = [
        { label: 'WLAN', address: wlan || '—' },
        { label: 'LAN', address: lan || '—' }
    ];
    var html = '';
    rows.forEach(function (row) {
        html += '<div class="ip-configure-row">' +
            '<span class="ip-configure-iface">' + _escapeIpConfigureText(row.label) + '</span>' +
            '<span class="ip-configure-address">' + _escapeIpConfigureText(row.address) + '</span>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

function refreshIpConfigureAddresses() {
    var listEl = document.getElementById('ip-configure-list');
    var refreshBtn = document.querySelector('.btn-refresh-ip-configure');
    if (listEl) {
        listEl.innerHTML = '<div class="ip-configure-loading">Loading addresses…</div>';
    }
    if (refreshBtn) refreshBtn.disabled = true;
    var base = (typeof API_BASE !== 'undefined' ? API_BASE : '');
    var headers = { 'Accept': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        if (window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    fetch(base + '/api/system/network-addresses', { method: 'GET', headers: headers })
        .then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (parseErr) {
                        data = {
                            ok: false,
                            error: res.ok
                                ? 'Invalid response from server.'
                                : ('Request failed (' + res.status + ').')
                        };
                    }
                } else {
                    data = { ok: false, error: 'Empty response from server.' };
                }
                if (!res.ok && data && !data.error) {
                    data.ok = false;
                    data.error = data.error || ('Request failed (' + res.status + ').');
                }
                return data;
            });
        })
        .then(function (data) {
            if (typeof data !== 'object' || data === null) {
                _renderIpConfigureList({ ok: false, error: 'Invalid response from server.' });
                return;
            }
            _renderIpConfigureList(data);
        })
        .catch(function () {
            _renderIpConfigureList({ ok: false, error: 'Could not reach the device network service.' });
        })
        .finally(function () {
            if (refreshBtn) refreshBtn.disabled = false;
        });
}

var _factoryPolicyRetryTimer = null;

function scheduleFactoryPolicyRefreshRetries() {
    if (_factoryPolicyRetryTimer != null) return;
    var attempts = 0;
    var maxAttempts = 24;
    _factoryPolicyRetryTimer = setInterval(function () {
        attempts++;
        var onLogin = document.getElementById('page-login');
        var loginVisible = onLogin && onLogin.style.display !== 'none';
        if (!loginVisible && window.currentUser) {
            clearInterval(_factoryPolicyRetryTimer);
            _factoryPolicyRetryTimer = null;
            return;
        }
        refreshFactoryPolicyFromServer().then(function (settings) {
            var mins = settings && settings.autoLogoutMinutes != null ? parseInt(settings.autoLogoutMinutes, 10) : 0;
            var days = settings && settings.passwordResetPeriodDays != null ? parseInt(settings.passwordResetPeriodDays, 10) : 0;
            if ((!isNaN(mins) && mins > 0) || (!isNaN(days) && days > 0) || attempts >= maxAttempts) {
                clearInterval(_factoryPolicyRetryTimer);
                _factoryPolicyRetryTimer = null;
            }
        });
        if (attempts >= maxAttempts) {
            clearInterval(_factoryPolicyRetryTimer);
            _factoryPolicyRetryTimer = null;
        }
    }, 5000);
}

function loadLoginFactorySettingsDisplay() {
    return refreshFactoryPolicyFromServer();
}

function initFactorySettings() {
    var screen = document.getElementById('page-factory-settings');
    if (!screen) return;
    refreshFactoryPolicyFromServer().then(function (settings) {
        setFactorySettingsForm(settings);
    }).catch(function () {
        var stored = null;
        try { stored = localStorage.getItem('factorySettings'); } catch (e) {}
        var settings = stored ? JSON.parse(stored) : {};
        setFactorySettingsForm(settings);
        _applyFactoryPolicyFromSettings(settings);
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
        ['factory-max-supervisors', 'maxSupervisors'],
        ['factory-max-qa', 'maxQa'],
        ['factory-password-reset-days', 'passwordResetPeriodDays'],
        ['factory-auto-logout-minutes', 'autoLogoutMinutes']
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
        else if (pair[1] === 'maxQa') el.value = String(val || 3);
        else if (pair[1] === 'passwordResetPeriodDays') el.value = String(val != null ? val : 30);
        else if (pair[1] === 'autoLogoutMinutes') el.value = String(val != null ? val : 0);
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
    var maxQaEl = document.getElementById('factory-max-qa');
    var passwordResetDaysEl = document.getElementById('factory-password-reset-days');
    var autoLogoutEl = document.getElementById('factory-auto-logout-minutes');
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
    var maxQa = Math.max(1, Math.min(99, parseInt(maxQaEl && maxQaEl.value ? maxQaEl.value : 3, 10)));
    var passwordResetPeriodDays = Math.max(1, Math.min(3650, parseInt(passwordResetDaysEl && passwordResetDaysEl.value ? passwordResetDaysEl.value : 30, 10)));
    var autoLogoutMinutes = Math.max(0, Math.min(10080, parseInt(autoLogoutEl && autoLogoutEl.value !== '' ? autoLogoutEl.value : '0', 10)));
    if (isNaN(autoLogoutMinutes)) autoLogoutMinutes = 0;

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
        maxQa: maxQa,
        passwordResetPeriodDays: passwordResetPeriodDays,
        autoLogoutMinutes: autoLogoutMinutes,
        biometricEnabled: normalizeBiometricEnabled(biometricEnabledEl ? biometricEnabledEl.value : true)
    };
    showConfirmModal('Save factory settings?', 'Factory Settings').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/factory-settings', { method: 'POST', body: data }).then(function (result) {
            var saved = _factorySettingsFromApiResult(result);
            if (!saved || !Object.keys(saved).length) saved = data;
            _persistFactorySettingsCache(saved);
            _applyFactoryPolicyFromSettings(saved);
            setFactorySettingsForm(saved);
            updateLoginFactorySettingsDisplay(saved);
            showAppModal('Factory settings saved successfully.', 'Factory Settings');
        }).catch(function (err) {
            _persistFactorySettingsCache(data);
            _applyFactoryPolicyFromSettings(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved locally.', 'Factory Settings');
        });
    });
}

function clearClientStateAfterFactoryReset() {
    window.currentUser = null;
    if (typeof currentUser !== 'undefined') currentUser = null;
    try {
        localStorage.removeItem('currentUser');
        localStorage.removeItem('disabledRecipes');
    } catch (e) {}
    validationCompletion = { distance: false, load: false };
    validationSessionResults = { distance: null, load: null };
    if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
}

function showFactoryResetConfirm() {
    showConfirmModal(
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, users, audit trails, and fingerprint enrollments. Factory settings (company/model/serial) are kept. This cannot be undone.',
        'Factory Reset'
    ).then(function (ok) {
        if (!ok) return;
        apiRequest((API_BASE || '') + '/api/data/factory-reset', { method: 'POST', body: {} })
            .then(function (result) {
                clearClientStateAfterFactoryReset();
                showAppModal(
                    'Factory reset completed. All reports, recipes, users, and audit trails have been erased.',
                    'Factory Reset'
                );
                if (typeof showLoginScreen === 'function') showLoginScreen();
            })
            .catch(function (err) {
                var msg = (err && err.message) ? err.message : 'Factory reset failed.';
                showAppModal(msg, 'Factory Reset');
            });
    });
}

function loadBiometricSetting() {
    return refreshFactoryPolicyFromServer().catch(function () {
        applyBiometricSetting(true);
        applyFactoryAutoLogoutSetting({});
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

function initKioskDomReady() {
    bindTestRunDecimalInputs();
    attachKeyboardToInputs();
    refreshFactoryPolicyFromServer();
    scheduleFactoryPolicyRefreshRetries();

    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var page = btn.getAttribute('data-page');
            if (page) goToPage(page);
        });
    });

    var originalGoToPage = goToPage;
    goToPage = function (pageName) {
        if (typeof markAutoLogoutActivity === 'function') markAutoLogoutActivity();
        if (originalGoToPage) originalGoToPage(pageName);
        setTimeout(function () {
            attachKeyboardToInputs();
        }, 200);
    };

    // Wire up Create Recipe Step 1 inputs to enable Save Recipe button
    var recipeNameEl = document.getElementById('recipe-product-name');
    if (recipeNameEl) {
        recipeNameEl.addEventListener('input', updateCreateRecipeContinueButton);
        recipeNameEl.addEventListener('change', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="create-speed"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-height"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-cylinder"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
        });
    });
    document.querySelectorAll('input[name="quick-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
        });
    });
    if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
    if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function resetKioskSessionAndShowLoginOnDomReady() {
    try { localStorage.removeItem('currentUser'); } catch (e) {}
    window.currentUser = null;
    if (typeof currentUser !== 'undefined') currentUser = null;
    if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
    window._lastReportPreview = null;
    var app = document.querySelector('.app-container');
    if (app) app.classList.remove('report-approval-locked');
    var resetUrl = (API_BASE || '') + '/api/data/auth/session-ui-reset';
    fetch(resetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .catch(function () {})
        .finally(function () {
            showLoginScreen();
        });
}

document.addEventListener('DOMContentLoaded', initKioskDomReady);
document.addEventListener('DOMContentLoaded', resetKioskSessionAndShowLoginOnDomReady);
