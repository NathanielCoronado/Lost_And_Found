<?php
/* Lost & Found: Forgot password, admin password reset, and deletion emails.
   POST JSON { action: '...', ... } with header X-LF: 1. Emails go out through Gmail (see private/config.php). */

require __DIR__ . '/lib.php';
api_start();

$action = (string) in('action');
$ip = 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? '');

switch ($action) {

  /* ---------- Forgot password, step 1: email a 6-digit code ---------- */
  case 'forgot_start': {
    if (!email_ready()) fail('Password reset by email isn\'t set up yet. Contact ' . CONTACT_EMAIL . ' for help.');
    $email = strtolower(trim((string) in('email')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
    if (too_many_attempts('forgot:' . $email, 5) || too_many_attempts('forgot-' . $ip, 20)) {
      fail('Too many codes were sent. Wait 15 minutes and try again.');
    }
    add_attempt('forgot:' . $email); add_attempt('forgot-' . $ip);
    unset($_SESSION['reset_uid']);
    $_SESSION['reset_email'] = $email;

    $u = user_by_email($email);
    // Same answer either way, so strangers can't check which emails have accounts.
    if (!$u) out(['ok' => true, 'expires' => (time() + RESET_SECONDS) * 1000]);

    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $exp = reset_put($u['id'], 'code', $code);
    $sent = send_mail((string)($u['data']->email ?? $email), display_name($u['data']), 'Your password reset code',
      "Your Lost and Found password reset code is: $code\n\n" .
      'It expires in ' . RESET_LABEL . ". If you did not ask for this, you can ignore this email; your password stays the same.\n\n" .
      "Lost and Found Office\n" . CONTACT_EMAIL);
    if (!$sent) { reset_clear($u['id'], 'code'); fail('We couldn\'t send the email right now. Try again in a moment.'); }
    out(['ok' => true, 'expires' => $exp * 1000]);
  }

  /* ---------- Forgot password, step 2: check the code ---------- */
  case 'forgot_check': {
    $email = $_SESSION['reset_email'] ?? '';
    $u = $email ? user_by_email($email) : null;
    $r = $u ? reset_get($u['id'], 'code') : null;
    if (!$r) fail('That code is wrong. Check the email and try again.');
    if (time() > (int)$r['expires_at']) { reset_clear($u['id'], 'code'); fail('This code has expired. Send a new one.'); }
    if ((int)$r['tries'] >= 5) fail('Too many wrong tries. Send a new code.');
    if (!password_verify(trim((string) in('code')), $r['hash'])) {
      db()->prepare("UPDATE lf_resets SET tries = tries + 1 WHERE user_id = ? AND kind = 'code'")->execute([$u['id']]);
      $left = 4 - (int)$r['tries'];
      fail($left > 0 ? 'That code is wrong. ' . $left . ($left === 1 ? ' try left.' : ' tries left.') : 'Too many wrong tries. Send a new code.');
    }
    reset_clear($u['id'], 'code');
    $_SESSION['reset_uid'] = $u['id'];
    $_SESSION['reset_until'] = time() + 600;           // 10 minutes to choose the new password
    out(['ok' => true]);
  }

  /* ---------- Forgot password step 3, or the forced change after an admin reset ---------- */
  case 'set_password': {
    $forced = !empty($_SESSION['pwchange']);
    $uid = $forced ? $_SESSION['pwchange'] : (($_SESSION['reset_until'] ?? 0) >= time() ? ($_SESSION['reset_uid'] ?? null) : null);
    $u = $uid ? user_row($uid) : null;
    if (!$u) fail($forced ? 'Log in again.' : 'This reset has expired. Start again with Forgot password.');
    $pw = (string) in('password');
    if (!is_strong_password($pw)) fail('Password needs at least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol.');
    $t = reset_get($u['id'], 'temp');
    if (password_verify($pw, $u['password_hash']) || ($t && password_verify($pw, $t['hash']))) {
      fail('Choose a password that is different from your old or temporary one.');
    }
    set_password($u, $pw, $forced ? 'Changed temporary password' : 'Password reset by email');
    unset($_SESSION['reset_uid'], $_SESSION['reset_until'], $_SESSION['reset_email'], $_SESSION['pwchange']);
    clear_attempts('login:' . strtolower($u['email']));
    if ($forced) {                                      // they already logged in with the temporary password
      $_SESSION['uid'] = $u['id'];
      out(['ok' => true, 'next' => home_for($u['account_type'])]);
    }
    out(['ok' => true]);
  }

  /* ---------- Admin: email a temporary password ---------- */
  case 'admin_reset': {
    $me = me();
    if (!is_admin($me)) fail('Only the admin can do this.', 403);
    if (!email_ready()) fail('Automatic email isn\'t set up.');
    $u = user_row((string) in('id'));
    if (!$u || $u['account_type'] === 'admin') fail('This account no longer exists.');
    $temp = temp_password();
    $exp = reset_put($u['id'], 'temp', $temp);
    $sent = send_mail((string)($u['data']->email ?? $u['email']), display_name($u['data']), 'Your Lost and Found password was reset',
      "An admin reset your Lost and Found password.\n\n" .
      "Temporary password: $temp\n" .
      'It expires in ' . RESET_LABEL . ". Your current password keeps working until you use it.\n\n" .
      "Log in with it, then choose a new password. If you did not ask for this, reply to this email.\n\n" .
      "Lost and Found Office\n" . CONTACT_EMAIL);
    $temp = null;
    if (!$sent) { reset_clear($u['id'], 'temp'); fail('The reset email could not be sent, so nothing changed. Try again in a moment.'); }
    $d = $u['data'];
    $now = now_iso();
    $d->pendingReset = ['at' => $now, 'sentAt' => $now, 'expires' => $exp * 1000];
    add_history($d, 'Password reset sent', display_name($me['data']), 'Temporary password emailed; expires in ' . RESET_LABEL);
    save_user($u['id'], $d);
    out(['ok' => true, 'expires' => $exp * 1000, 'user' => $d]);
  }

  case 'cancel_reset': {
    $me = me();
    if (!is_admin($me)) fail('Only the admin can do this.', 403);
    $u = user_row((string) in('id'));
    if (!$u) fail('This account no longer exists.');
    reset_clear($u['id'], 'temp');
    $d = $u['data'];
    $d->pendingReset = null;
    save_user($u['id'], $d);
    out(['ok' => true, 'user' => $d]);
  }

  /* ---------- Admin: email people whose accounts were deleted (after the 10-second Retrieve window) ---------- */
  case 'deletion_emails': {
    $me = me();
    if (!is_admin($me) || !email_ready()) out(['ok' => true, 'sent' => 0]);
    $rows = db()->query("SELECT *, UNIX_TIMESTAMP(deleted_at) AS ts FROM lf_deleted_users
                         WHERE by_who = 'admin' AND deleted_at < (NOW() - INTERVAL 12 SECOND)
                           AND deleted_at > (NOW() - INTERVAL 7 DAY)")->fetchAll();
    $sent = 0;
    foreach ($rows as $r) {
      if (meta_get('mailed:' . $r['id']) !== null) continue;
      meta_set('mailed:' . $r['id'], '1');              // mark first so two admin tabs don't both send it
      $note = ''; $name = '';
      $s = db()->prepare("SELECT data FROM lf_rows WHERE coll = 'deletedAccounts' AND id = ?");
      $s->execute([$r['email']]);
      if ($raw = $s->fetchColumn()) { $nd = dec($raw); $note = (string)($nd->note ?? ''); $name = (string)($nd->name ?? ''); }
      $ok = send_mail($r['email'], $name, 'Your Lost and Found account was deleted',
        'An admin deleted your Lost and Found account on ' . fmt_when((int)$r['ts']) . ".\n\n" .
        ($note !== '' ? 'Comment from the admin: ' . $note . "\n\n" : '') .
        "Your profile, reports, claim requests, and found notices were removed. You can no longer log in with this account.\n" .
        'You can sign up again with the same email within ' . ARCHIVE_DAYS . " days and choose to bring back your old reports and history, or start fresh.\n" .
        "If you think this is a mistake, reply to this email.\n\n" .
        "Lost and Found Office\n" . CONTACT_EMAIL);
      if ($ok) $sent++; else meta_set('mailed:' . $r['id'], null);
    }
    out(['ok' => true, 'sent' => $sent]);
  }
}

fail('Unknown action.', 400);
