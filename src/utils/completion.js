const { MODULES } = require('../constants');

function moduleCompletion(activeModules, totalModules = MODULES.length) {
  const total = Math.max(1, Number(totalModules) || MODULES.length);
  const active = Math.min(total, Math.max(0, Number(activeModules) || 0));
  const completed = Math.round((active / total) * 100);
  return { completed, missing: 100 - completed };
}

module.exports = { moduleCompletion };
