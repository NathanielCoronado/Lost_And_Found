<?php
/* Lost & Found: saves changes from the browser.
   POST { coll, upserts: [row, ...], deletes: [id, ...] }   save rows of one list
   POST { meta: 'siteLogo', value: ... }                    site settings (admin)
   POST { op: 'next_case', kind: 'lost'|'found'|'claim'|'notice' }
   Rows the user may not change are skipped; the rest is saved. */

require __DIR__ . '/lib.php';
api_start();

$me = me();
if (!$me) fail('Your session ended. Log in again.', 401, ['relogin' => true]);
if (!is_admin($me) && $me['status'] !== 'approved') fail('Your account can\'t make changes right now.', 403);
$uid = $me['id'];
$office = is_office($me);

/* ---------- Case numbers ---------- */
if (in('op') === 'next_case') {
  $prefix = ['claim' => 'CR', 'notice' => 'FN'][in('kind')] ?? null;
  $n = str_pad((string) next_counter($prefix ? 'req-' . $prefix : 'case'), 10, '0', STR_PAD_LEFT);
  out(['ok' => true, 'caseNo' => $prefix ? $prefix . '-' . $n : $n]);
}

/* ---------- Site settings ---------- */
if (in('meta') !== '') {
  if (in('meta') !== 'siteLogo') fail('Unknown setting.', 400);
  if (!is_admin($me)) fail('Only the admin can change this.', 403);
  $v = body()['value'] ?? null;
  meta_set('siteLogo', $v === null ? null : enc($v));
  out(['ok' => true]);
}

$coll = (string) in('coll');
$dels = is_array(body()['deletes'] ?? null) ? body()['deletes'] : [];
// Decode rows again as objects so {} stays {}.
$raw = json_decode(file_get_contents('php://input'));
$ups = isset($raw->upserts) && is_array($raw->upserts) ? $raw->upserts : [];
$skipped = [];

/* =========================================================
   Users
   ========================================================= */
if ($coll === 'users') {
  // Fields only the admin (or the server) may change.
  $protected = ['id', 'code', 'accountType', 'status', 'statusNote', 'createdAt', 'history', 'approvalSeen', 'emailVerified',
                'pendingReset', 'mustChangePassword', 'passwordChangedAt', 'restoreFrom'];
  $endSession = false;

  foreach ($ups as $row) {
    if (!is_object($row) || empty($row->id)) continue;
    $id = (string) $row->id;
    unset($row->password);
    $ex = user_row($id);

    if (!$ex) {
      // Admin "Retrieve" of a deleted account: bring back its password.
      if (!is_admin($me)) { $skipped[] = $id; continue; }
      $s = db()->prepare('SELECT * FROM lf_deleted_users WHERE id = ?'); $s->execute([$id]);
      $old = $s->fetch();
      if (!$old) { $skipped[] = $id; continue; }
      $email = strtolower(trim((string)($row->email ?? $old['email'])));
      if (user_by_email($email)) { $skipped[] = $id; continue; }
      db()->prepare('INSERT INTO lf_users (id, email, password_hash, account_type, status, data) VALUES (?, ?, ?, ?, ?, ?)')
          ->execute([$id, $email, $old['password_hash'], (string)($row->accountType ?? 'community'), (string)($row->status ?? 'approved'), enc($row)]);
      db()->prepare('DELETE FROM lf_deleted_users WHERE id = ?')->execute([$id]);
      continue;
    }

    if (!is_admin($me)) {
      if ($id !== $uid) { $skipped[] = $id; continue; }
      foreach ($protected as $k) {
        if (property_exists($ex['data'], $k)) $row->$k = $ex['data']->$k; else unset($row->$k);
      }
    } else {
      // Kept by the server (password resets, first-login message), so an older copy on the admin page can't undo them.
      foreach (['pendingReset', 'passwordChangedAt', 'mustChangePassword', 'approvalSeen'] as $k) {
        if (property_exists($ex['data'], $k)) $row->$k = $ex['data']->$k; else unset($row->$k);
      }
      if ($id === $uid) {
        $row->accountType = 'admin';        // the admin can't lock themselves out
        $row->status = 'approved';
      }
    }

    $email = strtolower(trim((string)($row->email ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
    $other = user_by_email($email);
    if ($other && $other['id'] !== $id) fail('That email is already used by another account.');
    $code = (string)($row->emailCode ?? '');
    unset($row->emailCode);
    if ($email !== strtolower($ex['email'])) {
      // Changing your own email: prove the new address is yours. (The admin may correct other people's emails.)
      if ($id === $uid && email_ready()) {
        if ($code === '') fail('To change your email, go to Account Settings. We\'ll send a code to the new email.');
        $err = email_code_check($email, 'change', $code);
        if ($err !== '') fail($err, 200, ['codeError' => true]);
      }
      $row->emailVerified = $id === $uid && email_ready();
      send_mail($ex['email'], display_name($ex['data']), 'Your Lost and Found email was changed',
        'The email of your Lost and Found account was changed from ' . $ex['email'] . ' to ' . $email . ' on ' . fmt_when(time()) . ".\n\n" .
        "If this was you, you can ignore this email. If not, reply to this email right away.\n\nLost and Found Office\n" . CONTACT_EMAIL);
    }
    save_user($id, $row);
  }

  foreach ($dels as $id) {
    $id = (string) $id;
    $self = $id === $uid;
    if (!(is_admin($me) ? !$self : $self)) { $skipped[] = $id; continue; }
    $ex = user_row($id);
    if (!$ex) continue;
    // Keep the password hash so the person is told the account was deleted, and the admin can Retrieve it.
    db()->prepare('REPLACE INTO lf_deleted_users (id, email, password_hash, by_who, data) VALUES (?, ?, ?, ?, NULL)')
        ->execute([$id, $ex['email'], $ex['password_hash'], $self ? 'self' : 'admin']);
    db()->prepare('DELETE FROM lf_users WHERE id = ?')->execute([$id]);
    if ($self) $endSession = true;
  }

  if ($endSession) { $_SESSION = []; session_destroy(); }
  out(['ok' => true, 'skipped' => $skipped]);
}

/* =========================================================
   Reports, requests, notifications, trash
   ========================================================= */
if (!in_array($coll, ROW_COLLS, true)) fail('Unknown list.', 400);

$isReport = in_array($coll, REPORT_COLLS, true);
$isRequest = in_array($coll, REQUEST_COLLS, true);

function existing_row(string $coll, string $id): ?array {
  $s = db()->prepare('SELECT owner_id, data FROM lf_rows WHERE coll = ? AND id = ?'); $s->execute([$coll, $id]);
  $r = $s->fetch(); if (!$r) return null;
  $r['data'] = dec($r['data']); return $r;
}
function report_owner(?string $caseNo): ?string {
  static $cache = [];
  if (!$caseNo) return null;
  if (!array_key_exists($caseNo, $cache)) {
    $s = db()->prepare("SELECT owner_id FROM lf_rows WHERE coll IN ('lostReports','foundReports') AND case_no = ? LIMIT 1");
    $s->execute([$caseNo]);
    $cache[$caseNo] = $s->fetchColumn() ?: null;
  }
  return $cache[$caseNo];
}

function is_public_report(stdClass $r): bool { $rv = (string)($r->review ?? ''); return $rv === '' || $rv === 'posted'; }
function is_finished(stdClass $r): bool { return in_array(strtolower((string)($r->status ?? '')), ['claimed', 'disposed', 'closed'], true); }

// Comments are merged, never replaced: nobody's comment is lost when two people save at once.
// Only your own new comments are added; removing needs to be the writer, staff/admin, or the report's owner.
$NEW_COMMENTS = [];
function merge_comments(string $coll, $oldList, $newList, array $me, bool $canAdd, bool $isReportOwner, bool $private, string $rowId): array {
  global $NEW_COMMENTS;
  $uid = $me['id']; $office = is_office($me);
  $out = []; $idx = [];
  foreach ((array)$oldList as $c) {
    if (!is_object($c) || empty($c->id)) continue;
    $idx[(string)$c->id] = count($out); $out[] = $c;
  }
  foreach ((array)$newList as $c) {
    if (!is_object($c) || empty($c->id)) continue;
    $cid = substr((string)$c->id, 0, 60);
    if (isset($idx[$cid])) {
      $o = $out[$idx[$cid]];
      if (!empty($c->removed) && empty($o->removed) && ($office || $isReportOwner || ($o->byId ?? '') === $uid)) {
        $o->removed = true; $o->text = ''; $o->removedBy = role($me); $o->removedAt = now_iso();
      }
      continue;
    }
    if (!$canAdd || ($c->byId ?? '') !== $uid || !empty($c->removed)) continue;
    $text = trim((string)($c->text ?? ''));
    if ($text === '') continue;
    if (text_len($text) > 1000) { preg_match('/^.{0,1000}/us', $text, $m); $text = $m[0]; }
    $nc = (object) ['id' => $cid, 'by' => display_name($me['data']) ?: (string)($c->by ?? ''), 'byId' => $uid,
                    'role' => role($me), 'text' => $text, 'at' => now_iso()];
    // Private: forced before posting; after that, staff/admin or the report's owner may choose it.
    if ($private || ($coll !== 'claimRequests' && $coll !== 'foundNotices' && !empty($c->private) && ($office || $isReportOwner))) $nc->private = true;
    $idx[$cid] = count($out); $out[] = $nc;
    $NEW_COMMENTS[] = ['coll' => $coll, 'id' => $rowId, 'comment' => $nc];
  }
  return $out;
}

// Stops the same report or request from being sent twice (double taps, slow connections, two tabs).
function no_duplicate(string $coll, stdClass $row, string $uid): void {
  if (in_array($coll, REPORT_COLLS, true)) {
    $s = db()->prepare('SELECT data FROM lf_rows WHERE coll = ? AND owner_id = ? AND updated_at > (NOW() - INTERVAL 30 MINUTE)');
    $s->execute([$coll, $uid]);
    $key = function ($r) { return strtolower(trim((string)($r->itemName ?? ''))) . '|' . ($r->date ?? '') . '|' . ($r->location ?? '') . '|' . strtolower(trim((string)($r->description ?? ''))); };
    foreach ($s->fetchAll(PDO::FETCH_COLUMN) as $raw) {
      if ($key(dec($raw)) === $key($row)) fail('You already submitted this report. You can find it in My Reports.', 200, ['duplicate' => true]);
    }
    return;
  }
  if (in_array($coll, REQUEST_COLLS, true) && !empty($row->refCase)) {
    $s = db()->prepare('SELECT data FROM lf_rows WHERE coll = ? AND owner_id = ? AND ref_case = ?');
    $s->execute([$coll, $uid, (string) $row->refCase]);
    foreach ($s->fetchAll(PDO::FETCH_COLUMN) as $raw) {
      if (strtolower((string)(dec($raw)->status ?? '')) !== 'rejected') {
        fail('You already sent a ' . ($coll === 'claimRequests' ? 'claim request' : 'found notice') . ' for this item. You can follow it in My Reports.', 200, ['duplicate' => true]);
      }
    }
  }
}

// Returns the row to save (maybe adjusted), or null to skip it.
function allowed_upsert(string $coll, stdClass $row, ?array $ex, array $me): ?stdClass {
  global $isReport, $isRequest;
  $uid = $me['id'];
  if (is_office($me)) {
    if ($coll === 'deletedAccounts' && !is_admin($me)) return null;
    if (($isReport || $isRequest) && $ex) {
      $row->comments = merge_comments($coll, $ex['data']->comments ?? [], $row->comments ?? [], $me, true, false,
                                      $isReport && !is_public_report($ex['data']), (string)($row->id ?? ''));
    }
    return $row;
  }
  switch ($coll) {
    case 'notifications':                          // community can add office notifications only
      return $ex ? null : $row;
    case 'userNotes':
      if (($row->userId ?? null) !== $uid) return null;
      if ($ex && $ex['owner_id'] !== $uid) return null;
      return $row;
    case 'trash':
      return (!$ex || $ex['owner_id'] === $uid) ? $row : null;
    case 'deletedAccounts':                        // own account only (Delete account)
      return (!$ex && strtolower((string)($row->email ?? '')) === strtolower($me['email'])) ? $row : null;
  }

  // Reports and requests
  if (!$ex) {
    $owner = $row->ownerId ?? null;
    if ($owner === $uid) no_duplicate($coll, $row, $uid);
    if ($isReport) {
      if ($owner !== $uid) return null;
      $row->review = 'pending';                    // staff approve and post it first
      return $row;
    }
    if ($owner === $uid) {                         // new claim request / found notice
      if (($row->status ?? '') !== 'Pending Review' && report_owner($row->refCase ?? null) !== $uid) $row->status = 'Pending Review';
      return $row;
    }
    return report_owner($row->refCase ?? null) === $uid ? $row : null;   // Retrieve on my report
  }

  $old = $ex['data'];
  $isOwner = ($old->ownerId ?? null) === $uid;
  $isReportOwner = $isRequest && report_owner($old->refCase ?? null) === $uid;
  if (!$isOwner && !$isReportOwner) {
    // Anyone may comment on a posted report (and remove their own comment); nothing else changes.
    if (!$isReport || !is_public_report($old)) return null;
    $keep = clone $old;
    $keep->comments = merge_comments($coll, $old->comments ?? [], $row->comments ?? [], $me, !is_finished($old), false, false, (string)($old->id ?? ''));
    return $keep;
  }
  $row->ownerId = $old->ownerId ?? null;
  $row->comments = merge_comments($coll, $old->comments ?? [], $row->comments ?? [], $me, true, $isReport && $isOwner,
                                  $isReport && !is_public_report($old), (string)($old->id ?? ''));
  if ($isReport && ($row->review ?? null) !== ($old->review ?? null) && ($row->review ?? null) !== 'pending') {
    $row->review = $old->review ?? null;           // only staff/admin approve or post
  }
  if ($isRequest && !$isReportOwner) {              // the sender can't approve their own request
    if (($row->status ?? null) !== ($old->status ?? null) && ($row->status ?? null) !== 'Pending Review') $row->status = $old->status ?? null;
    $row->settled = $old->settled ?? null;
  }
  return $row;
}

function allowed_delete(string $coll, array $ex, array $me): bool {
  global $isRequest;
  $uid = $me['id'];
  if (is_office($me)) return $coll !== 'deletedAccounts' || is_admin($me);
  if (in_array($coll, ['notifications', 'deletedAccounts'], true)) return false;
  if (in_array($coll, ['userNotes', 'trash'], true)) return $ex['owner_id'] === $uid;
  if (($ex['data']->ownerId ?? null) === $uid) return true;
  return $isRequest && report_owner($ex['data']->refCase ?? null) === $uid;
}

$save = db()->prepare('INSERT INTO lf_rows (coll, id, owner_id, case_no, ref_case, review, data, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                       ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id), case_no = VALUES(case_no), ref_case = VALUES(ref_case),
                                               review = VALUES(review), data = VALUES(data), updated_at = NOW()');

foreach ($ups as $row) {
  if (!is_object($row)) continue;
  $id = $coll === 'deletedAccounts' ? (string)($row->id ?? strtolower((string)($row->email ?? ''))) : (string)($row->id ?? '');
  if ($id === '' || strlen($id) > 190) continue;
  $ex = existing_row($coll, $id);
  $row = allowed_upsert($coll, $row, $ex, $me);
  if (!$row) { $skipped[] = $id; continue; }

  if ($isReport || $isRequest) $owner = $row->ownerId ?? null;
  elseif ($coll === 'userNotes') $owner = $row->userId ?? null;
  elseif (in_array($coll, ['trash', 'deletedAccounts'], true)) $owner = $ex ? $ex['owner_id'] : $uid;
  else $owner = null;

  $save->execute([$coll, $id, $owner, isset($row->caseNo) ? (string)$row->caseNo : null,
                  isset($row->refCase) ? (string)$row->refCase : null,
                  isset($row->review) ? (string)$row->review : null, enc($row)]);
}

/* ---------- Tell people about new comments on reports ---------- */
function add_user_note(string $userId, string $text, string $caseNo, ?string $link = null): void {
  $id = new_id('UN');
  $d = ['id' => $id, 'userId' => $userId, 'text' => $text, 'caseNo' => $caseNo, 'at' => now_iso(), 'read' => false];
  if ($link) $d['link'] = $link;
  db()->prepare("INSERT INTO lf_rows (coll, id, owner_id, data) VALUES ('userNotes', ?, ?, ?)")->execute([$id, $userId, enc($d)]);
}
function add_office_note(string $text, string $caseNo): void {
  $id = new_id('N');
  db()->prepare("INSERT INTO lf_rows (coll, id, data) VALUES ('notifications', ?, ?)")
      ->execute([$id, enc(['id' => $id, 'text' => $text, 'caseNo' => $caseNo, 'at' => now_iso(), 'read' => false])]);
}
if ($isReport && $NEW_COMMENTS) {
  $myName = display_name($me['data']);
  foreach ($NEW_COMMENTS as $n) {
    $r = existing_row($coll, $n['id']);
    if (!$r) continue;
    $rec = $r['data']; $c = $n['comment'];
    $label = ($coll === 'lostReports' ? 'lost' : 'found') . ' report #' . ($rec->caseNo ?? '') . ' (' . ($rec->itemName ?? 'item') . ')';
    $snip = text_len($c->text) > 120 ? preg_replace('/^(.{0,120}).*$/us', '$1', $c->text) . '…' : $c->text;
    $owner = (string)($rec->ownerId ?? '');
    $caseNo = (string)($rec->caseNo ?? '');
    $pub = is_public_report($rec);
    if ($owner !== '' && $owner !== $uid) add_user_note($owner, $myName . ' commented on your ' . $label . ': "' . $snip . '"', $caseNo);
    if ($pub && empty($c->private)) {                // others who joined the thread
      $told = [$uid => 1, $owner => 1];
      foreach ((array)($rec->comments ?? []) as $o) {
        $who = (string)($o->byId ?? '');
        if ($who === '' || isset($told[$who]) || !empty($o->removed) || in_array($o->role ?? '', ['admin', 'staff'], true)) continue;
        $told[$who] = 1;
        add_user_note($who, $myName . ' also commented on ' . $label . ': "' . $snip . '"', $caseNo, 'SEEK.html?q=' . rawurlencode($caseNo));
      }
    }
    if (!$office && !$pub) add_office_note($myName . ' commented on ' . $label . ', which isn\'t posted yet: "' . $snip . '"', $caseNo);
  }
}

foreach ($dels as $id) {
  $id = (string) $id;
  $ex = existing_row($coll, $id);
  if (!$ex) continue;                                // already gone
  if (!allowed_delete($coll, $ex, $me)) { $skipped[] = $id; continue; }
  db()->prepare('DELETE FROM lf_rows WHERE coll = ? AND id = ?')->execute([$coll, $id]);
  // A deleted report takes its claim requests and found notices with it.
  if ($isReport && !empty($ex['data']->caseNo)) {
    db()->prepare("DELETE FROM lf_rows WHERE coll IN ('claimRequests','foundNotices') AND ref_case = ?")->execute([(string)$ex['data']->caseNo]);
  }
}

out(['ok' => true, 'skipped' => $skipped]);
