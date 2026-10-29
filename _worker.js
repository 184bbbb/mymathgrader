// 全学科作业 AI 批改助手 · Cloudflare Pages 版代理（_worker.js）
// 作用：
//   1) /v1/chat/completions 由本函数转发到阿里百炼（SSE 流式原样透传）；
//   2) /api/* 为账号体系：注册/登录/云端同步/管理员查看用户，数据存 Cloudflare D1（需绑定数据库，变量名 DB）。
// 密钥放在 Pages 环境变量 DASHSCOPE_API_KEY 里，不会出现在任何前端代码中。

const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen3-vl-plus';

// 部署版本戳：每次重新烘焙打包时由脚本统一改写（前端与本文件同次同值），/api/version 据此让旧页面提示刷新
const BUILD_ID = '202610281000';

// 开发者后台密钥：优先用 Pages 环境变量 DEV_KEY；未配置时用这里的内置值
const BUILTIN_DEV_KEY = 'jwzz-dev-2026-Kq3m9Zx';

// 内置密钥：优先使用 Pages 环境变量 DASHSCOPE_API_KEY；未配置环境变量时自动用这里兜底。
const BUILTIN_KEY = 'sk-ws-H.PYPLILR.RK7y.MEQCICIme5yoq3_spU8iioXWC4aq8f2VtrsXZVpnj018o2xxAiBZgKXohTnpBJq4Kn4cu2-uFX8W8yLaS6PZ4edBYcnEtg';

// 管理员用户名：在 Pages 环境变量 ADMIN_USERNAME 中设置；未设置时默认 admin（用该用户名注册的第一个账号即管理员）
const DEFAULT_ADMIN = 'admin';
// Token 有效期 30 天
const TOKEN_TTL = 30 * 24 * 3600 * 1000;
// D1 单条数据安全上限（约 0.9MB），超过则提示前端改发精简包（去掉原图 dataURL）
const MAX_DATA_CHARS = 900000;

/* 批改原图走 Cloudflare 免费存储：优先 R2（绑定 MEDIA），否则 Workers KV（绑定 MEDIA_KV，免费额度 1GB / 1000 写/天） */
const MEDIA_MAX_BYTES = 6 * 1024 * 1024;
const KV_MEDIA_MAX_BYTES = 1.6 * 1024 * 1024;
const MEDIA_PREFIX = 'm/';

/* 图片读取签名：用 AUTH_SECRET 对对象 key 做 HMAC，链接长期有效，且不暴露登录 token */
async function mediaSig(env, key) {
  const hex = await hmacHex(env.AUTH_SECRET || 'mathgrader-static-fallback', 'media-v1:' + key);
  return hex.slice(0, 32);
}
async function mediaUrlFor(env, key) {
  return '/api/media/' + key + '?s=' + (await mediaSig(env, key));
}
/* 回传教师端时补齐图片地址：兼容只存 key / 存了相对路径但没签名 / 纯 URL 字符串的旧数据 */
async function freshMediaRef(env, ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    if (/^https?:\/\//.test(ref)) return { key: '', url: ref };
    return { key: ref, url: await mediaUrlFor(env, ref.replace(/^\/api\/media\//, '')) };
  }
  const key = String(ref.key || '');
  let url = String(ref.url || '');
  if (url && /\?s=[0-9a-f]{8,}/i.test(url)) return { key, url };
  if (!key) return url ? { key: '', url } : null;
  if (!url) url = await mediaUrlFor(env, key);
  else if (url.startsWith('/api/media/') && !url.includes('?s=')) url = await mediaUrlFor(env, key);
  return { key, url };
}

// 批改准确性硬约束（与本地代理 config.json 保持一致）
const SUFFIX = '【批改准确性硬约束·必须遵守】1) 判定学生思路错误之前，必须先独立完成该题推导并确认标准解答的结论方向；2) 学生结论方向与标准解答一致时，即使过程不完整也不得判反，只能指出缺失的化简或证明步骤；3) 单调性判据：x1小于x2且f(x1)-f(x2)大于0为递减、小于0为递增，不得反向表述；4) 错误点与改进意见必须自洽，不得相互矛盾；5) 不确定某处是否算错时，在该条标题末尾标注建议教师复核，不要直接断言为错误；6) 不得为凑数虚构错误点，学生思路无误时该数组可为空；7) 给学生的文字必须确定、干净，严禁自我怀疑、反复推敲、自问自答的草稿式内容，严禁问号式迟疑或改口表述；8) 每条标题必须与正文结论一致，禁止使用潜在矛盾、可能不一致这类模糊标题；9) 正确做法只写最终规范解法，不写试错过程；10) 必须输出 annotations 数组（彩色定位框）：每条含 category（只能是 正确/亮点、思路无误、关键卡点、错误/缺失 之一）、imageIndex（从0开始，单图固定为0）、anchor（框内文字开头6~12字原文摘录，先在图中找到该文字再定坐标，不得虚构）、rect（相对图片的归一化小数0.0~1.0，x/y为左上角、w/h为宽高，禁止像素值或百分数）、label（不超过12字的结论式短批语，直接下判断）、detail（不超过20字，只写最关键的一个为什么/怎么办）；11) 每个框只覆盖一处内容、最多一两行，h取0.025~0.07，w一般不超过0.6，宁可略小不要过大，各框y值错开；通常3~6条即可，对错都要标，亮点也要标，不要为凑数多标；12) 所有数学式必须用LaTeX书写：行内 $...$、独立行 $$...$$，花括号成对，禁止裸露的幂/下标记号；分数必须写成横式分式 \\frac{分子}{分母}（如二分之一写 \\frac{1}{2}），严禁 1/2、a/b 这类斜杠分数；13) 必须输出 scoreParts（分问得分）：每小问一条，含 part 与 note（得分加一句话原因），合计必须等于 summary.score；14) 篇幅从严控制（直接影响批改速度）：必须输出 stepComparison 逐步骤对照表，只列3~8个关键步骤，student与standard各不超过20字、摘录关键式即可，note不超过20字、写清本步得失分（如：+3分 求导正确、-1分 漏定义域；无步骤得失分写—）；thinkingErrors 不写 why（根本原因）字段，notationIssues 不写 rule（依据）字段；其余文字一针见血，每条字段一两句话，能短则短，不重复题干、不写套话，只输出要求的字段。';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-requested-with, accept, origin',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
  });
}

/* ---------------- 密码与 Token（Web Crypto） ---------------- */
/* 详细批改（task=grade）不产出定位框，去掉第 10、11 条关于 annotations 的约束 */
const SUFFIX_NO_ANNO = SUFFIX.replace(/10\) 必须输出 annotations[\s\S]*?各框y值错开；/, '');

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64url(input) {
  let s;
  if (typeof input === 'string') s = btoa(unescape(encodeURIComponent(input)));
  else s = btoa(String.fromCharCode(...new Uint8Array(input)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function makeToken(env, userId) {
  const exp = Date.now() + TOKEN_TTL;
  const payload = b64url(userId) + '.' + exp;
  const sig = await hmacHex(env.AUTH_SECRET || 'mathgrader-static-fallback', payload);
  return payload + '.' + sig;
}
async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [buid, expStr, sig] = parts;
  const payload = buid + '.' + expStr;
  const expect = await hmacHex(env.AUTH_SECRET || 'mathgrader-static-fallback', payload);
  // 长度一致 + 逐字节比较
  if (expect.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const exp = Number(expStr);
  if (!isFinite(exp) || exp < Date.now()) return null;
  try {
    return { userId: b64urlDecode(buid), exp };
  } catch (e) {
    return null;
  }
}
function getToken(request) {
  const h = request.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}
async function ensureTables(env) {
  if (!env.DB) throw new Error('NO_D1');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS userdata (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    /* ---- 题库：一题一行（P1） ---- */
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      scope TEXT NOT NULL DEFAULT 'private',
      subject TEXT NOT NULL,
      stem TEXT NOT NULL,
      stem_norm TEXT,
      fingerprint TEXT,
      answer TEXT,
      solution TEXT,
      points TEXT,
      tags TEXT,
      review TEXT,
      extra TEXT,
      full_score REAL DEFAULT 0,
      difficulty INTEGER DEFAULT 3,
      source TEXT,
      quality INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS question_revisions (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      editor TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS question_stats (
      question_id TEXT PRIMARY KEY,
      hit_count INTEGER NOT NULL DEFAULT 0,
      miss_count INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      avg_score REAL,
      common_errors TEXT,
      last_hit_at INTEGER,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_migrations (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_q_owner ON questions(owner_id, subject, updated_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_q_scope ON questions(scope, subject, updated_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_q_fp ON questions(fingerprint)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_q_norm ON questions(owner_id, stem_norm)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_q_stats ON question_stats(last_hit_at)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_q_rev ON question_revisions(question_id, rev)'),
  ]);
  /* ---- 角色与师生关系（P5）：老库按需补列，已存在则跳过 ---- */
  await ensureColumns(env, 'users', [
    ['role', "TEXT NOT NULL DEFAULT 'teacher'"],
    ['teacher_id', 'TEXT'],
    ['display_name', 'TEXT'],
    ['class_name', 'TEXT'],
    ['class_id', 'TEXT'],
    ['nickname', 'TEXT'],
  ]);
  /* 题目关联的原图（R2 地址 JSON 数组），题库与批改记录都能回看 */
  await ensureColumns(env, 'questions', [['images', 'TEXT']]);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    grade TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id, created_at)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    class_name TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_invites_teacher ON invites(teacher_id, created_at)').run();
}

/* 给已有表补列（D1 不支持 IF NOT EXISTS 的 ADD COLUMN） */
async function ensureColumns(env, table, cols) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const has = new Set((info.results || []).map((r) => r.name));
  for (const [name, type] of cols) {
    if (has.has(name)) continue;
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
  }
}

/* 邀请码：去掉容易看错的 0/O/1/I/L */
function inviteCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += abc[buf[i] % abc.length];
  return out;
}

/* ---------------- 题库：规范化 / 指纹 / 相似度 ---------------- */
/* 去空白与常见标点，小写化；与前端 bankNormText 同思路，用于同题精确判重 */
function qNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：？！“”‘’（）【】《》,.;:?!"'()\[\]<>·\-—_~`|\\/@#$%^&*+=]/g, '')
    .slice(0, 600);
}
/* 题目常量（数字）集合：同一道题两次识别时最稳定的判别特征 */
function qConstants(s) {
  const nums = String(s || '').match(/\d+(?:\.\d+)?/g) || [];
  return [...new Set(nums)].sort().join(',');
}
function qFingerprint(subject, stem) {
  return String(subject || 'math') + '|' + qConstants(stem).slice(0, 200) + '|' + qNorm(stem).length;
}
function bigramSet(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function qSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigramSet(a);
  const B = bigramSet(b);
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  const total = A.size + B.size;
  return total ? (2 * inter) / total : 0;
}
function rowToProblem(r) {
  let review = null;
  try { review = r.review ? JSON.parse(r.review) : null; } catch (e) { review = null; }
  let images = [];
  try { images = r.images ? JSON.parse(r.images) : []; } catch (e) { images = []; }
  return {
    id: r.id,
    subject: r.subject,
    stem: r.stem,
    full: r.full_score,
    tags: r.tags || '',
    sol: r.solution || '',
    points: r.points || '',
    extra: r.extra || '',
    answer: r.answer || '',
    review: review || undefined,
    difficulty: r.difficulty,
    source: r.source || 'photo-solve',
    quality: r.quality || 0,
    images: Array.isArray(images) ? images : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
async function migrateProblemsToQBank(env, userId, data) {
  if (!data || !Array.isArray(data.problems) || !data.problems.length) return data;
  const mark = await env.DB.prepare('SELECT status FROM user_migrations WHERE user_id = ? AND key = ?')
    .bind(userId, 'problems_v1').first();
  if (mark && mark.status === 'done') {
    data.problems = [];
    return data;
  }
  await env.DB.prepare(
    `INSERT INTO user_migrations (user_id, key, status, detail, updated_at) VALUES (?, ?, 'running', '', ?)
     ON CONFLICT(user_id, key) DO UPDATE SET status = 'running', updated_at = excluded.updated_at`
  ).bind(userId, 'problems_v1', Date.now()).run();
  try {
    const list = data.problems;
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      const stmts = chunk.map((p) => {
        const now = Date.now();
        return env.DB.prepare(
          `INSERT INTO questions (id, owner_id, scope, subject, stem, stem_norm, fingerprint, answer, solution, points, tags, review, extra, full_score, difficulty, source, quality, rev, deleted, created_at, updated_at)
           VALUES (?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        ).bind(
          String(p.id || randomHex(12)), userId,
          String(p.subject || 'math'), String(p.stem || ''),
          qNorm(p.stem), qFingerprint(p.subject, p.stem),
          String(p.answer || ''), String(p.sol || ''), String(p.points || ''),
          Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags || ''),
          p.review ? JSON.stringify(p.review) : null,
          String(p.extra || ''), Number(p.full) || 0, Number(p.difficulty) || 3,
          String(p.source || 'legacy'),
          Number(p.createdAt) || now, Number(p.updatedAt) || now
        );
      });
      if (stmts.length) await env.DB.batch(stmts);
    }
    await env.DB.prepare(
      `UPDATE user_migrations SET status = 'done', updated_at = ? WHERE user_id = ? AND key = ?`
    ).bind(Date.now(), userId, 'problems_v1').run();
    data.problems = [];
    return data;
  } catch (e) {
    await env.DB.prepare(
      `UPDATE user_migrations SET status = 'failed', detail = ?, updated_at = ? WHERE user_id = ? AND key = ?`
    ).bind(String(e && e.message || e).slice(0, 200), Date.now(), userId, 'problems_v1').run();
    return data; // 迁移失败时保留旧包内容，不丢数据
  }
}

/* 教师端名单用的轻量汇总：批改次数、平均得分率、最近活跃、学科分布、高频错误标签 */
function summarizeRecords(records, updatedAt) {
  const list = Array.isArray(records) ? records : [];
  const subjectOf = (r) => String(r.subject || (r.problem && r.problem.subject) || 'math');
  const scored = list.filter((r) => r.result && r.result.summary && typeof r.result.summary.score === 'number');
  const avgRate = scored.length
    ? scored.reduce((a, r) => a + r.result.summary.score / (r.result.summary.fullScore || 1), 0) / scored.length
    : 0;
  const tags = new Map();
  list.forEach((r) => ((r.result && r.result.errorTags) || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1)));
  const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, count]) => ({ tag, count }));
  const bySubject = {};
  list.forEach((r) => { const s = subjectOf(r); bySubject[s] = (bySubject[s] || 0) + 1; });
  const lastAt = list.reduce((a, r) => Math.max(a, Number(r.createdAt) || 0), 0);
  return {
    recordCount: list.length,
    avgRate: Math.round(avgRate * 1000) / 1000,
    topTags,
    bySubject,
    lastAt,
    updatedAt: Number(updatedAt) || 0,
  };
}

/* 批量读取若干学生的 userdata 并算汇总（D1 单语句绑定参数上限 100，按 90 分片） */
async function loadStats(env, ids) {
  const out = {};
  const list = Array.isArray(ids) ? ids : [];
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT user_id, data, updated_at FROM userdata WHERE user_id IN (${marks})`
    ).bind(...chunk).all();
    (rows.results || []).forEach((row) => {
      let data = null;
      try { data = JSON.parse(row.data); } catch (e) { data = null; }
      out[row.user_id] = summarizeRecords(data && data.records, row.updated_at);
    });
  }
  return out;
}

/* 批量建号用的初始密码：6 位，去掉容易看错的字符 */
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += abc[buf[i] % abc.length];
  return out;
}

/* ---------------- 账号 / 同步路由 ---------------- */
async function apiRoute(request, env, pathname) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  await ensureTables(env);
  const adminName = (env.ADMIN_USERNAME || DEFAULT_ADMIN).trim();

  /* 注册 */
  if (pathname === '/api/register' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,30}$/.test(username)) {
      return json({ error: { message: '账号需为 2~30 位中英文、数字或下划线' } }, 400);
    }
    if (password.length < 6) return json({ error: { message: '密码至少 6 位' } }, 400);
    const exist = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exist) return json({ error: { message: '该账号已被注册，请直接登录或换一个账号' } }, 409);
    const id = randomHex(16);
    const salt = randomHex(16);
    const hash = await sha256Hex(salt + password);
    const isAdmin = username === adminName ? 1 : 0;
    await env.DB.prepare(
      'INSERT INTO users (id, username, salt, hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, username, salt, hash, isAdmin, Date.now()).run();
    const token = await makeToken(env, id);
    return json({ token, user: { id, username, nickname: '', isAdmin: !!isAdmin, role: 'teacher' }, created: true });
  }

  /* 学生自助注册：班级固定邀请码（直接归属班级）或老师单独发的邀请码 */
  if (pathname === '/api/register/student' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const code = String((body && body.code) || '').trim().toUpperCase();
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    const nameIn = String((body && body.name) || '').trim();
    if (!code) return json({ error: { message: '请填写老师给的邀请码' } }, 400);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,30}$/.test(username)) {
      return json({ error: { message: '账号需为 2~30 位中英文、数字或下划线' } }, 400);
    }
    if (password.length < 6) return json({ error: { message: '密码至少 6 位' } }, 400);
    if (nameIn.length > 30) return json({ error: { message: '姓名过长' } }, 400);
    const exist = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exist) return json({ error: { message: '该账号已被注册，请换一个账号' } }, 409);
    const now = Date.now();
    const id = randomHex(16);
    const salt = randomHex(16);
    const hash = await sha256Hex(salt + password);

    /* 情况一：班级固定邀请码 —— 一码可用多次，每个学生都归到同一个班 */
    const cls = await env.DB.prepare('SELECT * FROM classes WHERE code = ?').bind(code).first();
    if (cls) {
      if (!nameIn) return json({ error: { message: '请填写你的姓名，老师按姓名核对名单' } }, 400);
      const className = [cls.grade, cls.name].filter(Boolean).join(' ');
      try {
        await env.DB.prepare(
          `INSERT INTO users (id, username, salt, hash, is_admin, created_at, role, teacher_id, display_name, class_id, class_name)
           VALUES (?, ?, ?, ?, 0, ?, 'student', ?, ?, ?, ?)`
        ).bind(id, username, salt, hash, now, cls.teacher_id, nameIn, cls.id, className).run();
      } catch (e) {
        return json({ error: { message: '注册失败，请重试' } }, 500);
      }
      const token = await makeToken(env, id);
      return json({
        token,
        user: {
          id, username, nickname: '', isAdmin: false, role: 'student',
          displayName: nameIn, teacherId: cls.teacher_id, classId: cls.id, className,
        },
        created: true,
      });
    }

    /* 情况二：老师单独发的邀请码 —— 姓名与班级由码绑定，一码只能用一次 */
    const inv = await env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
    if (!inv) return json({ error: { message: '邀请码不存在，请向老师确认' } }, 404);
    if (inv.used_by) return json({ error: { message: '该邀请码已被使用，请向老师索取新的' } }, 409);
    /* 先抢码再建号：并发下只有一个请求能把 used_by 从 NULL 改掉 */
    const claimed = await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .bind(id, now, code).run();
    if (!claimed || !claimed.meta || claimed.meta.changes !== 1) {
      return json({ error: { message: '该邀请码刚刚被使用，请向老师索取新的' } }, 409);
    }
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, username, salt, hash, is_admin, created_at, role, teacher_id, display_name, class_name)
         VALUES (?, ?, ?, ?, 0, ?, 'student', ?, ?, ?)`
      ).bind(id, username, salt, hash, now, inv.teacher_id, inv.student_name, inv.class_name || '').run();
    } catch (e) {
      await env.DB.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?').bind(code).run();
      return json({ error: { message: '注册失败，请重试' } }, 500);
    }
    const token = await makeToken(env, id);
    return json({
      token,
      user: {
        id, username, nickname: '', isAdmin: false, role: 'student',
        displayName: inv.student_name, teacherId: inv.teacher_id, className: inv.class_name || '',
      },
      created: true,
    });
  }

  /* 登录 */
  if (pathname === '/api/login' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!row) return json({ error: { message: '账号不存在，请先注册' } }, 404);
    const hash = await sha256Hex(row.salt + password);
    if (hash !== row.hash) return json({ error: { message: '密码不正确' } }, 401);
    // 管理员策略变更（环境变量改名）时按当前 ADMIN_USERNAME 重新判定
    const isAdmin = username === adminName ? 1 : 0;
    if (!!row.is_admin !== !!isAdmin) {
      await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(isAdmin, row.id).run();
    }
    const token = await makeToken(env, row.id);
    return json({
      token,
      user: {
        id: row.id, username: row.username, nickname: row.nickname || '', isAdmin: !!isAdmin,
        role: row.role === 'student' ? 'student' : 'teacher',
        displayName: row.display_name || '', teacherId: row.teacher_id || '',
        className: row.class_name || '', classId: row.class_id || '',
      },
    });
  }

  /* 以下路由均需登录 */
  const auth = await verifyToken(env, getToken(request));
  if (!auth) return json({ error: { message: '未登录或登录已过期，请重新登录' } }, 401);
  const me = await env.DB.prepare('SELECT id, username, nickname, is_admin, role, teacher_id, display_name, class_id, class_name, created_at FROM users WHERE id = ?').bind(auth.userId).first();
  if (!me) return json({ error: { message: '账号不存在' } }, 401);
  const userOut = {
    id: me.id, username: me.username, nickname: me.nickname || '', isAdmin: !!me.is_admin,
    role: me.role === 'student' ? 'student' : 'teacher',
    displayName: me.display_name || '', teacherId: me.teacher_id || '',
    className: me.class_name || '', classId: me.class_id || '', createdAt: me.created_at,
  };
  const isStudent = userOut.role === 'student';

  if (pathname === '/api/me' && request.method === 'GET') {
    return json({ user: userOut });
  }

  /* 批改原图上传：优先 R2（若已绑定），否则存入免费的 Workers KV（绑定变量名 MEDIA_KV，无需开通付费）
     按内容哈希命名自动去重，返回带签名的长期可读地址，浏览器 <img> 可直接引用 */
  if (pathname === '/api/media/upload' && request.method === 'POST') {
    if (!env.MEDIA && !env.MEDIA_KV) {
      return json({ error: { message: '服务器未配置图片存储：请在 Pages → Settings → Bindings 添加 KV namespace 绑定，变量名填 MEDIA_KV（免费，无需绑卡），保存后 Retry deployment', code: 'NO_MEDIA' } }, 503);
    }
    const body = await request.json().catch(() => null);
    const dataUrl = String((body && body.data) || '');
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!m) return json({ error: { message: '图片格式不正确（需要 dataURL）' } }, 400);
    const b64 = m[2].replace(/\s/g, '');
    let bytes;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      return json({ error: { message: '图片解码失败' } }, 400);
    }
    if (!env.MEDIA && bytes.length > KV_MEDIA_MAX_BYTES) {
      return json({ error: { message: '图片过大：KV 存储单张上限 ' + Math.round(KV_MEDIA_MAX_BYTES / 1024) + 'KB，请压缩后重试' } }, 413);
    }
    if (bytes.length > MEDIA_MAX_BYTES) {
      return json({ error: { message: '图片超过 6MB，请压缩后重试' } }, 413);
    }
    const mime = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const hash = (await sha256Hex(b64)).slice(0, 40);
    let key;
    if (env.MEDIA) {
      key = 'm/' + auth.userId + '/' + hash + ext;
      await env.MEDIA.put(key, bytes, {
        httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
      });
    } else {
      key = 'k/' + auth.userId + '/' + hash + ext;
      await env.MEDIA_KV.put(key, b64, {
        metadata: { mime, bytes: bytes.length },
      });
    }
    return json({ key, url: await mediaUrlFor(env, key), size: bytes.length, storage: env.MEDIA ? 'r2' : 'kv' });
  }

  /* 修改账号 / 密码：需当前密码确认，改完 token 继续有效 */
  if (pathname === '/api/account/update' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const currentPassword = String((body && body.currentPassword) || '');
    const newUsername = String((body && body.username) || '').trim();
    const newPassword = String((body && body.newPassword) || '');
    if (!currentPassword) return json({ error: { message: '请输入当前密码以确认修改' } }, 400);
    if (!newUsername && !newPassword) return json({ error: { message: '没有要修改的内容' } }, 400);
    const row = await env.DB.prepare('SELECT id, username, salt, hash FROM users WHERE id = ?').bind(me.id).first();
    if (!row) return json({ error: { message: '账号不存在' } }, 404);
    const curHash = await sha256Hex(row.salt + currentPassword);
    if (curHash !== row.hash) return json({ error: { message: '当前密码不正确' } }, 403);
    if (newUsername) {
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,30}$/.test(newUsername)) {
        return json({ error: { message: '账号需为 2~30 位中英文、数字或下划线' } }, 400);
      }
      const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(newUsername, row.id).first();
      if (dup) return json({ error: { message: '该账号已被占用，请换一个' } }, 409);
    }
    if (newPassword && newPassword.length < 6) {
      return json({ error: { message: '新密码至少 6 位' } }, 400);
    }
    let salt = row.salt, hash = row.hash;
    if (newPassword) {
      salt = randomHex(16);
      hash = await sha256Hex(salt + newPassword);
    }
    const finalName = newUsername || row.username;
    await env.DB.prepare('UPDATE users SET username = ?, salt = ?, hash = ? WHERE id = ?')
      .bind(finalName, salt, hash, row.id).run();
    return json({ ok: true, user: { id: row.id, username: finalName } });
  }

  /* 个性化用户名（昵称）：随意修改，不需要密码，也不影响登录用的账号 */
  if (pathname === '/api/account/profile' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const nickname = String((body && body.nickname) || '').trim();
    if (nickname.length > 20) return json({ error: { message: '用户名最多 20 个字符' } }, 400);
    if (/[\u0000-\u001f]/.test(nickname)) return json({ error: { message: '用户名含不可见字符' } }, 400);
    await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, me.id).run();
    return json({ ok: true, user: { id: me.id, username: me.username, nickname } });
  }

  /* ---- 教师端（P5）：发邀请码 / 学生账号列表 / 学生学情画像 ---- */
  if (pathname.startsWith('/api/teacher/')) {
    if (isStudent) return json({ error: { message: '学生账号无此权限' } }, 403);

    /* 生成邀请码：老师先填学生姓名（可选班级），再把码发给学生自助注册 */
    if (pathname === '/api/teacher/invite' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const studentName = String((body && body.studentName) || '').trim();
      const className = String((body && body.className) || '').trim();
      if (!studentName) return json({ error: { message: '请填写学生姓名' } }, 400);
      if (studentName.length > 30) return json({ error: { message: '学生姓名过长' } }, 400);
      const code = inviteCode();
      await env.DB.prepare(
        'INSERT INTO invites (code, teacher_id, student_name, class_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(code, me.id, studentName, className, '', Date.now()).run();
      return json({ code, studentName, className });
    }

    /* 最近发出的邀请码及使用状态 */
    if (pathname === '/api/teacher/invites' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT code, student_name, class_name, created_at, used_by, used_at FROM invites WHERE teacher_id = ? ORDER BY created_at DESC LIMIT 50'
      ).bind(me.id).all();
      return json({
        invites: (rows.results || []).map((r) => ({
          code: r.code, studentName: r.student_name, className: r.class_name || '',
          createdAt: r.created_at, used: !!r.used_by, usedAt: r.used_at || 0,
        })),
      });
    }

    /* 我名下已注册的学生账号 + 汇总（不含明细，列表页够用） */
    if (pathname === '/api/teacher/students' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT id, username, display_name, class_name, class_id, created_at FROM users
         WHERE teacher_id = ? AND role = 'student' ORDER BY created_at DESC LIMIT 100`
      ).bind(me.id).all();
      const users = rows.results || [];
      const stats = {};
      if (users.length) {
        const ids = users.map((u) => u.id);
        const marks = ids.map(() => '?').join(',');
        const dataRows = await env.DB.prepare(
          `SELECT user_id, data, updated_at FROM userdata WHERE user_id IN (${marks})`
        ).bind(...ids).all();
        (dataRows.results || []).forEach((row) => {
          let data = null;
          try { data = JSON.parse(row.data); } catch (e) { data = null; }
          stats[row.user_id] = summarizeRecords(data && data.records, row.updated_at);
        });
      }
      return json({
        students: users.map((u) => Object.assign({
          id: u.id, username: u.username,
          displayName: u.display_name || u.username,
          className: u.class_name || '', classId: u.class_id || '', createdAt: u.created_at,
        }, stats[u.id] || summarizeRecords([], 0))),
      });
    }

    /* 教师代批：把一次批改记录写进所选学生账号，作业与学生对上后，
       学生画像与班级学情都能看到这次批改 */
    if (pathname === '/api/teacher/record' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const studentId = String((body && body.studentId) || '').trim();
      const rec = body && body.record;
      if (!studentId || !rec || typeof rec !== 'object' || !rec.id) {
        return json({ error: { message: '参数不完整' } }, 400);
      }
      const stu = await env.DB.prepare(
        `SELECT id FROM users WHERE id = ? AND teacher_id = ? AND role = 'student'`
      ).bind(studentId, me.id).first();
      if (!stu) return json({ error: { message: '该学生不属于你，或账号不存在' } }, 404);
      const row = await env.DB.prepare('SELECT data FROM userdata WHERE user_id = ?').bind(studentId).first();
      let data = null;
      try { data = row ? JSON.parse(row.data) : null; } catch (_) { data = null; }
      if (!data || typeof data !== 'object') data = {};
      const records = Array.isArray(data.records) ? data.records : [];
      if (!records.some((r) => r && r.id === rec.id)) {
        const slim = Object.assign({}, rec);
        delete slim.images;                 // 学生画像不需要原图
        records.unshift(slim);
      }
      let text = '';
      let keep = 300;
      do {
        data.records = records.slice(0, keep);
        text = JSON.stringify(data);
        keep = keep > 50 ? Math.floor(keep / 3) : 0;
      } while (text.length > MAX_DATA_CHARS && keep > 0);
      if (text.length > MAX_DATA_CHARS) {
        return json({ error: { message: '该学生云端数据过大，请稍后重试' } }, 413);
      }
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO userdata (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).bind(studentId, text, now).run();
      return json({ ok: true });
    }

    /* 单个学生的明细（供教师端渲染完整学情画像） */
    if (pathname === '/api/teacher/student/profile' && request.method === 'GET') {
      const targetId = String(new URL(request.url).searchParams.get('id') || '').trim();
      if (!targetId) return json({ error: { message: '缺少学生账号' } }, 400);
      const stu = await env.DB.prepare(
        `SELECT id, username, display_name, class_name, created_at FROM users
         WHERE id = ? AND teacher_id = ? AND role = 'student'`
      ).bind(targetId, me.id).first();
      if (!stu) return json({ error: { message: '该学生不属于你，或账号不存在' } }, 404);
      const row = await env.DB.prepare('SELECT data, updated_at FROM userdata WHERE user_id = ?').bind(targetId).first();
      let data = null;
      try { data = row ? JSON.parse(row.data) : null; } catch (e) { data = null; }
      const records = [];
      for (const r of ((data && data.records) || [])) {
        if (!r || typeof r !== 'object') continue;
        const copy = Object.assign({}, r);
        delete copy.images;            // 原图 dataURL 体积大，教师端用签名地址看
        const refs = Array.isArray(copy.imageRefs) ? copy.imageRefs : [];
        copy.imageRefs = [];
        for (const ref of refs.slice(0, 4)) {
          const fresh = await freshMediaRef(env, ref);
          if (fresh && (fresh.url || fresh.key)) copy.imageRefs.push(fresh);
        }
        records.push(copy);
      }
      records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const recent = records.slice(0, 500);
      /* 题目题干从学生自己的题库补，最多取 99 道（D1 单条语句绑定参数上限 100） */
      const pids = [...new Set(records.map((r) => r.problemId).filter(Boolean))].slice(0, 99);
      let problems = [];
      if (pids.length) {
        const marks = pids.map(() => '?').join(',');
        const q = await env.DB.prepare(
          `SELECT id, subject, stem, full_score, images FROM questions WHERE owner_id = ? AND deleted = 0 AND id IN (${marks})`
        ).bind(targetId, ...pids).all();
        problems = (q.results || []).map((p) => {
          let images = [];
          try { images = p.images ? JSON.parse(p.images) : []; } catch (e) { images = []; }
          return {
            id: p.id, subject: p.subject, stem: p.stem, full: p.full_score,
            images: Array.isArray(images) ? images : [],
          };
        });
      }
      return json({
        student: {
          id: stu.id, username: stu.username,
          displayName: stu.display_name || stu.username,
          className: stu.class_name || '', createdAt: stu.created_at,
        },
        records: recent, problems, updatedAt: (row && row.updated_at) || 0,
      });
    }

    /* ---- 班级（P6）：固定邀请码、批量建号、班级学情汇总 ---- */
    if (pathname === '/api/teacher/class/create' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const grade = String((body && body.grade) || '').trim();
      const name = String((body && body.name) || '').trim();
      if (!grade || !name) return json({ error: { message: '请填写年段与班级名' } }, 400);
      if (grade.length > 20 || name.length > 20) return json({ error: { message: '年段或班级名过长' } }, 400);
      let code = '';
      for (let i = 0; i < 6 && !code; i++) {
        const c = inviteCode();
        const dup = await env.DB.prepare('SELECT id FROM classes WHERE code = ?').bind(c).first();
        if (!dup) code = c;
      }
      if (!code) return json({ error: { message: '邀请码生成失败，请重试' } }, 500);
      const id = randomHex(12);
      await env.DB.prepare('INSERT INTO classes (id, teacher_id, grade, name, code, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, me.id, grade, name, code, Date.now()).run();
      return json({ class: { id, grade, name, code, studentCount: 0 } });
    }

    if (pathname === '/api/teacher/classes' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT c.id, c.grade, c.name, c.code, c.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS n
         FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC LIMIT 60`
      ).bind(me.id).all();
      return json({
        classes: (rows.results || []).map((c) => ({
          id: c.id, grade: c.grade, name: c.name, code: c.code,
          studentCount: c.n || 0, createdAt: c.created_at,
        })),
      });
    }

    /* 班级学情：学生逐人汇总 + 班级平均、活跃度、分数分布、薄弱知识点 */
    if (pathname === '/api/teacher/class/detail' && request.method === 'GET') {
      const classId = String(new URL(request.url).searchParams.get('id') || '').trim();
      const cls = await env.DB.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').bind(classId, me.id).first();
      if (!cls) return json({ error: { message: '班级不存在' } }, 404);
      const rows = await env.DB.prepare(
        `SELECT id, username, display_name, created_at FROM users
         WHERE class_id = ? AND role = 'student' ORDER BY display_name, created_at`
      ).bind(classId).all();
      const students = rows.results || [];
      const stats = await loadStats(env, students.map((s) => s.id));
      const now = Date.now();
      const buckets = [0, 0, 0, 0];   // <60% / 60~80% / 80~90% / ≥90%
      let totalRecords = 0, sumRate = 0, scoredCount = 0, active7 = 0;
      const tagMap = new Map();
      const out = students.map((s) => {
        const st = stats[s.id] || summarizeRecords([], 0);
        totalRecords += st.recordCount;
        if (st.recordCount) { sumRate += st.avgRate; scoredCount++; }
        if (st.lastAt && now - st.lastAt < 7 * 864e5) active7++;
        st.topTags.forEach((t) => tagMap.set(t.tag, (tagMap.get(t.tag) || 0) + t.count));
        if (st.recordCount) {
          const r = st.avgRate;
          buckets[r >= 0.9 ? 3 : r >= 0.8 ? 2 : r >= 0.6 ? 1 : 0]++;
        }
        return {
          id: s.id, username: s.username, displayName: s.display_name || s.username,
          recordCount: st.recordCount, avgRate: st.avgRate, lastAt: st.lastAt, topTags: st.topTags,
        };
      });
      const weakTags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([tag, count]) => ({ tag, count }));
      return json({
        class: {
          id: cls.id, grade: cls.grade, name: cls.name, code: cls.code,
          createdAt: cls.created_at, studentCount: students.length,
        },
        summary: {
          studentCount: students.length,
          totalRecords,
          avgRate: scoredCount ? Math.round((sumRate / scoredCount) * 1000) / 1000 : 0,
          scoredCount, active7, buckets, weakTags,
        },
        students: out,
      });
    }

    /* 班级整体画像：聚合全班学生的云端批改记录（只回传画像需要的字段，不含图片） */
    if (pathname === '/api/teacher/class/profile' && request.method === 'GET') {
      const classId = String(new URL(request.url).searchParams.get('id') || '').trim();
      const cls = await env.DB.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').bind(classId, me.id).first();
      if (!cls) return json({ error: { message: '班级不存在' } }, 404);
      const rows = await env.DB.prepare(
        `SELECT id, username, display_name FROM users
         WHERE class_id = ? AND role = 'student' ORDER BY display_name, created_at LIMIT 300`
      ).bind(classId).all();
      const students = rows.results || [];
      const records = [];
      for (let i = 0; i < students.length; i += 60) {
        const chunk = students.slice(i, i + 60);
        const byId = new Map(chunk.map((s) => [s.id, s]));
        const marks = chunk.map(() => '?').join(',');
        const data = await env.DB.prepare(`SELECT user_id, data FROM userdata WHERE user_id IN (${marks})`)
          .bind(...chunk.map((s) => s.id)).all();
        (data.results || []).forEach((row) => {
          const stu = byId.get(row.user_id);
          if (!stu) return;
          let d = null;
          try { d = JSON.parse(row.data); } catch (_) { d = null; }
          const list = (d && Array.isArray(d.records)) ? d.records : [];
          list.slice(0, 300).forEach((r) => {
            if (!r || !r.id) return;
            const rr = r.result || {};
            const su = rr.summary || {};
            records.push({
              id: r.id,
              studentId: stu.id,
              studentName: stu.display_name || stu.username,
              subject: String(r.subject || (r.problemSnapshot && r.problemSnapshot.subject) || (r.problem && r.problem.subject) || ''),
              createdAt: r.createdAt || 0,
              result: {
                summary: { score: su.score, fullScore: su.fullScore, verdict: su.verdict },
                errorTags: rr.errorTags || [],
                knowledgePoints: rr.knowledgePoints || [],
                stepComparison: (rr.stepComparison || []).map((s) => ({ status: s && s.status })),
                notationIssues: rr.notationIssues || [],
                thinkingErrors: rr.thinkingErrors || [],
              },
              problemSnapshot: r.problemSnapshot
                ? { stem: r.problemSnapshot.stem || '', tags: r.problemSnapshot.tags || '' }
                : null,
            });
          });
        });
      }
      records.sort((a, b) => b.createdAt - a.createdAt);
      return json({
        class: { id: cls.id, grade: cls.grade, name: cls.name, studentCount: students.length },
        records: records.slice(0, 3000),
      });
    }

    /* 重置班级固定邀请码：旧码立即失效，已注册学生与数据不受影响 */
    if (pathname === '/api/teacher/class/resetcode' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const classId = String((body && body.classId) || '').trim();
      const cls = await env.DB.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').bind(classId, me.id).first();
      if (!cls) return json({ error: { message: '班级不存在' } }, 404);
      let code = '';
      for (let i = 0; i < 6 && !code; i++) {
        const c = inviteCode();
        const dup = await env.DB.prepare('SELECT id FROM classes WHERE code = ?').bind(c).first();
        if (!dup) code = c;
      }
      if (!code) return json({ error: { message: '生成新邀请码失败，请重试' } }, 500);
      await env.DB.prepare('UPDATE classes SET code = ? WHERE id = ?').bind(code, cls.id).run();
      return json({ code, oldCode: cls.code });
    }

    /* 批量建号：名单每行「姓名」或「姓名,学号」，返回可发放的用户名与初始密码 */
    if (pathname === '/api/teacher/class/students' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const classId = String((body && body.classId) || '').trim();
      const raw = String((body && body.text) || '');
      const cls = await env.DB.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').bind(classId, me.id).first();
      if (!cls) return json({ error: { message: '班级不存在' } }, 404);
      const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 300);
      if (!lines.length) return json({ error: { message: '名单为空，请每行填一个学生姓名' } }, 400);
      const items = [];
      const skipped = [];
      lines.forEach((line) => {
        const parts = line.split(/[,，\t]/).map((s) => s.trim()).filter(Boolean);
        const name = parts[0] || '';
        const sno = (parts[1] || '').replace(/[^A-Za-z0-9_]/g, '');
        if (!name || name.length > 30) { skipped.push(line); return; }
        items.push({ name, sno });
      });
      if (!items.length) return json({ error: { message: '没有解析到有效姓名' } }, 400);
      const className = [cls.grade, cls.name].filter(Boolean).join(' ');
      /* 用户名：有学号用学号，否则「班级码小写+序号」；冲突再补随机后缀 */
      const wanted = items.map((it, i) => it.sno || (cls.code.toLowerCase() + String(i + 1).padStart(2, '0')));
      const taken = new Set();
      for (let i = 0; i < wanted.length; i += 90) {
        const chunk = wanted.slice(i, i + 90);
        const marks = chunk.map(() => '?').join(',');
        const r = await env.DB.prepare(`SELECT username FROM users WHERE username IN (${marks})`).bind(...chunk).all();
        (r.results || []).forEach((x) => taken.add(x.username));
      }
      const now = Date.now();
      const created = [];
      const stmts = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let username = wanted[i];
        while (taken.has(username)) username = wanted[i] + randomHex(1);
        taken.add(username);
        const password = tempPassword();
        const salt = randomHex(16);
        const hash = await sha256Hex(salt + password);
        stmts.push(env.DB.prepare(
          `INSERT INTO users (id, username, salt, hash, is_admin, created_at, role, teacher_id, display_name, class_id, class_name)
           VALUES (?, ?, ?, ?, 0, ?, 'student', ?, ?, ?, ?)`
        ).bind(randomHex(16), username, salt, hash, now, me.id, it.name, cls.id, className));
        created.push({ name: it.name, username, password });
      }
      for (let i = 0; i < stmts.length; i += 25) {
        await env.DB.batch(stmts.slice(i, i + 25));
      }
      return json({
        created, skipped,
        classInfo: { id: cls.id, grade: cls.grade, name: cls.name, code: cls.code },
      });
    }
  }

  /* 拉取云端数据（P1：老题库一次性迁到 questions 表，包里不再带 problems） */
  if (pathname === '/api/sync' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT data, updated_at FROM userdata WHERE user_id = ?').bind(auth.userId).first();
    if (!row) return json({ data: null, updatedAt: 0 });
    let data = null;
    try { data = JSON.parse(row.data); } catch (e) { data = null; }
    if (data && Array.isArray(data.problems) && data.problems.length) {
      const before = row.data;
      data = await migrateProblemsToQBank(env, auth.userId, data);
      const text = JSON.stringify(data);
      if (text !== before) {
        await env.DB.prepare('UPDATE userdata SET data = ? WHERE user_id = ?').bind(text, auth.userId).run();
      }
    } else if (data && Array.isArray(data.problems)) {
      data.problems = [];
    }
    return json({ data, updatedAt: row.updated_at });
  }

  /* 上传本地数据（整 blob，last-write-wins；题库已迁出，这里只收学生与批改记录） */
  if (pathname === '/api/sync' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== 'object') return json({ error: { message: '数据格式不正确' } }, 400);
    const incoming = Object.assign({}, body.data);
    if (Array.isArray(incoming.problems)) delete incoming.problems; // 题库走 /api/qbank/*，禁止双写
    const text = JSON.stringify(incoming);
    if (text.length > MAX_DATA_CHARS) {
      return json({ error: { message: '数据体积过大（含原图），请改发精简包', code: 'TOO_LARGE' } }, 413);
    }
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO userdata (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(auth.userId, text, now).run();
    return json({ ok: true, updatedAt: now });
  }

  /* ---- 题库接口（P1） ---- */
  /* 存/更新一道题：按 id 主键 upsert；只补空字段，不覆盖已有内容 */
  if (pathname === '/api/qbank/upsert' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const p = body && body.problem;
    if (!p || !String(p.stem || '').trim()) return json({ error: { message: '缺少题干' } }, 400);
    const now = Date.now();
    const id = String(p.id || randomHex(12));
    const exist = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
    if (exist && exist.owner_id && exist.owner_id !== auth.userId) {
      return json({ error: { message: '无权修改该题目' } }, 403);
    }
    const subject = String(p.subject || (exist && exist.subject) || 'math');
    const stem = String(p.stem || (exist && exist.stem) || '');
    const tags = Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags == null ? (exist ? exist.tags : '') : p.tags);
    const review = p.review ? JSON.stringify(p.review) : (exist && exist.review ? exist.review : null);
    const images = Array.isArray(p.images)
      ? JSON.stringify(p.images.filter((x) => x && x.key).slice(0, 3))
      : '';
    if (exist) {
      const rev = Number(exist.rev || 1) + 1;
      await env.DB.prepare(
        `UPDATE questions SET
           subject = ?, stem = ?, stem_norm = ?, fingerprint = ?,
           answer = CASE WHEN ? <> '' THEN ? ELSE answer END,
           solution = CASE WHEN ? <> '' THEN ? ELSE solution END,
           points = CASE WHEN ? <> '' THEN ? ELSE points END,
           tags = CASE WHEN ? <> '' THEN ? ELSE tags END,
           review = COALESCE(?, review),
           extra = CASE WHEN ? <> '' THEN ? ELSE extra END,
           full_score = CASE WHEN ? > 0 THEN ? ELSE full_score END,
           images = CASE WHEN ? <> '' THEN ? ELSE images END,
           difficulty = ?, source = ?, quality = ?, rev = ?, deleted = 0, updated_at = ?
         WHERE id = ?`
      ).bind(
        subject, stem, qNorm(stem), qFingerprint(subject, stem),
        String(p.answer || ''), String(p.answer || ''),
        String(p.sol || ''), String(p.sol || ''),
        String(p.points || ''), String(p.points || ''),
        tags, tags,
        review,
        String(p.extra || ''), String(p.extra || ''),
        Number(p.full) || 0, Number(p.full) || 0,
        images, images,
        Number(p.difficulty) || exist.difficulty || 3,
        String(p.source || exist.source || 'photo-solve'),
        Number(p.quality) || exist.quality || 0,
        rev, Number(p.updatedAt) || now, id
      ).run();
      await env.DB.prepare(
        `INSERT INTO question_revisions (id, question_id, rev, snapshot, editor, reason, created_at)
         VALUES (?, ?, ?, ?, 'model', 'upsert', ?) ON CONFLICT(question_id, rev) DO NOTHING`
      ).bind(randomHex(10), id, rev, JSON.stringify(rowToProblem(Object.assign({}, exist, { rev }))), now).run();
      return json({ id, created: false, rev, merged: false });
    }
    await env.DB.prepare(
      `INSERT INTO questions (id, owner_id, scope, subject, stem, stem_norm, fingerprint, answer, solution, points, tags, review, extra, images, full_score, difficulty, source, quality, rev, deleted, created_at, updated_at)
       VALUES (?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
    ).bind(
      id, auth.userId, subject, stem, qNorm(stem), qFingerprint(subject, stem),
      String(p.answer || ''), String(p.sol || ''), String(p.points || ''), tags, review,
      String(p.extra || ''), images || null, Number(p.full) || 0, Number(p.difficulty) || 3,
      String(p.source || 'manual'), Number(p.quality) || 0,
      Number(p.createdAt) || now, Number(p.updatedAt) || now
    ).run();
    return json({ id, created: true, rev: 1, merged: false });
  }

  /* 检索候选：同科 + 指纹或题干规范化后命中，再按相似度打分 */
  if (pathname === '/api/qbank/search' && request.method === 'POST') {
    const body = await request.json().catch(() => null) || {};
    const subject = String(body.subject || 'math');
    const stem = String(body.stem || '');
    if (!stem.trim()) return json({ hits: [] });
    const limit = Math.min(Number(body.limit) || 5, 20);
    const norm = qNorm(stem);
    const fp = qFingerprint(subject, stem);
    /* P4：私有题库 + 公共种子库一起检索（种子库 scope='public'，不归属任何用户） */
    const rs = await env.DB.prepare(
      `SELECT * FROM questions
       WHERE deleted = 0 AND subject = ? AND (fingerprint = ? OR stem_norm = ?)
         AND (owner_id = ? OR scope = 'public')
       LIMIT 50`
    ).bind(subject, fp, norm, auth.userId).all();
    const hits = (rs.results || []).map((r) => {
      const score = r.stem_norm === norm ? 1 : qSimilarity(norm, r.stem_norm || '');
      return {
        id: r.id, score: Math.round(score * 100) / 100, stem: r.stem, answer: r.answer,
        sol: r.solution || '', points: r.points || '', full: r.full_score || 0, tags: r.tags || '',
        quality: r.quality, source: r.source, public: r.scope === 'public',
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    return json({ hits });
  }

  /* 我的题库列表（游标分页，按 updated_at 倒序） */
  if (pathname === '/api/qbank/list' && request.method === 'GET') {
    const u = new URL(request.url);
    const subject = u.searchParams.get('subject') || '';
    const kw = (u.searchParams.get('kw') || '').trim();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 500);
    const cursor = u.searchParams.get('cursor') || '';
    let sql = `SELECT * FROM questions WHERE owner_id = ? AND deleted = 0`;
    const args = [auth.userId];
    if (subject) { sql += ' AND subject = ?'; args.push(subject); }
    if (kw) { sql += ' AND (stem LIKE ? OR tags LIKE ?)'; args.push('%' + kw + '%', '%' + kw + '%'); }
    /* 游标 = updated_at|id：同一毫秒内多条时用 id 兜底，避免分页丢行 */
    if (cursor) {
      const [cts, cid] = String(cursor).split('|');
      const ts = Number(cts) || 0;
      sql += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      args.push(ts, ts, cid || '');
    }
    sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    args.push(limit);
    const rs = await env.DB.prepare(sql).bind(...args).all();
    const items = (rs.results || []).map(rowToProblem);
    const lastItem = items[items.length - 1];
    const nextCursor = items.length === limit && lastItem ? lastItem.updatedAt + '|' + lastItem.id : 0;
    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM questions WHERE owner_id = ? AND deleted = 0')
      .bind(auth.userId).first();
    return json({ items, nextCursor, total: (totalRow && totalRow.c) || 0 });
  }

  /* 软删除 */
  if (pathname === '/api/qbank/delete' && request.method === 'POST') {
    const body = await request.json().catch(() => null) || {};
    const id = String(body.id || '');
    if (!id) return json({ error: { message: '缺少题目 id' } }, 400);
    await env.DB.prepare('UPDATE questions SET deleted = 1, updated_at = ? WHERE id = ? AND owner_id = ?')
      .bind(Date.now(), id, auth.userId).run();
    return json({ ok: true });
  }

  /* 计数：被命中 / 被用于批改（P3） */
  if (pathname === '/api/qbank/touch' && request.method === 'POST') {
    const body = await request.json().catch(() => null) || {};
    const id = String(body.id || '');
    if (!id) return json({ error: { message: '缺少题目 id' } }, 400);
    const own = await env.DB.prepare(
      "SELECT id FROM questions WHERE id = ? AND deleted = 0 AND (owner_id = ? OR scope = 'public')"
    ).bind(id, auth.userId).first();
    if (!own) return json({ ok: false }, 404);
    const hit = body.hit ? 1 : 0;
    const use = body.use ? 1 : 0;
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE questions SET hit_count = hit_count + ?, use_count = use_count + ? WHERE id = ?'
    ).bind(hit, use, id).run();
    await env.DB.prepare(
      `INSERT INTO question_stats (question_id, hit_count, miss_count, use_count, last_hit_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)
       ON CONFLICT(question_id) DO UPDATE SET
         hit_count = hit_count + ?, use_count = use_count + ?,
         last_hit_at = COALESCE(?, last_hit_at), updated_at = excluded.updated_at`
    ).bind(id, hit, use, hit ? now : null, now, hit, use, hit ? now : null).run();
    return json({ ok: true });
  }

  /* 版本列表（P3）：按版本倒序，返回改动摘要 */
  if (pathname === '/api/qbank/revisions' && request.method === 'GET') {
    const u = new URL(request.url);
    const id = u.searchParams.get('id') || '';
    if (!id) return json({ error: { message: '缺少题目 id' } }, 400);
    const own = await env.DB.prepare('SELECT id FROM questions WHERE id = ? AND owner_id = ?')
      .bind(id, auth.userId).first();
    if (!own) return json({ items: [] }, 404);
    const rs = await env.DB.prepare(
      'SELECT rev, editor, reason, created_at FROM question_revisions WHERE question_id = ? ORDER BY rev DESC LIMIT 50'
    ).bind(id).all();
    return json({ items: rs.results || [] });
  }

  /* 回滚到指定版本：把快照写成新版本，旧版本一律保留（P3） */
  if (pathname === '/api/qbank/revision' && request.method === 'POST') {
    const body = await request.json().catch(() => null) || {};
    const id = String(body.id || '');
    const rev = Number(body.rev) || 0;
    if (!id || !rev) return json({ error: { message: '缺少参数' } }, 400);
    const own = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND owner_id = ?')
      .bind(id, auth.userId).first();
    if (!own) return json({ error: { message: '题目不存在' } }, 404);
    const snapRow = await env.DB.prepare(
      'SELECT snapshot FROM question_revisions WHERE question_id = ? AND rev = ?'
    ).bind(id, rev).first();
    if (!snapRow) return json({ error: { message: '该版本不存在' } }, 404);
    let snap = {};
    try { snap = JSON.parse(snapRow.snapshot || '{}'); } catch (e) { snap = {}; }
    const nextRev = Number(own.rev || 1) + 1;
    const now = Date.now();
    const stem = String(snap.stem || own.stem || '');
    const subject = String(snap.subject || own.subject || 'math');
    const review = snap.review ? JSON.stringify(snap.review) : own.review;
    await env.DB.prepare(
      `UPDATE questions SET subject = ?, stem = ?, stem_norm = ?, fingerprint = ?, answer = ?, solution = ?,
         points = ?, tags = ?, review = ?, extra = ?, full_score = ?, difficulty = ?, rev = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      subject, stem, qNorm(stem), qFingerprint(subject, stem),
      String(snap.answer || ''), String(snap.sol || ''), String(snap.points || ''),
      Array.isArray(snap.tags) ? snap.tags.join(',') : String(snap.tags || ''),
      review, String(snap.extra || ''), Number(snap.full) || 0, Number(snap.difficulty) || 3,
      nextRev, now, id
    ).run();
    await env.DB.prepare(
      `INSERT INTO question_revisions (id, question_id, rev, snapshot, editor, reason, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?) ON CONFLICT(question_id, rev) DO NOTHING`
    ).bind(randomHex(10), id, nextRev, JSON.stringify(snap), 'rollback to rev ' + rev, now).run();
    return json({ id, rev: nextRev, restoredFrom: rev });
  }

  /* 题库汇总：题数 / 命中 / 使用 */
  if (pathname === '/api/qbank/stats' && request.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN quality >= 1 THEN 1 ELSE 0 END) AS verified,
              SUM(hit_count) AS hits,
              SUM(use_count) AS uses
       FROM questions WHERE owner_id = ? AND deleted = 0`
    ).bind(auth.userId).first();
    return json({
      total: (r && r.total) || 0,
      verified: (r && r.verified) || 0,
      hits: (r && r.hits) || 0,
      uses: (r && r.uses) || 0,
    });
  }

  /* 种子库导入（P4）：管理员分批把 seed_math_N.json 写进公共题库，可重复执行（幂等） */
  if (pathname === '/api/admin/seed' && request.method === 'POST') {
    if (!me.is_admin) return json({ error: { message: '仅管理员可访问' } }, 403);
    const u = new URL(request.url);
    const part = Math.max(1, Number(u.searchParams.get('part')) || 1);
    const assetUrl = new URL('/seed_math_' + part + '.json', request.url);
    let list = null;
    try {
      const ar = await env.ASSETS.fetch(assetUrl);
      if (!ar.ok) return json({ error: { message: '没有第 ' + part + ' 个种子分片' } }, 404);
      list = await ar.json();
    } catch (e) {
      return json({ error: { message: '读取种子分片失败：' + String(e && e.message || e).slice(0, 120) } }, 500);
    }
    if (!Array.isArray(list) || !list.length) return json({ error: { message: '种子分片为空' } }, 400);
    const now = Date.now();
    let inserted = 0;
    for (let i = 0; i < list.length; i += 50) {
      const stmts = list.slice(i, i + 50).map((s) => env.DB.prepare(
        `INSERT INTO questions (id, owner_id, scope, subject, stem, stem_norm, fingerprint, answer, solution, points, tags, review, extra, full_score, difficulty, source, quality, rev, deleted, created_at, updated_at)
         VALUES (?, '__seed__', 'public', 'math', ?, ?, ?, ?, ?, '', ?, NULL, ?, ?, 3, ?, 1, 1, 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(
        String(s.id || ''), String(s.stem || ''),
        qNorm(s.stem), qFingerprint('math', s.stem),
        String(s.answer || ''), String(s.sol || ''),
        String(s.tags || ''), String(s.extra || ''),
        Number(s.full) || 10, String(s.source || 'seed:gaokao-bench'),
        now, now
      ));
      const rs = await env.DB.batch(stmts);
      (rs || []).forEach((r) => { inserted += Number((r && r.meta && r.meta.changes) || 0); });
    }
    await env.DB.prepare(
      `INSERT INTO user_migrations (user_id, key, status, detail, updated_at) VALUES ('__seed__', ?, 'done', ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at`
    ).bind('seed_math_part' + part, 'rows=' + list.length + ', inserted=' + inserted, now).run();
    return json({ part, rows: list.length, inserted, skipped: list.length - inserted });
  }

  /* 管理员：查看全部已注册用户及其数据规模 */
  if (pathname === '/api/admin/users' && request.method === 'GET') {
    if (!me.is_admin) return json({ error: { message: '仅管理员可访问' } }, 403);
    const rows = await env.DB.prepare(
      `SELECT u.id, u.username, u.is_admin, u.created_at, d.updated_at, d.data
       FROM users u LEFT JOIN userdata d ON d.user_id = u.id
       ORDER BY u.created_at ASC`
    ).all();
    const qrows = await env.DB.prepare(
      'SELECT owner_id, COUNT(*) AS c FROM questions WHERE deleted = 0 GROUP BY owner_id'
    ).all();
    const qmap = {};
    (qrows.results || []).forEach((r) => { qmap[r.owner_id] = r.c; });
    const users = (rows.results || []).map((r) => {
      let counts = { problems: qmap[r.id] || 0, students: 0, records: 0 };
      if (r.data) {
        try {
          const d = JSON.parse(r.data);
          counts = {
            problems: qmap[r.id] || 0, // P1 起题库来自 questions 表，旧包里的 problems 仅作迁移前统计
            students: Array.isArray(d.students) ? d.students.length : 0,
            records: Array.isArray(d.records) ? d.records.length : 0,
          };
        } catch (e) {}
      }
      return {
        username: r.username,
        isAdmin: !!r.is_admin,
        createdAt: r.created_at,
        updatedAt: r.updated_at || 0,
        counts,
      };
    });
    return json({ users });
  }

  return json({ error: { message: '接口不存在' } }, 404);
}

/* 图片读取：签名校验后从 R2 或 KV 回源，浏览器 <img> 可直接引用（无需带登录头） */
async function serveMedia(env, url) {
  let key = '';
  try {
    key = decodeURIComponent(url.pathname.slice('/api/media/'.length));
  } catch (e) {
    return json({ error: { message: '图片地址无效' } }, 400);
  }
  if (!key || key.indexOf('..') >= 0 || key.charAt(0) === '/') {
    return json({ error: { message: '图片地址无效' } }, 400);
  }
  const sig = String(url.searchParams.get('s') || '');
  const expect = await mediaSig(env, key);
  if (sig.length !== expect.length) return json({ error: { message: '图片签名无效' } }, 403);
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return json({ error: { message: '图片签名无效' } }, 403);

  const headers = new Headers(cors());
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  if (key.indexOf('k/') === 0) {
    if (!env.MEDIA_KV) {
      return json({ error: { message: '服务器未绑定 KV 存储（变量名 MEDIA_KV）', code: 'NO_MEDIA' } }, 503);
    }
    let got = null;
    try {
      got = await env.MEDIA_KV.getWithMetadata(key, 'text');
    } catch (e) {
      got = null;
    }
    if (!got || !got.value) return new Response('Not Found', { status: 404, headers: cors() });
    let bin;
    try {
      const raw = atob(got.value);
      bin = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    } catch (e) {
      return new Response('Bad Image', { status: 500, headers: cors() });
    }
    headers.set('Content-Type', (got.metadata && got.metadata.mime) || 'image/jpeg');
    return new Response(bin, { status: 200, headers });
  }

  if (key.indexOf('m/') === 0) {
    if (!env.MEDIA) {
      return json({ error: { message: '服务器未绑定 R2 存储（变量名 MEDIA）', code: 'NO_R2' } }, 503);
    }
    const obj = await env.MEDIA.get(key);
    if (!obj) return new Response('Not Found', { status: 404, headers: cors() });
    headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg');
    if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
    return new Response(obj.body, { status: 200, headers });
  }

  return json({ error: { message: '图片地址无效' } }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/v1/chat/completions') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
      if (request.method !== 'POST') return json({ error: { message: '只接受 POST 请求' } }, 405);
      const KEY = env.UPSTREAM_KEY || env.DASHSCOPE_API_KEY || BUILTIN_KEY;
      if (!KEY) return json({ error: { message: '未配置密钥：请在 _worker.js 的 BUILTIN_KEY 或 Pages 环境变量中设置' } }, 500);
      // 可选：用环境变量接入任意 OpenAI 兼容的视觉模型（如豆包 Ark）
      // UPSTREAM=完整 chat/completions 地址，MODEL=模型/接入点 ID，UPSTREAM_KEY=对应密钥
      const upstreamUrl = env.UPSTREAM || UPSTREAM;
      const upstreamModel = env.MODEL || MODEL;

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: { message: '请求体不是合法 JSON' } }, 400);
      }

      const task = body.x_task; // ocr = 题目识别、solve = 拍照解题、anno = 仅批注定位，都不注入批改硬约束
      delete body.x_task; // 自定义字段不外发上游
      body.model = upstreamModel; // 强制模型
      // 关闭"思考/推理"模式：这些任务只需结构化输出，思考前缀会白等 20~40 秒。
      // 百炼用 enable_thinking，豆包 Ark 用 thinking.type，按上游域名自适应；NO_THINKING=0 可整体关闭本优化。
      if (String(env.NO_THINKING || '1') !== '0') {
        if (/dashscope|aliyuncs/.test(upstreamUrl)) body.enable_thinking = false;
        else body.thinking = { type: 'disabled' };
      }
      // 流式输出：模型边生成边回传，连接上持续有数据，
      // 避免手机蜂窝网关把 40~60 秒无数据的长连接当作死连接掐断（手机端"网络请求失败"的根因）
      body.stream = true;
      if (task === 'grade') {
        // 拆流提速：详细批改这一路不再要定位框（另由 anno 任务单独出框），去掉第10、11条约束
        body.messages = [{ role: 'system', content: SUFFIX_NO_ANNO }, ...(body.messages || [])];
      } else if (task !== 'ocr' && task !== 'solve' && task !== 'anno' && task !== 'quick') {
        body.messages = [{ role: 'system', content: SUFFIX }, ...(body.messages || [])]; // 注入批改硬约束
      }

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // 原样透传上游 SSE 字节流（含错误响应），让浏览器收到的也是持续不断的数据流
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...cors(),
        },
      });
    }

    // 版本探测（公开接口，免登录、免 D1）：前端定时比对自身烘焙版本号，发版后弹出刷新提示
    if (url.pathname === '/api/version') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors() });
      }
      return new Response(JSON.stringify({ v: BUILD_ID }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          ...cors(),
        },
      });
    }

    // 批改原图（R2）：带签名地址，公开可读但不暴露登录态
    if (url.pathname.startsWith('/api/media/') && request.method === 'GET') {
      return serveMedia(env, url);
    }

    // 开发者后台（隐藏入口 dev.html，凭密钥访问全站题库；密钥不会下发到浏览器）
    if (url.pathname.startsWith('/api/dev/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
      const devKey = String(env.DEV_KEY || BUILTIN_DEV_KEY || '');
      const key = String(request.headers.get('x-dev-key') || url.searchParams.get('key') || '').trim();
      if (!devKey || key !== devKey) return json({ error: { message: '密钥无效，无权访问' } }, 401);

      if (url.pathname === '/api/dev/stats') {
        const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions').first();
        const groups = await env.DB.prepare(
          'SELECT subject, scope, COUNT(*) AS n, SUM(deleted) AS del FROM questions GROUP BY subject, scope ORDER BY n DESC'
        ).all();
        const sources = await env.DB.prepare(
          "SELECT COALESCE(NULLIF(source,''),'(未标来源)') AS s, COUNT(*) AS n FROM questions GROUP BY s ORDER BY n DESC LIMIT 20"
        ).all();
        return json({
          total: (total && total.n) || 0,
          groups: groups.results || [],
          sources: sources.results || [],
        });
      }

      if (url.pathname === '/api/dev/questions') {
        const q = String(url.searchParams.get('q') || '').trim();
        const subject = String(url.searchParams.get('subject') || '').trim();
        const onlyDeleted = url.searchParams.get('deleted') === '1';
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const where = ['deleted = ?'];
        const binds = [onlyDeleted ? 1 : 0];
        if (subject) { where.push('subject = ?'); binds.push(subject); }
        if (q) {
          where.push('(stem LIKE ? OR answer LIKE ? OR solution LIKE ? OR tags LIKE ? OR id = ?)');
          const like = '%' + q + '%';
          binds.push(like, like, like, like, q);
        }
        const w = where.join(' AND ');
        const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM questions WHERE ${w}`).bind(...binds).first();
        const rows = await env.DB.prepare(
          `SELECT id, owner_id, scope, subject, stem, answer, solution, tags, points, extra,
                  full_score, source, quality, hit_count, use_count, deleted, created_at, updated_at
           FROM questions WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).bind(...binds, limit, offset).all();
        return json({ total: (total && total.n) || 0, limit, offset, questions: rows.results || [] });
      }

      if (url.pathname === '/api/dev/export') {
        const subject = String(url.searchParams.get('subject') || '').trim();
        const format = String(url.searchParams.get('format') || 'json');
        const where = subject ? 'subject = ? AND deleted = 0' : 'deleted = 0';
        const stmt = env.DB.prepare(
          `SELECT id, subject, stem, answer, solution, tags, points, extra, full_score, source, scope, created_at
           FROM questions WHERE ${where} ORDER BY created_at LIMIT 20000`
        );
        const rows = subject ? await stmt.bind(subject).all() : await stmt.all();
        const list = rows.results || [];
        if (format === 'csv') {
          const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
          const head = 'id,subject,stem,answer,solution,tags,points,extra,full_score,source,scope';
          const body = list.map((r) => [r.id, r.subject, r.stem, r.answer, r.solution, r.tags, r.points, r.extra, r.full_score, r.source, r.scope].map(cell).join(','));
          return new Response('\ufeff' + [head, ...body].join('\r\n'), {
            headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="qbank.csv"' },
          });
        }
        return new Response(JSON.stringify({ exportedAt: Date.now(), count: list.length, questions: list }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="qbank.json"' },
        });
      }

      if (url.pathname === '/api/dev/delete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const id = String((body && body.id) || '').trim();
        if (!id) return json({ error: { message: '缺少 id' } }, 400);
        const r = await env.DB.prepare('UPDATE questions SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
        return json({ ok: true, changes: (r.meta && r.meta.changes) || 0 });
      }

      if (url.pathname === '/api/dev/restore' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const id = String((body && body.id) || '').trim();
        if (!id) return json({ error: { message: '缺少 id' } }, 400);
        const r = await env.DB.prepare('UPDATE questions SET deleted = 0, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
        return json({ ok: true, changes: (r.meta && r.meta.changes) || 0 });
      }

      return json({ error: { message: '未知接口' } }, 404);
    }

    // 健康检查（公开、免登录、免建表）：前端欢迎屏据此提示 D1 绑定状态与修复步骤
    if (url.pathname === '/api/health') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors() });
      }
      if (!env.DB) {
        return json({ db: false, r2: !!env.MEDIA, media: env.MEDIA ? 'r2' : (env.MEDIA_KV ? 'kv' : 'none'), reason: 'NO_D1', binding: 'DB' }, 200);
      }
      try {
        await env.DB.prepare('SELECT 1').first();
        return json({ db: true, r2: !!env.MEDIA, media: env.MEDIA ? 'r2' : (env.MEDIA_KV ? 'kv' : 'none'), ts: Date.now() }, 200);
      } catch (e) {
        return json({ db: false, r2: !!env.MEDIA, media: env.MEDIA ? 'r2' : (env.MEDIA_KV ? 'kv' : 'none'), reason: 'DB_ERROR', detail: String(e && e.message || e).slice(0, 200), binding: 'DB' }, 200);
      }
    }

    // 账号 / 云端同步 / 管理员（D1 未绑定时返回友好错误，不影响静态页面与本地匿名模式）
    if (url.pathname.startsWith('/api/')) {
      try {
        return await apiRoute(request, env, url.pathname);
      } catch (e) {
        if (e && e.message === 'NO_D1') {
          return json({ error: { message: '服务器尚未绑定 D1 数据库：请到 Pages → Settings → Bindings 添加 D1 database，绑定变量名必须为 DB（大写），保存后到 Deployments 点 Retry deployment 重新部署；账号功能暂不可用，游客模式与本地批改不受影响', code: 'NO_D1' } }, 503);
        }
        return json({ error: { message: '服务器开小差了：' + (e && e.message ? e.message : '未知错误') } }, 500);
      }
    }

    // 其余路径交给 Pages 静态资产（index.html 等）
    const assetResp = await env.ASSETS.fetch(request);
    // HTML 入口禁止缓存：拖传更新后主域名必须立刻拿到新版本；其余静态资源保持默认缓存
    const isHtml = url.pathname === '/' || url.pathname.endsWith('.html');
    if (isHtml && assetResp.status === 200) {
      const h = new Headers(assetResp.headers);
      h.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      h.set('Pragma', 'no-cache');
      h.set('Expires', '0');
      return new Response(assetResp.body, {
        status: assetResp.status,
        statusText: assetResp.statusText,
        headers: h,
      });
    }
    return assetResp;
  },
};
