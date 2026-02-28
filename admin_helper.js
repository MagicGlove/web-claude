#!/usr/bin/env node
'use strict';

const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = path.join(__dirname, 'users.json');

function load() {
  if (!fs.existsSync(USERS_FILE)) return { users: [] };
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function save(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}

const [,, cmd, ...args] = process.argv;

async function main() {
  switch (cmd) {
    case 'add': {
      const [username, password, workDir] = args;
      if (!username || !password) { console.error('用法: add <用户名> <密码> [工作目录]'); process.exit(1); }
      const db = load();
      if (db.users.find(u => u.username === username)) { console.error(`用户 "${username}" 已存在`); process.exit(1); }
      const hash = await bcrypt.hash(password, 10);
      db.users.push({ id: uuidv4(), username, passwordHash: hash, workDir: workDir || process.cwd(), createdAt: new Date().toISOString() });
      save(db);
      console.log(`✓ 用户 "${username}" 添加成功，工作目录：${workDir || process.cwd()}`);
      break;
    }
    case 'remove': {
      const [username] = args;
      if (!username) { console.error('用法: remove <用户名>'); process.exit(1); }
      const db = load();
      const idx = db.users.findIndex(u => u.username === username);
      if (idx === -1) { console.error(`用户 "${username}" 不存在`); process.exit(1); }
      db.users.splice(idx, 1);
      save(db);
      console.log(`✓ 用户 "${username}" 已删除`);
      break;
    }
    case 'passwd': {
      const [username, newPass] = args;
      if (!username || !newPass) { console.error('用法: passwd <用户名> <新密码>'); process.exit(1); }
      const db = load();
      const user = db.users.find(u => u.username === username);
      if (!user) { console.error(`用户 "${username}" 不存在`); process.exit(1); }
      user.passwordHash = await bcrypt.hash(newPass, 10);
      save(db);
      console.log(`✓ 用户 "${username}" 密码已更新`);
      break;
    }
    case 'workdir': {
      const [username, newDir] = args;
      if (!username || !newDir) { console.error('用法: workdir <用户名> <新工作目录>'); process.exit(1); }
      const db = load();
      const user = db.users.find(u => u.username === username);
      if (!user) { console.error(`用户 "${username}" 不存在`); process.exit(1); }
      user.workDir = newDir;
      save(db);
      console.log(`✓ 用户 "${username}" 工作目录已更新为 ${newDir}`);
      break;
    }
    case 'list': {
      const db = load();
      if (!db.users.length) { console.log('暂无用户'); break; }
      console.log('用户列表：');
      console.log('─'.repeat(70));
      db.users.forEach(u => {
        console.log(`  ${u.username.padEnd(20)}  工作目录: ${(u.workDir||'').padEnd(30)}  创建: ${u.createdAt||''}`);
      });
      break;
    }
    default:
      console.log(`Claude Code Web — 用户管理

用法：
  node admin_helper.js add     <用户名> <密码> [工作目录]   添加用户
  node admin_helper.js remove  <用户名>                    删除用户
  node admin_helper.js passwd  <用户名> <新密码>            修改密码
  node admin_helper.js workdir <用户名> <目录>              设置工作目录
  node admin_helper.js list                                查看所有用户`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
