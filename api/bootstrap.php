<?php
/* Lost & Found: everything the current visitor is allowed to see, loaded once per page.
   Admin: everything. Staff: everything except valid IDs and deleted-account archives.
   Community: their own data, posted reports, and requests on their reports.
   Not logged in: only the site logo (and their own new application while signing up). */

require __DIR__ . '/lib.php';
api_start();
daily_cleanup();

$me = me();
$pdo = db();

$pending = null;
if (!empty($_SESSION['pending']) && ($p = user_row($_SESSION['pending']))) $pending = $p['data'];

// Logged in with an admin's temporary password: must choose a new one first (FORGOT.html?mode=change).
$pwChange = null;
if (!empty($_SESSION['pwchange']) && ($p = user_row($_SESSION['pwchange']))) $pwChange = ['id' => $p['id'], 'name' => display_name($p['data'])];

/* ---------- Users ---------- */
$users = [];
if ($me) {
  $all = $pdo->query('SELECT id, account_type, data FROM lf_users ORDER BY created_at')->fetchAll();
  foreach ($all as $r) {
    $d = dec($r['data']);
    unset($d->password);
    if ($r['id'] === $me['id'] || is_admin($me)) { $users[] = $d; continue; }
    if (role($me) === 'staff') { unset($d->validId, $d->pendingReset); $users[] = $d; continue; }
    // Community: other people's names and photo only.
    $p = isset($d->profile) && is_object($d->profile) ? $d->profile : new stdClass();
    $users[] = [
      'id' => $d->id ?? $r['id'], 'code' => $d->code ?? '', 'firstName' => $d->firstName ?? '', 'lastName' => $d->lastName ?? '',
      'accountType' => $d->accountType ?? $r['account_type'], 'status' => $d->status ?? '',
      'profile' => ['firstName' => $p->firstName ?? ($d->firstName ?? ''), 'lastName' => $p->lastName ?? ($d->lastName ?? ''),
                    'photo' => $p->photo ?? null],
    ];
  }
}

/* ---------- Rows (sent as saved, without decoding) ---------- */
function rows(string $sql, array $args = []): array {
  $s = db()->prepare($sql); $s->execute($args);
  return $s->fetchAll(PDO::FETCH_COLUMN);
}
function in_list(array $vals): array {
  if (!$vals) $vals = ['__none__'];
  return [implode(',', array_fill(0, count($vals), '?')), array_values($vals)];
}

$data = array_fill_keys(ROW_COLLS, []);

if ($me && is_office($me)) {
  foreach (ROW_COLLS as $c) {
    if ($c === 'deletedAccounts' && !is_admin($me)) continue;
    $data[$c] = rows('SELECT data FROM lf_rows WHERE coll = ? ORDER BY seq', [$c]);
  }
} elseif ($me) {
  $uid = $me['id'];
  $myCases = rows("SELECT case_no FROM lf_rows WHERE coll IN ('lostReports','foundReports') AND owner_id = ?", [$uid]);
  $myRefs  = rows("SELECT ref_case FROM lf_rows WHERE coll IN ('claimRequests','foundNotices') AND owner_id = ?", [$uid]);

  [$ph, $vals] = in_list($myRefs);
  foreach (REPORT_COLLS as $c) {
    $st = db()->prepare("SELECT owner_id, data FROM lf_rows WHERE coll = ? AND (owner_id = ? OR review IS NULL OR review = '' OR review = 'posted' OR case_no IN ($ph)) ORDER BY seq");
    $st->execute(array_merge([$c, $uid], $vals));
    foreach ($st->fetchAll() as $r) {
      // Comments written before a report was posted stay between its owner, staff, and the admin.
      if ($r['owner_id'] !== $uid && strpos($r['data'], '"private":true') !== false) {
        $d = dec($r['data']);
        $d->comments = array_values(array_filter((array)($d->comments ?? []), function ($x) { return empty($x->private); }));
        $r['data'] = enc($d);
      }
      $data[$c][] = $r['data'];
    }
  }
  [$ph, $vals] = in_list($myCases);
  foreach (REQUEST_COLLS as $c) {
    $data[$c] = rows("SELECT data FROM lf_rows WHERE coll = ? AND (owner_id = ? OR ref_case IN ($ph)) ORDER BY seq",
                     array_merge([$c, $uid], $vals));
  }
  $data['userNotes'] = rows("SELECT data FROM lf_rows WHERE coll = 'userNotes' AND owner_id = ? ORDER BY seq", [$uid]);
  $data['trash'] = rows("SELECT data FROM lf_rows WHERE coll = 'trash' AND owner_id = ? ORDER BY seq", [$uid]);
}

/* ---------- Output (rows are already JSON, so they are joined as text) ---------- */
$json = '{"ok":true,"meId":' . enc($me ? $me['id'] : null)
      . ',"pending":' . enc($pending)
      . ',"meta":' . enc(['siteLogo' => ($l = meta_get('siteLogo')) !== null ? json_decode($l) : null,
                          'emailReady' => email_ready(),
                          'googleClientId' => trim((string)(config()['google_client_id'] ?? '')),
                          'unreadMessages' => unread_messages($me)])
      . ',"pwChange":' . enc($pwChange)
      . ',"users":' . enc($users)
      . ',"data":{';
$parts = [];
foreach ($data as $c => $list) $parts[] = enc($c) . ':[' . implode(',', $list) . ']';
echo $json . implode(',', $parts) . '}}';
