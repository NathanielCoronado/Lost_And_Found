<?php
// Lost & Found: server settings.
// Copy this file to config.php and fill in your own values. Never commit config.php.
// The .htaccess in this folder blocks it from the web.
return [
  'db_host' => 'localhost',
  'db_name' => 'your_database_name',
  'db_user' => 'your_database_user',
  'db_pass' => 'your_database_password',

  // Email (Gmail app password) and Google sign-in. Leave empty to turn them off.
  'gmail_user'         => '',
  'gmail_app_password' => '',
  'google_client_id'   => '',
];
