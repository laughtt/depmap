const { program } = require('commander');
const debug = require('debug')('admin');

program.command('reindex').action(() => debug('reindexing'));
program.parse();
