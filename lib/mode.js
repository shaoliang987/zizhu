const { readJson, writeJson } = require('./paths');

function envTruthy(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function isLockMode() {
  return envTruthy('LOCK_MODE', false);
}

function isDryRun() {
  if (isLockMode()) return envTruthy('DRY_RUN', true);
  if ('DRY_RUN' in process.env && process.env.DRY_RUN !== '') {
    return envTruthy('DRY_RUN', true);
  }
  const modeCfg = readJson('mode.json', null);
  if (modeCfg && modeCfg.mode) {
    return String(modeCfg.mode).toLowerCase() !== 'live';
  }
  return true;
}

function isLive() {
  return !isDryRun();
}

function ledgerName() {
  return isDryRun() ? 'paper' : 'live';
}

function loadModeConfig() {
  // Live defaults to paused (safer); paper defaults to running.
  const cfg = {
    mode: ledgerName(),
    paused: isLive(),
    updated_at: null,
  };
  const data = readJson('mode.json', null);
  if (!data || typeof data !== 'object') return cfg;
  if (data.paused != null) cfg.paused = Boolean(data.paused);
  if (data.paused_paper != null && isDryRun()) cfg.paused = Boolean(data.paused_paper);
  if (data.paused_live != null && isLive()) cfg.paused = Boolean(data.paused_live);
  cfg.updated_at = data.updated_at || null;
  return cfg;
}

function isBotPaused() {
  return Boolean(loadModeConfig().paused);
}

function setPaused(paused) {
  const cur = readJson('mode.json', {}) || {};
  const next = {
    ...cur,
    mode: ledgerName(),
    paused: Boolean(paused),
    updated_at: new Date().toISOString(),
  };
  if (isDryRun()) next.paused_paper = Boolean(paused);
  else next.paused_live = Boolean(paused);
  writeJson('mode.json', next);
  writeJson('active-mode.json', { dryRun: isDryRun(), instance: process.env.INSTANCE_NAME || ledgerName() });
  return next;
}

module.exports = {
  envTruthy,
  isLockMode,
  isDryRun,
  isLive,
  ledgerName,
  loadModeConfig,
  isBotPaused,
  setPaused,
};
