const os = require('node:os')

os.userInfo = () => ({
  username: process.env.USERNAME || 'user',
  uid: -1,
  gid: -1,
  shell: null,
  homedir: process.env.USERPROFILE || process.cwd(),
})
