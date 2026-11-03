// Préchargé par les tests (NODE_OPTIONS=--require) : fait échouer le déplacement d'un dossier tmp/<mission>/,
// comme un EBUSY/EPERM sous Windows. Code d'erreur choisi par FAIL_RENAME_CODE.
'use strict';
const fs = require('fs');
const path = require('path');
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (path.basename(path.dirname(String(from))) === 'tmp') {
    throw Object.assign(new Error(`${process.env.FAIL_RENAME_CODE}: operation not permitted, rename`), { code: process.env.FAIL_RENAME_CODE });
  }
  return real(from, to);
};
