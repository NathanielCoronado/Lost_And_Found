<?php
/* Lost & Found: messages (like a chat).
   Two kinds of conversations:
   - 'o:<userId>'      a user and the Lost and Found Office (every admin and staff account shares it)
   - 'd:<idA>:<idB>'   two community users. A user can start one only about a report that links them
                       (a posted report of the other person, or a claim/found notice between them);
                       after that, either one can keep writing.
   POST JSON { action, ... } with header X-LF: 1. */

require __DIR__ . '/lib.php';
api_start();

$me = me();
if (!$me) fail('Your session ended. Log in again.', 401, ['relogin' => true]);
if (!is_admin($me) && $me['status'] !== 'approved') fail('Your account can\'t send messages right now.', 403);
$uid = $me['id'];
$office = is_office($me);
$action = (string) in('action');

// The messages table comes from database-batch3.sql. Say so plainly if it hasn't been imported.
if (!db()->query("SHOW TABLES LIKE 'lf_messages'")->fetchColumn()) {
  fail(is_office($me)
    ? 'Messages aren\'t set up yet. Import database-batch3.sql in phpMyAdmin (Import tab), then reload this page.'
    : 'Messages aren\'t available yet. Please try again later.');
}

function conv_for(string $a, string $b): string { $x = [$a, $b]; sort($x); return 'd:' . $x[0] . ':' . $x[1]; }

// Can I read this conversation?
function can_read(string $conv, string $uid, bool $office): bool {
  if (strpos($conv, 'o:') === 0) return $office || $conv === 'o:' . $uid;
  if (strpos($conv, 'd:') === 0) { $p = explode(':', $conv); return count($p) === 3 && ($p[1] === $uid || $p[2] === $uid); }
  return false;
}

// Name and photo of the other side.
function party(string $conv, string $uid, bool $office): array {
  if (strpos($conv, 'o:') === 0) {
    if (!$office) return ['id' => 'OFFICE', 'name' => 'Lost and Found Office', 'role' => 'office', 'photo' => null];
    $userId = substr($conv, 2);
  } else {
    $p = explode(':', $conv); $userId = $p[1] === $uid ? $p[2] : $p[1];
  }
  $u = user_row($userId);
  if (!$u) return ['id' => $userId, 'name' => 'Deleted account', 'role' => '', 'photo' => null, 'gone' => true];
  $pr = isset($u['data']->profile) && is_object($u['data']->profile) ? $u['data']->profile : new stdClass();
  return ['id' => $userId, 'name' => display_name($u['data']) ?: 'User', 'role' => $u['account_type'],
          'code' => (string)($u['data']->code ?? ''), 'photo' => $pr->photo ?? null, 'status' => $u['status']];
}

function report_by_case(string $caseNo): ?array {
  $s = db()->prepare("SELECT owner_id, review, data FROM lf_rows WHERE coll IN ('lostReports','foundReports') AND case_no = ? LIMIT 1");
  $s->execute([$caseNo]); $r = $s->fetch(); return $r ?: null;
}
function has_request(string $ownerId, string $caseNo): bool {
  $s = db()->prepare("SELECT 1 FROM lf_rows WHERE coll IN ('claimRequests','foundNotices') AND owner_id = ? AND ref_case = ? LIMIT 1");
  $s->execute([$ownerId, $caseNo]); return (bool) $s->fetchColumn();
}

// Why a community user may start a chat with another community user.
function may_start(string $uid, string $to, string $caseNo): bool {
  if ($caseNo === '') return false;
  $r = report_by_case($caseNo);
  if (!$r) return false;
  $public = $r['review'] === null || $r['review'] === '' || $r['review'] === 'posted';
  if ($r['owner_id'] === $to && $public) return true;                 // their posted report
  if ($r['owner_id'] === $to && has_request($uid, $caseNo)) return true;  // I sent a claim/notice on their report
  if ($r['owner_id'] === $uid && has_request($to, $caseNo)) return true;  // they sent one on mine
  return false;
}

function msg_out(array $m, string $uid): array {
  return ['id' => (int)$m['id'], 'from' => $m['sender'], 'mine' => $m['sender'] === $uid, 'text' => $m['body'],
          'caseNo' => $m['case_no'], 'at' => gmdate('Y-m-d\TH:i:s\Z', (int)$m['ts']),
          'read' => $m['read_at'] !== null, 'by' => $m['by'] ?? null];
}

switch ($action) {

  /* ---------- Conversation list ---------- */
  case 'inbox': {
    if ($office) {
      $where = "conv LIKE 'o:%'";
      $args = [];
      $unreadCond = "recipient = 'OFFICE'";
    } else {
      $where = "(conv = ? OR (conv LIKE 'd:%' AND (sender = ? OR recipient = ?)))";
      $args = ['o:' . $uid, $uid, $uid];
      $unreadCond = 'recipient = ?';
    }
    $s = db()->prepare("SELECT conv, MAX(id) AS last_id,
                               SUM(CASE WHEN read_at IS NULL AND sender <> ? AND $unreadCond THEN 1 ELSE 0 END) AS unread
                        FROM lf_messages WHERE $where GROUP BY conv ORDER BY last_id DESC LIMIT 200");
    $s->execute(array_merge([$uid], $office ? [] : [$uid], $args));
    $list = [];
    foreach ($s->fetchAll() as $c) {
      $m = db()->prepare('SELECT *, UNIX_TIMESTAMP(at) AS ts FROM lf_messages WHERE id = ?');
      $m->execute([$c['last_id']]); $last = $m->fetch();
      $list[] = ['conv' => $c['conv'], 'with' => party($c['conv'], $uid, $office), 'unread' => (int)$c['unread'],
                 'last' => msg_out($last, $uid)];
    }
    out(['ok' => true, 'convs' => $list]);
  }

  /* ---------- Unread count (for the top bar badge) ---------- */
  case 'unread':
    out(['ok' => true, 'count' => unread_messages($me)]);

  /* ---------- Open a conversation (also marks it read) ---------- */
  case 'thread': {
    $conv = (string) in('conv');
    $to = (string) in('to');
    if ($conv === '' && $to !== '') {                  // opened from "Message" buttons
      if ($to === 'OFFICE') { if ($office) fail('Open a user\'s conversation from the list.'); $conv = 'o:' . $uid; }
      elseif ($office) $conv = 'o:' . $to;
      else {
        $u = user_row($to);
        if (!$u) fail('This account no longer exists.');
        $conv = in_array($u['account_type'], ['admin', 'staff'], true) ? 'o:' . $uid : conv_for($uid, $to);
      }
    }
    if (!can_read($conv, $uid, $office)) fail('You can\'t open this conversation.', 403);
    $after = (int) in('after', 0);
    $s = db()->prepare("SELECT m.*, UNIX_TIMESTAMP(m.at) AS ts FROM lf_messages m WHERE conv = ? AND id > ? ORDER BY id DESC LIMIT 300");
    $s->execute([$conv, $after]);
    $rows = array_reverse($s->fetchAll());
    // In office threads, show which staff member wrote each office message.
    $names = [];
    foreach ($rows as &$r) {
      if (strpos($conv, 'o:') === 0 && $r['sender'] !== substr($conv, 2)) {
        if (!isset($names[$r['sender']])) { $u = user_row($r['sender']); $names[$r['sender']] = $u ? display_name($u['data']) . ($u['account_type'] === 'admin' ? ' (Admin)' : ' (Staff)') : 'Office'; }
        $r['by'] = $names[$r['sender']];
      }
    }
    unset($r);
    // Mark as read what was sent to me (or to the office, for admin/staff).
    $mine = $office && strpos($conv, 'o:') === 0 ? 'OFFICE' : $uid;
    db()->prepare('UPDATE lf_messages SET read_at = NOW() WHERE conv = ? AND recipient = ? AND read_at IS NULL')->execute([$conv, $mine]);
    $with = party($conv, $uid, $office);
    // May I write here? (new user-to-user chats need a report that links the two people)
    $canWrite = true; $why = '';
    if (!empty($with['gone'])) { $canWrite = false; $why = 'This account was deleted.'; }
    elseif (strpos($conv, 'd:') === 0 && !$rows && $after === 0) {
      $caseNo = (string) in('caseNo');
      if (!may_start($uid, $with['id'], $caseNo)) { $canWrite = false; $why = 'You can message someone about a posted report, or a claim or found notice between you.'; }
    }
    out(['ok' => true, 'conv' => $conv, 'with' => $with, 'canWrite' => $canWrite, 'why' => $why,
         'messages' => array_map(function ($m) use ($uid) { return msg_out($m, $uid); }, $rows)]);
  }

  /* ---------- Send ---------- */
  case 'send': {
    $conv = (string) in('conv');
    $text = trim((string) in('text'));
    $caseNo = trim((string) in('caseNo'));
    if ($text === '') fail('Write a message first.');
    if (text_len($text) > 2000) fail('Messages can be up to 2,000 characters.');
    if (too_many_attempts('msg:' . $uid, 30, 1)) fail('You\'re sending messages too fast. Wait a minute.');
    if (!can_read($conv, $uid, $office)) fail('You can\'t write in this conversation.', 403);

    if (strpos($conv, 'o:') === 0) {
      $userId = substr($conv, 2);
      $to = $office ? $userId : 'OFFICE';
      if ($office && !user_row($userId)) fail('This account no longer exists.');
    } else {
      $p = explode(':', $conv); $to = $p[1] === $uid ? $p[2] : $p[1];
      $u = user_row($to);
      if (!$u) fail('This account no longer exists.');
      $s = db()->prepare('SELECT 1 FROM lf_messages WHERE conv = ? LIMIT 1'); $s->execute([$conv]);
      if (!$s->fetchColumn() && !may_start($uid, $to, $caseNo)) {
        fail('You can message someone about a posted report, or a claim or found notice between you.');
      }
    }
    add_attempt('msg:' . $uid);
    db()->prepare('INSERT INTO lf_messages (conv, sender, recipient, body, case_no) VALUES (?, ?, ?, ?, ?)')
        ->execute([$conv, $uid, $to, $text, $caseNo !== '' ? substr($caseNo, 0, 40) : null]);
    $id = (int) db()->lastInsertId();
    $s = db()->prepare('SELECT *, UNIX_TIMESTAMP(at) AS ts FROM lf_messages WHERE id = ?'); $s->execute([$id]);
    out(['ok' => true, 'message' => msg_out($s->fetch(), $uid)]);
  }
}

fail('Unknown action.', 400);
