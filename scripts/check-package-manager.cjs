const required = require('../package.json').packageManager;
const [name, version] = required.split('@');
const agent = (process.env.npm_config_user_agent ?? '').split(' ')[0];
if (agent !== name + '/' + version) {
  console.error('Use ' + required + ' to install this project.');
  process.exitCode = 1;
}
