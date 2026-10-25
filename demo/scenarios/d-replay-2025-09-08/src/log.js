import chalk from 'chalk';

export function info(msg) { console.log(chalk.green('info'), msg); }
export function warn(msg) { console.log(chalk.yellow.bold('warn'), msg); }
export function error(msg) { console.error(chalk.red('error'), msg); }
