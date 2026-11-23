# Lost & Found Management System

A web app for reporting, matching, and claiming lost and found items, with admin and staff review, messaging, and notifications.

## Lost & Found Team

| Name | Role |
|---|---|
| Nathaniel Coronado | Repository owner |
| _Add member_ | _Role_ |
| _Add member_ | _Role_ |

> Replace the placeholder rows with your team members and their roles.

## Getting started

1. Copy `private/config.example.php` to `private/config.php` and fill in your database (and optional Gmail / Google) settings. `config.php` is git-ignored: never commit it.
2. Import the SQL files in order in phpMyAdmin (`database.sql`, then each `database-batchN.sql`).
3. Create the admin account with `setup.php`, then delete it.
4. Keep all files in one folder and open `LOGIN.html` (or `index.html`) to start.

## Files

| File | Purpose |
|---|---|
| `lf-app.js` | Shared script (server calls, users, reports, notifications, email, UI). Sections are numbered 1–9 at the top. |
| `api/` | PHP: `lib.php` (shared), `bootstrap.php` (load), `sync.php` (save), `auth.php` (log in, sign up, password) |
| `private/config.php` | Database password and other secrets (blocked from the web, not in this repo: copy from `config.example.php`) |
| `setup.php` | Creates the admin account once; delete it afterwards |
| `database.sql` | Tables to import in phpMyAdmin (don't upload it to htdocs). `database-batch2.sql` adds the reset table to an existing install |
| `lf-style.css` | Shared design for every page |
| `ph-address.js` | Philippine address list (PSA PSGC 2Q 2026): regions, provinces, cities/municipalities, barangays, ZIP codes. Loaded only by pages with an address form; works offline |
| `LOGIN`, `SIGNUP`, `TERMSANDCONDITION`, `APPLICATION`, `FORGOT` | Account pages |
| `HOME`, `REPORT`, `FOUND`, `SEEK`, `MONITOR` | Community pages (Home, Report Lost, Report Found, Matching & Search, My Reports) |
| `STAFFHOME`, `STAFF` | Staff Home and Review Dashboard |
| `ADMIN` | Admin Home (`#home`), Pending Reports (`#reports`), Account Management (`#accounts`) |
| `NOTIFICATIONS`, `ACCOUNT` | Notifications and Account Settings (all roles) |

## Accounts

- **Admin:** created once with `setup.php` (you choose the password there).
- The site starts with **no sample data**: only the admin account exists.
- Sign up needs a **valid ID photo** (profile photo is optional). Every new account waits for admin approval.
- User IDs: `U-001…` for community users, `S-001…` for staff.
- **Declined** users see the admin's comment (if any) and can **Sign up again**. **Blocked** users cannot log in.
- **Deleted** accounts: the admin can add an optional comment when deleting. After the 10-second Retrieve window, the user is
  emailed (needs the Gmail app password; sent while an admin page is open), and when they try to log in with their old email and password they see
  "This account was deleted" with the date, the admin's comment, and a **Sign up again** button. Only a hash of email + password
  is kept for this, so typing just an email reveals nothing. Retrieving the account cancels both. Users who delete their own
  account see "You deleted this account" instead (no email).
- **Signing up again after a deletion:** the account's reports, requests, and history are kept for **90 days** (`ARCHIVE_DAYS` in
  `lf-app.js`). When someone signs up with that email, the Sign up page asks: **Bring back my old reports and history** (they must enter
  the old password) or **Start fresh** (the old data is erased right away). The admin sees "Old account" in the account details, and
  the data comes back when the admin approves the new account (with the new user ID; profile details are restored too).

## Reports

- Case numbers start at `0000000001`. Claim requests: `CR-…`, found notices: `FN-…`.
- Flow: submitted → staff/admin **Approve** → **Post** (visible in Matching & Search) → **Claimed**.
- **Disposal:** posted, unclaimed items show "Day X of 90", counted from the day they were **posted**. At 90 days: Dispose (found) or Close (lost). Change `HOLD_DAYS` in `lf-app.js`.
- **Undo** (status changes) and **Retrieve** (deleted items) last 10 seconds (`UNDO_MS`, `TRASH_MS`).
- After submitting, the user goes straight to **My Reports** with the new report open.
- Reports can have **up to 4 photos** (the first is the main photo). Details windows show thumbnails; tap the photo to see it full size.
- Owners can **Edit report** (details and photo: add, change, or remove) while it is still open, from My Reports
  or the list under Report Lost / Report Found. Admin and staff are notified; a declined report goes back for review.

## Comments on reports

- Every lost/found report has a **Comments** section (My Reports, Matching & Search, Staff and Admin details).
- **Not posted yet** (pending, approved, declined): only the owner, staff, and admin can see and write comments. These stay
  private (marked "Private") even after the report is posted.
- **Posted:** any logged-in user can read and comment (closed once the item is claimed, disposed, or closed).
- **Private comments on posted reports:** staff, admin, and the owner can tick "Private" so only the owner, staff, and admin see it.
- The writer, staff, admin, or the report's owner can delete a comment; it shows as "Comment removed".
- The owner is notified of new comments; people who commented on a post are notified of replies; staff and admin are
  notified of comments on reports that aren't posted yet. The server merges comments, so none are lost when two people post at once.

## "At the office" tag

- Staff and admin can tag a posted report as **Surrendered to the office** (with an optional note). The post shows
  "At the office", and the owner is notified (lost report: come to the office to confirm if it's theirs and claim it;
  found report: thank you, the item was received). The tag can be removed, and it is hidden once the item is claimed/closed.

## Sign up IDs

- Sign up accepts a **Student ID, Government ID, or Other valid ID** (type chosen from a list, stored as `idType`).
  Users can change the type or upload a new photo in Account Settings; the admin sees the type in Account Management.

## Messages (MESSAGES.html, `api/messages.php`, table `lf_messages` from `database-batch3.sql`)

- Chat bubble in the top bar (with unread count). Users can **Message the Lost and Found Office**; every admin and staff
  account shares the office inbox and sees who on the team replied.
- Users can message each other only about something that links them: a posted report of the other person, or a claim
  request / found notice between them ("Message the owner/finder" buttons). After that, both can keep writing.
- Admin and staff can message any user from the report details or the account details.
- **Photos** can be sent in a chat (resized automatically). You can **edit** or **delete** your own messages (tap ⋯);
  deleted ones show "Message deleted" to both sides, and edits show "Edited". Needs `database-batch4.sql`.
- New messages appear within a few seconds while the page is open. Sending is limited to 30 messages a minute.

## Email security

- **Sign up:** a 6-digit code is emailed first (10 minutes, 5 tries); the account is created only with the right code.
- **Changing your email** (Account Settings) needs a code sent to the new email, and the old email gets a notice.
- Only hashes of codes are stored. Without the Gmail app password, these checks are skipped.

## No double posts

- The same report (same item, date, location, and description) can't be submitted twice within 30 minutes, and a user can't
  send a second claim request or found notice for the same item unless the first was rejected. Buttons are also locked while sending.

## Found notices and claim requests

- Owners see each notice/claim in **My Reports** with View details, Comment, Delete, and:
  - lost report: *We met, I got it (Claimed)* or *Claim at the office*
  - found report: *We met, I returned it (Claimed)* or *Verify at the office*
- Senders can add or delete up to 4 proof photos, and **Send again** after a decline.
- Staff/admin can approve or decline (comment optional). Everyone involved sees comments.

## Notifications

- Bell in the top bar shows unread count. `NOTIFICATIONS.html` lists everything.
- Each notification has two icon buttons: **mark as read** and **delete**. Click the text to open it.
- At the top: **Mark all as read** and **Clear notifications** (10 seconds to undo).
- Home pages show the latest 3. Admin and staff share office notifications, each with their own read/cleared state.

## Email, passwords, and Google sign-in (server)

- Emails are sent by the server through Gmail (PHPMailer, in `api/phpmailer/`). Set `gmail_user` and `gmail_app_password`
  in `private/config.php`. The app password comes from Google Account > Security > 2-Step Verification > App passwords.
- **Forgot password:** email > 6-digit code > new password. The code is made, emailed, and checked on the server, expires in
  **1 min 30 sec**, allows 5 tries, and only its hash is saved. The same message shows whether or not the email has an account.
- **Admin reset password:** the server emails a temporary password (expires in 1 min 30 sec, only its hash is saved). The admin
  never sees it. The current password keeps working until the user signs in with the temporary one; then they must choose a new one.
- **Change password** (Account Settings) and every reset send a "password was changed" email.
- **Deleted by the admin:** after the 10-second Retrieve window, the person is emailed (while an admin page is open).
- **Google sign-in:** set `google_client_id` in `private/config.php` (Google Cloud Console > Credentials > OAuth client ID,
  with your site in Authorized JavaScript origins). The button appears only when it is set. Google sign-in logs in an existing
  account with the same email; a new email goes to Sign up with the name and email filled in (a password and valid ID are still needed).
- Change the expiry with `RESET_SECONDS` in `api/lib.php` (and `RESET_MS` in `lf-app.js`).

## Address (profile form)

- Required: Region, Province (not for NCR), City/Municipality, Barangay, **House / Lot / Block no. / Name**, and ZIP. Only **Street** is optional.
  18 regions, 82 provinces, 1,642 cities/municipalities, 42,010 barangays). Search ignores accents ("paranaque", "sto nino").
- **NCR has no province**: the Province box is turned off and cities are listed under the region.
- Highly urbanized cities are listed under their province (e.g. Cebu City under Cebu, Davao City under Davao del Sur).
- **ZIP code** fills in from the city (and from the barangay in Metro Manila). Cities with several ZIP codes show a reminder to check it;
  ZIP sources are PHLPost-based lists, so users can still edit it.
- If `ph-address.js` is missing, the boxes become plain text fields.
- To update the list, replace `ph-address.js` with a newer build.

## Data (server)

- Everything is saved in MySQL through the PHP files in `api/`. Each page loads what the user may see from
  `api/bootstrap.php` and saves changes with `api/sync.php`. Log in, sign up, and password change go through `api/auth.php`.
- The server decides who can see and change what: community users see their own data, posted reports, and requests on their
  reports; staff see everything except valid IDs; the admin sees everything. Passwords are stored with `password_hash()`.
- Database settings are in `private/config.php` (blocked from the web by `private/.htaccess`).
- `setup.php` creates the admin account once. Delete it from the server afterwards.
- Old trash, deleted-account records (after 90 days), and failed log-in records are cleaned up on the first visit each day.
- Batch 2 adds `api/password.php` (Forgot password, admin reset, deletion emails) and the `lf_resets` table (`database-batch2.sql`).
