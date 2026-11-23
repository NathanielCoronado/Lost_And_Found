<?php
/* Lost & Found: shared server code (database, session, users, permissions).
   Every file in api/ starts with: require __DIR__ . '/lib.php'; api_start(); */

declare(strict_types=1);

const ARCHIVE_DAYS = 90;
const ROW_COLLS = ['lostReports', 'foundReports', 'claimRequests', 'foundNotices',
                   'notifications', 'userNotes', 'trash', 'deletedAccounts'];
const REPORT_COLLS = ['lostReports', 'foundReports'];
const REQUEST_COLLS = ['claimRequests', 'foundNotices'];
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

function config(): array {
  static $c = null;
  if ($c === null) $c = require __DIR__ . '/../private/config.php';
  return $c;
}

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $c = config();
  $pdo = new PDO('mysql:host=' . $c['db_host'] . ';dbname=' . $c['db_name'] . ';charset=utf8mb4',
                 $c['db_user'], $c['db_pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
  ]);
  return $pdo;
}

function is_https(): bool {
  return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
      || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

/* JSON API setup: headers, session, CSRF check, error handling. */
function api_start(): void {
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  set_exception_handler(function (Throwable $e) {
    error_log('Lost & Found API: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Server error. Try again in a moment.']);
  });
  start_session();
  // Only our own pages send this header; other sites can't (blocks cross-site form tricks).
  if (($_SERVER['HTTP_X_LF'] ?? '') !== '1') fail('Bad request.', 403);
}

function start_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  session_name('LFSESS');
  session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'httponly' => true,
                             'samesite' => 'Lax', 'secure' => is_https()]);
  session_start();
}

function out(array $a): void { echo json_encode($a, JSON_FLAGS); exit; }

function fail(string $msg, int $code = 200, array $extra = []): void {
  http_response_code($code);
  out(array_merge(['ok' => false, 'error' => $msg], $extra));
}

function body(): array {
  static $b = null;
  if ($b === null) {
    $raw = file_get_contents('php://input');
    $b = $raw ? json_decode($raw, true) : [];
    if (!is_array($b)) $b = [];
  }
  return $b;
}

function in(string $k, $default = '') { $b = body(); return $b[$k] ?? $default; }

function now_iso(): string { return gmdate('Y-m-d\TH:i:s') . '.' . sprintf('%03d', (int)(microtime(true) * 1000) % 1000) . 'Z'; }

function new_id(string $prefix): string {
  return $prefix . base_convert((string)(int)(microtime(true) * 1000), 10, 36) . bin2hex(random_bytes(3));
}

// Number of characters (works without the mbstring extension).
function text_len(string $s): int { return (int) preg_match_all('/./us', $s); }

function enc($v): string { return json_encode($v, JSON_FLAGS); }

// Objects stay objects ({} stays {}), so the browser gets back exactly what it saved.
function dec(?string $s) { $v = $s === null ? null : json_decode($s); return $v === null ? new stdClass() : $v; }

function next_counter(string $key): int {
  db()->prepare('INSERT INTO lf_counters (k, n) VALUES (?, 1) ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(n + 1)')
      ->execute([$key]);
  $n = (int) db()->query('SELECT LAST_INSERT_ID()')->fetchColumn();
  return $n > 0 ? $n : 1;
}

function meta_get(string $k): ?string {
  $s = db()->prepare('SELECT v FROM lf_meta WHERE k = ?'); $s->execute([$k]);
  $v = $s->fetchColumn(); return $v === false ? null : $v;
}
function meta_set(string $k, ?string $v): void {
  if ($v === null) { db()->prepare('DELETE FROM lf_meta WHERE k = ?')->execute([$k]); return; }
  db()->prepare('INSERT INTO lf_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)')->execute([$k, $v]);
}

/* ---------- Users ---------- */

// Row from lf_users with ->data decoded (stdClass), or null.
function user_row(string $id): ?array {
  $s = db()->prepare('SELECT * FROM lf_users WHERE id = ?'); $s->execute([$id]);
  $r = $s->fetch(); if (!$r) return null;
  $r['data'] = dec($r['data']); return $r;
}
function user_by_email(string $email): ?array {
  $s = db()->prepare('SELECT * FROM lf_users WHERE email = ?'); $s->execute([strtolower(trim($email))]);
  $r = $s->fetch(); if (!$r) return null;
  $r['data'] = dec($r['data']); return $r;
}

// Saves the JSON part and keeps the searchable columns in step with it.
function save_user(string $id, stdClass $d): void {
  unset($d->password);
  db()->prepare('UPDATE lf_users SET email = ?, account_type = ?, status = ?, data = ?, updated_at = NOW() WHERE id = ?')
      ->execute([strtolower(trim((string)($d->email ?? ''))), (string)($d->accountType ?? 'community'),
                 (string)($d->status ?? 'pending'), enc($d), $id]);
}

function add_activity(stdClass $d, string $text): void {
  $list = isset($d->activity) && is_array($d->activity) ? $d->activity : [];
  $list[] = ['text' => $text, 'at' => now_iso()];
  $d->activity = array_slice($list, -200);
}

function display_name(stdClass $d): string {
  $p = isset($d->profile) && is_object($d->profile) ? $d->profile : new stdClass();
  return trim(($p->firstName ?? $d->firstName ?? '') . ' ' . ($p->lastName ?? $d->lastName ?? ''));
}

// Logged-in user row, or null. Clears the session if the account is gone.
function me(): ?array {
  static $me = false;
  if ($me !== false) return $me;
  $id = $_SESSION['uid'] ?? null;
  $me = $id ? user_row($id) : null;
  if ($id && !$me) unset($_SESSION['uid']);
  return $me;
}
function role(?array $u): string { return $u ? (string)$u['account_type'] : ''; }
function is_admin(?array $u): bool { return role($u) === 'admin'; }
function is_office(?array $u): bool { return in_array(role($u), ['admin', 'staff'], true); }

// Same wording as statusBlockMessage() in lf-app.js.
function status_block(stdClass $d): string {
  $note = trim((string)($d->statusNote ?? ''));
  $n = $note !== '' ? ': ' . preg_replace('/[.!?]*$/', '', $note) . '.' : '.';
  switch ($d->status ?? '') {
    case 'pending':  return 'Your account is waiting for admin approval. You can log in once it\'s approved.';
    case 'declined': return 'Your account application was declined' . $n . ' Please sign up again.';
    case 'blocked':  return 'This account is blocked' . $n . ' Contact minicapstonproject@gmail.com if you think this is a mistake.';
  }
  return '';
}

function home_for(string $role): string {
  return $role === 'admin' ? 'ADMIN.html' : ($role === 'staff' ? 'STAFFHOME.html' : 'HOME.html');
}

function is_strong_password(string $v): bool {
  return strlen($v) >= 8 && preg_match('/[A-Z]/', $v) && preg_match('/[a-z]/', $v)
      && preg_match('/[0-9]/', $v) && preg_match('/[^A-Za-z0-9]/', $v);
}

/* ---------- Failed log-in tries ---------- */
function too_many_attempts(string $key, int $max = 10, int $minutes = 15): bool {
  $s = db()->prepare('SELECT COUNT(*) FROM lf_attempts WHERE k = ? AND at > (NOW() - INTERVAL ' . $minutes . ' MINUTE)');
  $s->execute([$key]); return (int)$s->fetchColumn() >= $max;
}
function add_attempt(string $key): void { db()->prepare('INSERT INTO lf_attempts (k) VALUES (?)')->execute([$key]); }
function clear_attempts(string $key): void { db()->prepare('DELETE FROM lf_attempts WHERE k = ?')->execute([$key]); }

/* ---------- Daily cleanup (InfinityFree has no reliable cron, so it runs on the first visit of the day) ---------- */
function daily_cleanup(): void {
  $today = gmdate('Y-m-d');
  if (meta_get('lastCleanup') === $today) return;
  meta_set('lastCleanup', $today);
  $pdo = db();
  $pdo->exec("DELETE FROM lf_rows WHERE coll = 'trash' AND updated_at < (NOW() - INTERVAL 1 DAY)");
  $pdo->exec("DELETE FROM lf_rows WHERE coll = 'deletedAccounts' AND updated_at < (NOW() - INTERVAL " . ARCHIVE_DAYS . " DAY)");
  $pdo->exec("DELETE FROM lf_deleted_users WHERE deleted_at < (NOW() - INTERVAL " . ARCHIVE_DAYS . " DAY)");
  $pdo->exec("DELETE FROM lf_attempts WHERE at < (NOW() - INTERVAL 1 DAY)");
}

/* =========================================================
   Batch 2: email, password resets, Google sign-in
   ========================================================= */

const RESET_SECONDS = 90;                     // codes and temporary passwords: 1 min 30 sec
const RESET_LABEL = '1 min 30 sec';
const CONTACT_EMAIL = 'minicapstonproject@gmail.com';

function email_ready(): bool {
  $c = config();
  return (!empty($c['gmail_user']) && !empty($c['gmail_app_password'])) || !empty($c['mail_test_file']);
}

// Sends a plain-text email through Gmail (PHPMailer). Returns true when Gmail accepted it.
function send_mail(string $to, string $name, string $subject, string $message): bool {
  if (!email_ready()) return false;
  $c = config();
  if (!empty($c['mail_test_file'])) {          // local testing only: write the email to a file instead of sending it
    file_put_contents($c['mail_test_file'], "TO: $to\nSUBJECT: $subject\n$message\n-----\n", FILE_APPEND);
    return true;
  }
  require_once __DIR__ . '/phpmailer/Exception.php';
  require_once __DIR__ . '/phpmailer/PHPMailer.php';
  require_once __DIR__ . '/phpmailer/SMTP.php';
  $c = config();
  $m = new PHPMailer\PHPMailer\PHPMailer(true);
  try {
    $m->isSMTP();
    $m->Host = 'smtp.gmail.com';
    $m->SMTPAuth = true;
    $m->Username = $c['gmail_user'];
    $m->Password = str_replace(' ', '', (string) $c['gmail_app_password']);
    $m->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
    $m->Port = 587;
    $m->Timeout = 20;
    $m->CharSet = 'UTF-8';
    $m->setFrom($c['gmail_user'], 'Lost and Found');
    $m->addReplyTo(CONTACT_EMAIL, 'Lost and Found Office');
    $m->addAddress($to, $name);
    $m->Subject = $subject;
    $m->Body = 'Hi ' . ($name !== '' ? $name : 'there') . ",\n\n" . $message;
    $m->send();
    return true;
  } catch (Throwable $e) {
    error_log('Lost & Found mail: ' . $m->ErrorInfo . ' ' . $e->getMessage());
    return false;
  }
}

/* ---------- Reset codes and temporary passwords (only hashes are saved) ---------- */
function reset_get(string $uid, string $kind): ?array {
  $s = db()->prepare('SELECT * FROM lf_resets WHERE user_id = ? AND kind = ?'); $s->execute([$uid, $kind]);
  return $s->fetch() ?: null;
}
function reset_put(string $uid, string $kind, string $secret): int {
  $exp = time() + RESET_SECONDS;
  db()->prepare('REPLACE INTO lf_resets (user_id, kind, hash, expires_at, tries, used_at) VALUES (?, ?, ?, ?, 0, NULL)')
      ->execute([$uid, $kind, password_hash($secret, PASSWORD_DEFAULT), $exp]);
  return $exp;
}
function reset_clear(string $uid, ?string $kind = null): void {
  if ($kind) db()->prepare('DELETE FROM lf_resets WHERE user_id = ? AND kind = ?')->execute([$uid, $kind]);
  else db()->prepare('DELETE FROM lf_resets WHERE user_id = ?')->execute([$uid]);
}

function temp_password(): string {
  $U = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; $l = 'abcdefghijkmnpqrstuvwxyz'; $d = '23456789';
  $p = fn(string $s) => $s[random_int(0, strlen($s) - 1)];
  return $p($U) . $p($l) . $p($d) . $p($l) . $p($U) . $p($l) . '-' . $p($d) . $p($d) . $p($d) . $p($d) . '!';
}

function fmt_when(int $ts): string {
  $dt = new DateTime('@' . $ts); $dt->setTimezone(new DateTimeZone('Asia/Manila'));
  return $dt->format('M j, Y') . ' at ' . $dt->format('g:i A');
}

function add_history(stdClass $d, string $action, string $by, string $note = ''): void {
  $h = isset($d->history) && is_array($d->history) ? $d->history : [];
  $h[] = ['action' => $action, 'by' => $by, 'at' => now_iso(), 'note' => $note];
  $d->history = $h;
}

// Saves a new password and clears every pending reset.
function set_password(array $u, string $pw, string $how): stdClass {
  $d = $u['data'];
  add_activity($d, $how);
  add_history($d, $how, display_name($d));
  $d->passwordChangedAt = now_iso();
  $d->mustChangePassword = false;
  $d->pendingReset = null;
  db()->prepare('UPDATE lf_users SET password_hash = ? WHERE id = ?')->execute([password_hash($pw, PASSWORD_DEFAULT), $u['id']]);
  save_user($u['id'], $d);
  reset_clear($u['id']);
  send_mail((string)($d->email ?? $u['email']), display_name($d), 'Your Lost and Found password was changed',
    'Your Lost and Found password was changed on ' . fmt_when(time()) . ' (' . strtolower($how) . ").\n\n" .
    "If this was you, you can ignore this email. If not, use \"Forgot password?\" on the log in page right away and reply to this email.\n\n" .
    "Lost and Found Office\n" . CONTACT_EMAIL);
  return $d;
}

/* ---------- Log in (shared by password and Google sign-in) ---------- */
// Checks terms and status, then starts the session. Never returns.
function finish_login(array $u, bool $mustChange = false): void {
  $d = $u['data'];
  if (empty($d->agreedToTerms)) {
    $_SESSION['pending'] = $u['id'];
    out(['ok' => true, 'next' => 'TERMSANDCONDITION.html']);
  }
  $block = status_block($d);
  if ($block !== '') {
    out(['ok' => false, 'error' => $block, 'type' => $u['status'] === 'pending' ? 'info' : 'error',
         'status' => $u['status'], 'userId' => $u['id'], 'note' => (string)($d->statusNote ?? '')]);
  }
  session_regenerate_id(true);
  unset($_SESSION['pending']);
  if ($mustChange || !empty($d->mustChangePassword)) {
    $_SESSION['pwchange'] = $u['id'];                 // choose a new password before going in
    out(['ok' => true, 'next' => 'FORGOT.html?mode=change']);
  }
  $_SESSION['uid'] = $u['id'];
  add_activity($d, 'Logged in');
  $approvedAt = null;
  if (empty($d->approvalSeen) && isset($d->history) && is_array($d->history)) {
    foreach ($d->history as $h) if (($h->action ?? '') === 'Account approved') $approvedAt = $h->at ?? null;
    if ($approvedAt) $d->approvalSeen = true;
  }
  save_user($u['id'], $d);
  out(['ok' => true, 'next' => home_for($u['account_type']), 'approvedAt' => $approvedAt]);
}

/* ---------- Google sign-in ---------- */
function http_get(string $url): ?string {
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_FOLLOWLOCATION => false]);
    $r = curl_exec($ch); curl_close($ch);
    return $r === false ? null : $r;
  }
  $r = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 15]]));
  return $r === false ? null : $r;
}

// Asks Google whether the sign-in token is real and meant for this site. Returns its details, or null.
function google_verify(string $credential): ?stdClass {
  $cid = trim((string)(config()['google_client_id'] ?? ''));
  if ($cid === '' || $credential === '') return null;
  $t = json_decode((string) http_get('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($credential)));
  if (!$t || ($t->aud ?? '') !== $cid) return null;
  if (!in_array($t->iss ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)) return null;
  if (!in_array($t->email_verified ?? '', [true, 'true'], true)) return null;
  if ((int)($t->exp ?? 0) < time()) return null;
  return $t;
}

/* ---------- Messages ---------- */
// Unread messages for this person (admin/staff: messages to the office).
function unread_messages(?array $me): int {
  if (!$me) return 0;
  try {
    if (is_office($me)) {
      $s = db()->query("SELECT COUNT(*) FROM lf_messages WHERE recipient = 'OFFICE' AND read_at IS NULL");
    } else {
      $s = db()->prepare('SELECT COUNT(*) FROM lf_messages WHERE recipient = ? AND read_at IS NULL');
      $s->execute([$me['id']]);
    }
    return (int) $s->fetchColumn();
  } catch (Throwable $e) {
    return 0;                         // the lf_messages table isn't imported yet
  }
}

/* ---------- Email verification (sign up, change of email) ---------- */
const EMAIL_CODE_SECONDS = 600;               // 10 minutes

function ev_key(string $email, string $purpose): string { return 'ev' . substr(sha1($purpose . '|' . strtolower(trim($email))), 0, 36); }

// Emails a 6-digit code. Returns its expiry (Unix time) or 0 if the email couldn't be sent.
function email_code_send(string $email, string $name, string $purpose): int {
  $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
  $exp = time() + EMAIL_CODE_SECONDS;
  db()->prepare("REPLACE INTO lf_resets (user_id, kind, hash, expires_at, tries, used_at) VALUES (?, 'verify', ?, ?, 0, NULL)")
      ->execute([ev_key($email, $purpose), password_hash($code, PASSWORD_DEFAULT), $exp]);
  $what = $purpose === 'signup' ? 'finish signing up for Lost and Found' : 'use this email for your Lost and Found account';
  $ok = send_mail($email, $name, 'Your Lost and Found verification code',
    "Your verification code is: $code\n\nEnter it to $what. It expires in 10 minutes.\n" .
    "If you didn't ask for this, ignore this email; nothing will change.\n\nLost and Found Office\n" . CONTACT_EMAIL);
  return $ok ? $exp : 0;
}

// '' when the code is right (and it is used up), otherwise the reason.
function email_code_check(string $email, string $purpose, string $code): string {
  $k = ev_key($email, $purpose);
  $s = db()->prepare("SELECT * FROM lf_resets WHERE user_id = ? AND kind = 'verify'"); $s->execute([$k]);
  $r = $s->fetch();
  if (!$r) return 'Enter the 6-digit code we emailed you. Send a new one if it didn\'t arrive.';
  if (time() > (int) $r['expires_at']) return 'This code has expired. Send a new one.';
  if ((int) $r['tries'] >= 5) return 'Too many wrong tries. Send a new code.';
  if (!password_verify(trim($code), $r['hash'])) {
    db()->prepare("UPDATE lf_resets SET tries = tries + 1 WHERE user_id = ? AND kind = 'verify'")->execute([$k]);
    return 'That code is wrong. Check the email and try again.';
  }
  db()->prepare("DELETE FROM lf_resets WHERE user_id = ? AND kind = 'verify'")->execute([$k]);
  return '';
}
