# TD-2B 21 CFR Part 11 OQ Results

**Execution date:** 2026-08-17T16:14:47.756765
**API base:** http://127.0.0.1:5000

## Summary

- **Pass:** 81
- **Fail:** 0
- **N/A:** 9
- **Overall:** Compliant with Observations

## Test accounts

| User ID | Role | Password (post-setup) |
|---------|------|------------------------|
| OQADM1 | Admin | Oq@Chg1234! |
| OQREV1 | Supervisor | Oq@Chg1234! |
| OQQAA1 | QA | Oq@Chg1234! |
| OQUSR1 | User | Oq@Chg1234! |

## Results matrix

| Test ID | Description | Role | Result | Evidence | Remark |
|---------|-------------|------|--------|----------|--------|
| FAC-01 | Factory caps 10 users / 10 admins / 10 reviewers / 10 QA | Factory | Pass | maxUsers=10 maxAdmins=10 maxSupervisors=10 maxQa=10 |  |
| OQ-UM-01 | Administrator Creation | OQADM1 | Pass | member id=9 |  |
| OQ-UM-03 | Reviewer Creation | OQADM1 | Pass | member id=11 |  |
| OQ-UM-05 | User Creation | OQADM1 | Pass | member id=12 |  |
| OQ-UM-07 | QA Creation | OQADM1 | Pass | member id=14 |  |
| OQ-UM-02 | Administrator Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-04 | Reviewer Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-06 | User Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-08 | QA Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-09 | User Profile Edit Restriction | OQUSR1 | Pass | HTTP 403 |  |
| OQ-UM-AT | Audit Trail Check — User Management | OQREV1 | Pass |  |  |
| OQ-RP-01 | Individual Function Assignment | OQADM1 | Pass | HTTP 200 |  |
| OQ-RP-02 | Assignment Restricted to Authorised Role | OQUSR1 | Pass | HTTP 403 |  |
| OQ-RP-03 | Individual Power Enforcement | OQUSR1 | Pass | recipe=403 members=403 audit=403 datetime=403 |  |
| OQ-RP-AT | Audit Trail Check — Permission Configuration | OQADM1 | Pass |  |  |
| OQ-SEC-01 | Password Change — Administrator | OQADM1 | Pass | HTTP 200 |  |
| OQ-SEC-02 | Password Change — Reviewer | OQREV1 | Pass | HTTP 200 |  |
| OQ-SEC-03 | Password Change — User | OQUSR1 | Pass | HTTP 200 |  |
| OQ-SEC-04 | Password Change — QA | OQQAA1 | Pass | HTTP 200 |  |
| OQ-SEC-05 | Mandatory Password Change on First Login | New users | Pass |  | Verified during OQ user setup (mustChangePassword flow) |
| OQ-SEC-06 | Multiple Wrong Password Attempts | OQUSR1 | Pass |  |  |
| OQ-SEC-07 | Account Unlocking | OQADM1 | Pass |  |  |
| OQ-SEC-07 | Account Unlocking (non-admin denied) | OQUSR1 | Pass |  | negative unlock |
| OQ-SEC-08 | Password Policy Enforcement | OQADM1 | Pass |  |  |
| OQ-SEC-AT | Audit Trail Check — Security | OQADM1 | Pass |  |  |
| OQ-RC-01 | SP / Recipe Creation | OQUSR1 | Pass | id=19 |  |
| OQ-RC-02 | SP / Recipe Pending-Approval State | System | Pass | pending |  |
| OQ-RC-03 | Segregation of Duties — Creator Cannot Self-Approve | OQRC3 | Pass | HTTP 403 |  |
| OQ-RC-04 | SP / Recipe Approval | OQREV1 | Pass |  |  |
| OQ-RC-05 | SP / Recipe Rejection | OQREV1 | Pass | HTTP 200 |  |
| OQ-RC-06 | SP / Recipe Edit Restriction | OQUSR1 | Pass | pending |  |
| OQ-RC-AT | Audit Trail Check — SP/Recipe | OQREV1 | Pass |  |  |
| OQ-TE-HW | Adapter check before live taps | OQUSR1 | Pass | HTTP 200 mode=spd2 |  |
| OQ-TE-01 | Quick Test Execution | OQUSR1 | Pass | id=52 esp=completed |  |
| OQ-TE-02 | SP / Recipe Test Execution | OQUSR1 | Pass |  |  |
| OQ-TE-AT | Audit Trail Check — Test Execution | OQREV1 | Pass |  |  |
| OQ-WF-01 | Pre-Approval Printout / Preview | OQREV1 | Pass |  | check a4Text/banner |
| OQ-WF-06 | Final Report Only Post-Approval (pending blocked) | System | Pass | HTTP 403 |  |
| OQ-WF-02 | Approval Method — User ID & Password | OQREV1 | Pass |  |  |
| OQ-WF-04 | Approval of a PASS Result | OQREV1 | Pass |  |  |
| OQ-WF-06 | Final Report Generated Post-Approval | System | Pass |  |  |
| OQ-WF-05 | Approval of a FAIL Result | OQREV1 | Pass |  |  |
| OQ-WF-03 | Approval Method — Biometric / Fingerprint | OQREV1 | N/A |  | sensor identify did not succeed (Timed out waiting for finger) |
| OQ-WF-AT | Audit Trail Check — Approval | OQREV1 | Pass |  |  |
| OQ-PF-01 | Power Interruption During Active Test | User | N/A |  | Hardware mains switch |
| OQ-PF-02 | Power Restoration & Status on Re-Login | User | N/A |  | Hardware |
| OQ-PF-03 | Auto-Abort of Interrupted Test | System | Pass | smoke_powercut_checkpoint.py |  |
| OQ-PF-04 | Auto-Save & Auto-Approval on Power Failure | System | Pass |  | Auto-Approved – Power Failure |
| OQ-PF-AT | Audit Trail Check — Power Failure | Reviewer/QA | Pass |  |  |
| OQ-SYS-01 | Real-Time Clock (RTC) Setting | OQADM1 | Pass | HTTP 200 |  |
| OQ-SYS-02 | Date/Time Retention After Power Cycle | Administrator | N/A |  | Hardware power cycle |
| OQ-SYS-AT | Audit Trail Check — Date/Time Edit | OQADM1 | Pass |  |  |
| OQ-CV-01 | Instrument Calibration | Administrator | N/A |  | Metrological / placeholder UI |
| OQ-CV-02 | Instrument Validation | Administrator | Pass | verify_audit_trail partial |  |
| OQ-CV-03 | Calibration / Validation Restricted to Administrator | OQUSR1 | Pass | HTTP 403 |  |
| OQ-CV-04 | USB1 Port Validation | Administrator | N/A |  | No dedicated validation screen |
| OQ-CV-05 | USB2 Port Validation | Administrator | N/A |  | No dedicated validation screen |
| OQ-CV-AT | Audit Trail & Report Check — Calibration/Validation | Reviewer/QA | Pass |  |  |
| OQ-RPT-01 | Report Generation | User | Pass |  | reports created in §5/§6 |
| OQ-RPT-02 | Thermal Printer Output | OQUSR1 | Pass | HTTP 200 success=True err= |  |
| OQ-RPT-06 | Historical Report Reprint | Authorised User | Pass | HTTP 200 |  |
| OQ-RPT-07 | Reprinted Report Data Accuracy | Reviewer/QA | Pass | stored={'product': 'OQ Live ESP', 'batch': 'OQ-ESP-1', 'start': '2026-08-17T16:14:04', 'end': '2026-08-17T16:14:07'} expected={'product': 'OQ Live ESP', 'batch': 'OQ-ESP-1', 'start': '2026-08-17T16:14:04', 'end': '2026-08-17T16:14:07'} |  |
| OQ-RPT-03 | Dot Matrix Printer Output | User | N/A |  | A4 skipped |
| OQ-RPT-04 | Report Export | Authorised User | N/A |  | USB export hardware |
| OQ-RPT-05 | Role-Based Report Access | User | Pass | admin=6 user=20 own=True |  |
| OQ-RPT-AT | Audit Trail Check — Reporting | Reviewer/QA | Pass |  |  |
| OQ-CARD-01 | perm_test_access | OQPERM1 | Pass | checkpoint=200 members=403 audit=403 |  |
| OQ-CARD-02 | perm_test_report_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-03 | perm_recipe_manage | OQPERM1 | Pass | HTTP 201 |  |
| OQ-CARD-04 | perm_recipe_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-05 | perm_profile_admin | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-06 | perm_validation_test | OQPERM1 | Pass | HTTP 400 adapter_mismatch |  |
| OQ-CARD-07 | perm_validation_report_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-08 | perm_datetime | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-09 | perm_reports_view | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-10 | perm_audit_view | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-11 | perm_export_usb | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-12 | perm_export_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-NEG | reports_view cannot set datetime or view audit | OQPERM1 | Pass | datetime=403 audit=403 |  |
| IP-01 | IP Configure network addresses | OQADM1 | Pass | {'lan': '192.168.1.36', 'ok': True, 'refreshedAt': '2026-08-17T10:44:44Z', 'wlan': None} |  |
| OQ-AT-01 | Administrator Audit Trail Access | OQADM1 | Pass | HTTP 200 |  |
| OQ-AT-02 | Reviewer Audit Trail Access | OQREV1 | Pass | HTTP 200 |  |
| OQ-AT-03 | QA Audit Trail Access | OQQAA1 | Pass | HTTP 200 |  |
| OQ-AT-04 | User Audit Trail Restriction | OQUSR1 | Pass | HTTP 403 |  |
| OQ-AT-05 | Audit Trail Integrity | System | Pass |  | No delete route; append-only SQLite |
| OQ-AT-06 | Completeness Check | Reviewer/QA | Pass | Logout; Login; Report PDF generated; Audit log viewed; Report approved; Approval verification; Quick test performed; Report preview viewed; Recipe created; Added new user; Password reset; User permissions updated; Recipe approved; User unlocked; User update; Password changed; Power interruption logout; Power interruption; Report aborted (power loss); User disable; check adaptor and holder; holder error; Holder check error; Logout (inactivity timeout); Entered screen; Quick test started; Entered USP 1 validation; Test auto-aborted; Test started; Validation finished; Validation aborted; Validation started; Opened Load Recipe; Test aborted; Loaded recipe; Opened Quick Test; Exited screen; Test finished; User enabled; Biometric login | 52 distinct actions |
| OQ-NG-01 | User Attempting Administrator Function | OQUSR1 | Pass |  |  |
| OQ-NG-02 | Reviewer Attempting Administrator Function | OQREV1 | Pass |  |  |
| OQ-NG-03 | User Attempting SP/Recipe Approval | OQUSR1 | Pass |  | no recipe-approve permission |
| OQ-NG-04 | Disabled User Login Attempt | OQUSR2 | Pass | HTTP 403 |  |

## Audit completeness (distinct actions)

- Logout
- Login
- Report PDF generated
- Audit log viewed
- Report approved
- Approval verification
- Quick test performed
- Report preview viewed
- Recipe created
- Added new user
- Password reset
- User permissions updated
- Recipe approved
- User unlocked
- User update
- Password changed
- Power interruption logout
- Power interruption
- Report aborted (power loss)
- User disable
- check adaptor and holder
- holder error
- Holder check error
- Logout (inactivity timeout)
- Entered screen
- Quick test started
- Entered USP 1 validation
- Test auto-aborted
- Test started
- Validation finished
- Validation aborted
- Validation started
- Opened Load Recipe
- Test aborted
- Loaded recipe
- Opened Quick Test
- Exited screen
- Test finished
- User enabled
- Biometric login
- User unlock
- Opened Manage Recipe
- Print thermal
- Test performed
- System date change
- Biometric enroll
- Profile updated
- IP addresses viewed
- Recipe edited
- Recipe rejected
- User disabled
- Factory settings updated

## Smoke script outputs

### smoke_powercut_checkpoint.py
```
  OK   checkpoint saved with durationSeconds=94
  OK   isolated STORAGE_DIR (mirror optional)
  OK   recovered checkpoint from mirror after 0-byte USB wipe
  OK   reconstructed start≠end with duration=94 (start=2026-08-17T10:42:02.261355Z, end=2026-08-17T10:43:36.261355Z)
  OK   checkpoint detected as mid-test
  OK   power-cut report saved id=50 duration=94s start≠end
  OK   checkpoint cleared after recovery
  OK   audit: Power interruption
  OK   audit: Power interruption logout

Passed: 9  Failed: 0
[2026-08-17 16:13:37,838] WARNING in app: Ignoring stale clean-stop flag; mid-test checkpoint present — treating as unclean shutdown
[2026-08-17 16:13:40,261] WARNING in app: Ignoring stale clean-stop flag; mid-test checkpoint present — treating as unclean shutdown

```

### smoke_profile_enable_unlock.py
```
  OK   admin login
  FAIL no disabled/locked member and no USER1 fallback for enable/unlock test

```

### verify_audit_trail.py
```
=== Audit trail verification ===
API: http://127.0.0.1:5000
User: OQADM1

  OK   Login
  OK   Report created id=51
  OK   Quick test performed audit on report save
  OK   Logout (manual) recorded on live API
  OK   Logout (inactivity timeout) recorded (in-process logout route)
  OK   Adapter check API ok=False
  OK   validation/load/start mode=usp1 → adapter_mismatch (400)
  OK   validation/load/start mode=usp2 → adapter_mismatch (400)
  OK   Server-side adapter/holder error action in audit log
  OK   wrong-password audit shows attempt 1/3, 2/3, 3/3
  OK   unlocked OQUSR1 after wrong-password smoke
  WARN disable USER failed HTTP 403: {'error': 'Approval verification is required.'}
  OK   Factory audit event endpoint accepts POST (200)
  OK   Factory (RLERLT) Test started suppressed from audit log
  OK   Power interruption logged (9 row(s))
  OK   Power interruption logout logged (6 row(s))
  OK   Audit PDF HTML includes logout action(s)
  OK   Audit PDF HTML includes new action labels

--- Actions seen for test user since run ---
  Added new user
  Approval verification
  Audit log viewed
  Entered USP 1 validation
  Entered screen
  Exited screen
  Holder check error
  Loaded recipe
  Login
  Logout
  Logout (inactivity timeout)
  Opened Load Recipe
  Opened Quick Test
  Password changed
  Password reset
  Power interruption logout
  Quick test performed
  Quick test started
  Test aborted
  Test auto-aborted
  Test finished
  Test started
  User disable
  User enabled
  User permissions updated
  User unlocked
  User update
  Validation aborted
  Validation finished
  Validation started
  check adaptor and holder
  holder error
  WARN Simulated actions not all visible for OQADM1: ['Report aborted (power loss)', 'User disabled', 'Desktop login', 'Test performed']

Passed: 17, Failed: 0, Warnings: 2

```
