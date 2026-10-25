const chalk = require('chalk');

function info(msg) { console.log(chalk.green('info'), msg); }
function warn(msg) { console.log(chalk.yellow.bold('warn'), msg); }
function error(msg) { console.error(chalk.red('error'), msg); }

module.exports = { info, warn, error };
