<?php
/* Lost & Found: log in, sign up, log out, terms, password change.
   POST JSON { action: '...', ... } with header X-LF: 1. */

require __DIR__ . '/lib.php';
api_start();

$action = (string) in('action');

switch ($action) {

  /* ---------- Log in ---------- */
  case 'login': {
    $email = strtolower(trim((string) in('email')));
    $pw = (string) in('password');
    $key = 'login:' . $email;
    $ip = 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? '');
    if (too_many_attempts($key) || too_many_attempts($ip, 30)) {
      fail('Too many wrong tries. Wait 15 minutes, or use Forgot password.');
    }
    $generic = 'Email or password is incorrect. No account yet? Sign up first.';
    $u = user_by_email($email);

    if (!$u) {
      // Deleted account? Only say so when the old password matches.
      $s = db()->prepare('SELECT *, UNIX_TIMESTAMP(deleted_at) AS ts FROM lf_deleted_users WHERE email = ? ORDER BY deleted_at DESC');
      $s->execute([$email]);
      foreach ($s->fetchAll() as $d) {
        if (!password_verify($pw, $d['password_hash'])) continue;
        $note = '';
        $n = db()->prepare("SELECT data FROM lf_rows WHERE coll = 'deletedAccounts' AND id = ?");
        $n->execute([$email]);
        if ($raw = $n->fetchColumn()) { $nd = dec($raw); $note = (string)($nd->note ?? ''); }
        out(['ok' => false, 'status' => 'deleted', 'by' => $d['by_who'], 'note' => $note,
             'at' => gmdate('Y-m-d\TH:i:s\Z', (int) $d['ts']), 'error' => 'This account was deleted.']);
      }
      add_attempt($key); add_attempt($ip);
      fail($generic);
    }

    $usingTemp = false;
    if (!password_verify($pw, $u['password_hash'])) {
      // Temporary password from an admin reset?
      $t = reset_get($u['id'], 'temp');
      if ($t && password_verify($pw, $t['hash'])) {
        $fresh = $t['used_at'] ? time() - (int)$t['used_at'] < 600 : time() <= (int)$t['expires_at'];
        if (!$fresh) {
          reset_clear($u['id'], 'temp');
          $d = $u['data']; $d->pendingReset = null; save_user($u['id'], $d);
          fail('This temporary password has expired (it lasts ' . RESET_LABEL . '). Ask the admin to send a new one, or use Forgot password.');
        }
        $usingTemp = true;
      } else {
        add_attempt($key); add_attempt($ip);
        fail($generic);
      }
    }
    clear_attempts($key);
    if ($usingTemp && !empty($u['data']->agreedToTerms) && status_block($u['data']) === '') {
      db()->prepare("UPDATE lf_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND kind = 'temp'")->execute([time(), $u['id']]);
      $d = $u['data'];
      $d->pendingReset = (object) array_merge((array)($d->pendingReset ?? []), ['usedAt' => $d->pendingReset->usedAt ?? now_iso()]);
      save_user($u['id'], $d);
      $u['data'] = $d;
    }
    finish_login($u, $usingTemp);
  }

  /* ---------- Google sign-in ---------- */
  case 'google': {
    $t = google_verify((string) in('credential'));
    if (!$t) fail('Google sign-in didn\'t work. Try again, or log in with your email and password.');
    $u = user_by_email((string) $t->email);
    if (!$u) {
      out(['ok' => false, 'status' => 'no-account', 'email' => (string) $t->email,
           'first' => (string)($t->given_name ?? ''), 'last' => (string)($t->family_name ?? ''),
           'error' => 'No account uses this Google email yet. Sign up first.']);
    }
    finish_login($u);
  }

  /* ---------- Log out ---------- */
  case 'logout':
    $_SESSION = [];
    session_destroy();
    out(['ok' => true]);

  /* ---------- Email verification code (sign up, or changing your email) ---------- */
  case 'email_code': {
    if (!email_ready()) out(['ok' => true, 'skipped' => true]);        // no email set up: nothing to verify with
    $email = strtolower(trim((string) in('email')));
    $purpose = in('purpose') === 'change' ? 'change' : 'signup';
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
    $ip = 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? '');
    if (too_many_attempts('ev:' . $email, 5) || too_many_attempts('ev-' . $ip, 20)) fail('Too many codes were sent. Wait 15 minutes and try again.');
    $name = trim((string) in('name'));
    if ($purpose === 'signup') {
      if (user_by_email($email) && user_by_email($email)['status'] !== 'declined') fail('An account with this email already exists. Log in instead.');
    } else {
      $me = me();
      if (!$me) fail('Log in again.');
      $other = user_by_email($email);
      if ($other && $other['id'] !== $me['id']) fail('That email is already used by another account.');
      $name = display_name($me['data']);
    }
    add_attempt('ev:' . $email); add_attempt('ev-' . $ip);
    $exp = email_code_send($email, $name, $purpose);
    if (!$exp) fail('We couldn\'t send the code right now. Check the email address and try again.');
    out(['ok' => true, 'expires' => $exp * 1000]);
  }

  /* ---------- Sign up ---------- */
  case 'register': {
    $first = trim((string) in('firstName'));
    $last = trim((string) in('lastName'));
    $email = strtolower(trim((string) in('email')));
    $pw = (string) in('password');
    $type = in('accountType') === 'staff' ? 'staff' : 'community';
    $validId = (string) in('validId');
    $photo = in('photo');
    $idType = in_array(in('idType'), ['student', 'government', 'other'], true) ? in('idType') : 'other';

    if (text_len($first) < 2 || text_len($last) < 2) fail('Enter your first and last name.');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
    if (!is_strong_password($pw)) fail('Password needs at least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol.');
    if (strpos($validId, 'data:image/') !== 0) fail('Upload a photo of your valid ID or student ID. The admin needs it to approve your account.');
    if (strlen($validId) > 4000000) fail('The ID photo is too large. Try a smaller photo.');
    if ($photo !== null && $photo !== '' && (!is_string($photo) || strpos($photo, 'data:image/') !== 0 || strlen($photo) > 3000000)) $photo = null;
    if (user_by_email($email)) fail('An account with this email already exists. Log in instead.');
    // The email must be real and yours: the code sent to it must match.
    if (email_ready()) {
      $err = email_code_check($email, 'signup', (string) in('emailCode'));
      if ($err !== '') fail($err, 200, ['codeError' => true]);
    }

    // Deleted account with this email: bring its data back (old password checked first), or start fresh.
    $restore = in('restore') === true && ($_SESSION['restore_ok'] ?? '') === $email;
    if (!$restore) db()->prepare("DELETE FROM lf_rows WHERE coll = 'deletedAccounts' AND id = ?")->execute([$email]);
    db()->prepare('DELETE FROM lf_deleted_users WHERE email = ?')->execute([$email]);
    unset($_SESSION['restore_ok']);

    $prefix = $type === 'staff' ? 'S' : 'U';
    $now = now_iso();
    $id = new_id('U');
    $d = (object) [
      'id' => $id, 'firstName' => $first, 'lastName' => $last, 'email' => (string) in('email'),
      'code' => $prefix . '-' . str_pad((string) next_counter('user-' . $prefix), 3, '0', STR_PAD_LEFT),
      'accountType' => $type, 'status' => 'pending', 'validId' => $validId, 'idType' => $idType,
      'agreedToTerms' => false, 'profileCompleted' => false, 'emailVerified' => email_ready(),
      'profile' => $photo ? (object) ['photo' => $photo] : null,
      'createdAt' => $now, 'restoreFrom' => $restore ? $email : null,
      'activity' => [
        ['text' => 'Created an account (' . ($type === 'staff' ? 'staff' : 'community user') . ')', 'at' => $now],
        ['text' => 'Uploaded a valid ID', 'at' => $now],
      ],
    ];
    if ($restore) add_activity($d, 'Asked to bring back the data of the deleted account');
    $d->email = trim($d->email);
    db()->prepare('INSERT INTO lf_users (id, email, password_hash, account_type, status, data) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$id, $email, password_hash($pw, PASSWORD_DEFAULT), $type, 'pending', enc($d)]);
    $_SESSION['pending'] = $id;
    out(['ok' => true, 'user' => $d]);
  }

  /* ---------- Sign up: is this email taken? (id and status only) ---------- */
  case 'email_status': {
    $u = user_by_email((string) in('email'));
    out(['ok' => true, 'user' => $u ? ['id' => $u['id'], 'email' => $u['data']->email ?? $u['email'], 'status' => $u['status']] : null]);
  }

  /* ---------- Declined application: remove it so the person can sign up again ---------- */
  case 'clear_declined': {
    $u = user_row((string) in('id'));
    if (!$u || $u['status'] !== 'declined') out(['ok' => true, 'user' => null]);
    db()->prepare('DELETE FROM lf_rows WHERE owner_id = ? AND coll IN (\'lostReports\',\'foundReports\',\'claimRequests\',\'foundNotices\',\'userNotes\')')->execute([$u['id']]);
    db()->prepare('DELETE FROM lf_users WHERE id = ?')->execute([$u['id']]);
    if (($_SESSION['pending'] ?? null) === $u['id']) unset($_SESSION['pending']);
    $d = $u['data'];
    out(['ok' => true, 'user' => ['firstName' => $d->firstName ?? '', 'lastName' => $d->lastName ?? '',
                                  'email' => $d->email ?? $u['email'], 'accountType' => $u['account_type']]]);
  }

  /* ---------- Terms page (between sign up and application) ---------- */
  case 'agree_terms': {
    $id = $_SESSION['pending'] ?? null;
    $u = $id ? user_row($id) : null;
    if (!$u) fail('Sign up or log in first.');
    $d = $u['data'];
    $d->agreedToTerms = true;
    add_activity($d, 'Agreed to the Terms and Conditions');
    save_user($u['id'], $d);
    out(['ok' => true, 'user' => $d]);
  }

  case 'clear_pending':
    unset($_SESSION['pending']);
    out(['ok' => true]);

  /* ---------- Sign up with the email of a deleted account ---------- */
  case 'archive_info': {
    $email = strtolower(trim((string) in('email')));
    $s = db()->prepare("SELECT data, UNIX_TIMESTAMP(updated_at) AS ts FROM lf_rows WHERE coll = 'deletedAccounts' AND id = ?");
    $s->execute([$email]);
    $r = $s->fetch();
    $d = $r ? dec($r['data']) : null;
    if (!$d || empty($d->archive) || empty($d->archive->user)) out(['ok' => true, 'info' => null]);
    $oldId = $d->archive->user->id ?? '';
    $c = ['reports' => 0, 'requests' => 0];
    foreach ((array)($d->archive->removed ?? []) as $kind => $list) {
      foreach ((array) $list as $rec) {
        if (($rec->ownerId ?? '') !== $oldId) continue;
        if ($kind === 'lost' || $kind === 'found') $c['reports']++; else $c['requests']++;
      }
    }
    $old = $d->archive->user;
    out(['ok' => true, 'info' => ['at' => $d->at ?? gmdate('Y-m-d\TH:i:s\Z', (int)$r['ts']), 'by' => $d->by ?? '',
         'reports' => $c['reports'], 'requests' => $c['requests'],
         'hasHistory' => !empty($old->history) || !empty($old->activity)]]);
  }

  case 'archive_check': {
    $email = strtolower(trim((string) in('email')));
    $key = 'archive:' . $email;
    if (too_many_attempts($key, 5)) fail('Too many wrong tries. Wait 15 minutes, or choose Start fresh.');
    $s = db()->prepare('SELECT password_hash FROM lf_deleted_users WHERE email = ?');
    $s->execute([$email]);
    foreach ($s->fetchAll(PDO::FETCH_COLUMN) as $h) {
      if (password_verify((string) in('password'), $h)) { $_SESSION['restore_ok'] = $email; clear_attempts($key); out(['ok' => true]); }
    }
    add_attempt($key);
    fail('The old password is wrong. Try again, or choose Start fresh.');
  }

  /* ---------- Change password (Account Settings) ---------- */
  case 'change_password': {
    $me = me();
    if (!$me) fail('Log in again.');
    $cur = (string) in('current');
    $next = (string) in('next');
    if (!password_verify($cur, $me['password_hash'])) fail('Your current password is wrong.');
    if (!is_strong_password($next)) fail('Password needs at least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol.');
    if ($next === $cur) fail('Choose a password that is different from your current one.');
    $d = set_password($me, $next, 'Changed password');
    out(['ok' => true, 'user' => $d]);
  }
}

fail('Unknown action.', 400);
