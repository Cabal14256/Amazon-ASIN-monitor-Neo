const express = require('express');

// 1000 canonical rows with the maximum Unicode field widths fit below 4 MiB.
// Keep the parser bounded before authentication and business normalization.
const JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

function installBodyParsers(app) {
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  app.use(express.urlencoded({ extended: true }));
}

module.exports = { JSON_BODY_LIMIT_BYTES, installBodyParsers };
