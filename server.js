'use strict';
/*
 * 面评台 · Interview Desk
 * 轻量在线共享面试间：昵称加入 -> 各评委独立打分/备注 -> 实时同步 -> 主持人一键汇总。
 * 支持多场次（跨天/分轮次）与历史留存（服务端快照 + 导出/导入接续）。
 * 依赖：仅 Node.js 内置模块（http / crypto / fs）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DIM_SCALE = 10;

/* ----------------------------- 内存数据层 ----------------------------- */
/*
 * interviews[id] = {
 *   id, code, name, positions, createdAt, hostId,
 *   dimensions:[{id,label,weight}],
 *   rounds:[{id,label,date}],
 *   judges:[{id,nickname,isHost,joinedAt}],
 *   candidates:[{id,name,info,createdAt}],
 *   scores:{ [candidateId]: { [judgeId]: { [roundId]: { [dimId]: {value,note,updatedAt} } } } },
 *   activeRound: roundId
 * }
 */
const db = { interviews: Object.create(null) };
/* 分片上传暂存：uploadId -> {filename, total, parts:{index:b64}, got, at} */
const _uploads = Object.create(null);

const uid = () => crypto.randomUUID();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let out;
  do {
    out = '';
    for (let i = 0; i < 6; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  } while (Object.values(db.interviews).some((iv) => iv.code === out));
  return out;
}
function findById(id) { return db.interviews[id] || null; }
function findByCode(code) {
  const norm = String(code || '').trim().toUpperCase();
  return Object.values(db.interviews).find((iv) => iv.code === norm) || null;
}
function defaultDimensions() {
  return [
    { id: 'd_active', label: '积极性/热情', weight: 25 },
    { id: 'd_comm', label: '沟通表达', weight: 20 },
    { id: 'd_skill', label: '才艺/能力', weight: 25 },
    { id: 'd_time', label: '时间投入', weight: 15 },
    { id: 'd_fit', label: '团队契合', weight: 15 },
  ];
}
function todayStr() {
  const d = new Date();
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/* 兼容旧结构：scores[cand][judge][dim] -> scores[cand][judge][round][dim] */
function normalizeInterview(iv) {
  if (!iv) return iv;
  if (!Array.isArray(iv.rounds) || !iv.rounds.length) {
    iv.rounds = [{ id: 'r1', label: '第 1 轮', date: todayStr() }];
  }
  if (!iv.activeRound || !iv.rounds.some((r) => r.id === iv.activeRound)) iv.activeRound = iv.rounds[0].id;
  if (!Array.isArray(iv.bins) || !iv.bins.length) iv.bins = [{ id: 'b_hire', name: '录取' }];
  iv.scores = iv.scores || {};
  (iv.candidates || []).forEach((c) => {
    if (c.binId === undefined) {
      c.binId = c.decision === '淘汰' ? '__reject__' : (c.decision === '录用' ? iv.bins[0].id : null);
    }
  });
  for (const candId of Object.keys(iv.scores)) {
    const perJudge = iv.scores[candId] || {};
    for (const judgeId of Object.keys(perJudge)) {
      const node = perJudge[judgeId] || {};
      const keys = Object.keys(node);
      const isOld = keys.length && keys.every((k) => node[k] && typeof node[k] === 'object' && ('value' in node[k] || 'note' in node[k]));
      if (isOld) { perJudge[judgeId] = { [iv.rounds[0].id]: node }; }
    }
  }
  return iv;
}

/* --------------------------- 汇总 / 统计计算 --------------------------- */
function judgeDimStat(iv, candId, judgeId, dimId, roundIds) {
  const node = ((iv.scores[candId] || {})[judgeId] || {});
  const vals = [];
  const perRound = {};
  for (const rid of roundIds) {
    const cell = (node[rid] || {})[dimId];
    if (cell && typeof cell.value === 'number') { vals.push(cell.value); perRound[rid] = cell.value; }
  }
  if (!vals.length) return null;
  return { judgeAvg: vals.reduce((a, b) => a + b, 0) / vals.length, perRound };
}

function summarize(iv, onlyRoundId) {
  const dims = iv.dimensions || [];
  const totalWeight = dims.reduce((s, d) => s + (Number(d.weight) || 0), 0) || 1;
  const roundIds = onlyRoundId ? [onlyRoundId] : iv.rounds.map((r) => r.id);

  function buildRows(useRoundIds) {
    return iv.candidates.map((c) => {
      const perDim = [];
      let weighted = 0;
      const scoredJudges = new Set();
      for (const d of dims) {
        const judgeAvgs = [];
        for (const j of iv.judges) {
          const st = judgeDimStat(iv, c.id, j.id, d.id, useRoundIds);
          if (st) { judgeAvgs.push(st.judgeAvg); scoredJudges.add(j.id); }
        }
        const avg = judgeAvgs.length ? judgeAvgs.reduce((a, b) => a + b, 0) / judgeAvgs.length : null;
        const spread = judgeAvgs.length > 1 ? Math.max(...judgeAvgs) - Math.min(...judgeAvgs) : 0;
        perDim.push({ dimId: d.id, label: d.label, weight: d.weight, avg, spread, n: judgeAvgs.length });
        if (avg != null) weighted += (avg / DIM_SCALE) * (Number(d.weight) || 0);
      }
      const finalScore = Number(((weighted / totalWeight) * 100).toFixed(1));
      const divergence = perDim.reduce((m, p) => Math.max(m, p.spread), 0);
      return { candidateId: c.id, name: c.name, info: c.info, decision: c.decision || '', dept: c.dept || '', binId: c.binId || null, finalScore, perDim, judgeCount: scoredJudges.size, divergence };
    }).sort((a, b) => b.finalScore - a.finalScore);
  }

  const rows = buildRows(roundIds);
  const perRound = iv.rounds.map((r) => ({
    roundId: r.id, label: r.label, date: r.date,
    rows: buildRows([r.id]).map((x) => ({ candidateId: x.candidateId, name: x.name, finalScore: x.finalScore, judgeCount: x.judgeCount })),
  }));

  return {
    dims, totalWeight,
    judgeCount: iv.judges.length,
    rounds: iv.rounds, activeRound: iv.activeRound,
    judges: iv.judges.map((j) => ({ id: j.id, nickname: j.nickname, isHost: !!j.isHost })),
    rows, perRound,
  };
}

/* ------------------------------ HTTP 工具 ------------------------------ */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, maxBytes) {
  const cap = maxBytes || 2e6;
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > cap) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}
function sanitizeText(s, max = 2000) { return String(s == null ? '' : s).replace(/\u0000/g, '').slice(0, max).trim(); }
function hostOf(u) { try { return new URL(String(u)).host; } catch (e) { return String(u || ''); } }
function aiStatus(iv) {
  const a = iv.aiCfg;
  if (!a || !a.key || !a.base) return { connected: false };
  return { connected: true, base: a.base, model: a.model || '', protocol: a.protocol || 'auto', host: hostOf(a.base) };
}
function publicInterview(iv) {
  const cands = (iv.candidates || []).map((c) => {
    if (c.resume) { const r = c.resume; return Object.assign({}, c, { resume: { name: r.name, size: r.size, at: r.at } }); }
    return c;
  });
  return {
    id: iv.id, code: iv.code, name: iv.name, positions: iv.positions,
    dimensions: iv.dimensions, rounds: iv.rounds, activeRound: iv.activeRound,
    hostId: iv.hostId, blind: !!iv.blind, bins: iv.bins, aiStatus: aiStatus(iv),
    judges: iv.judges.map((j) => ({ id: j.id, nickname: j.nickname, isHost: !!j.isHost, joinedAt: j.joinedAt })),
    candidates: cands, scores: iv.scores, createdAt: iv.createdAt,
  };
}

/* ------------------------------- API 路由 ------------------------------- */
const routes = {
  'POST /api/interview': async (req, res) => {
    const b = await readBody(req);
    const name = sanitizeText(b.name, 80) || '未命名面试';
    let dims = (Array.isArray(b.dimensions) ? b.dimensions : [])
      .map((d) => ({ id: sanitizeText(d.id, 40) || uid(), label: sanitizeText(d.label, 40) || '维度', weight: Math.max(0, Number(d.weight) || 0) }))
      .filter((d) => d.label);
    let rounds = (Array.isArray(b.rounds) ? b.rounds : [])
      .map((r) => ({ id: sanitizeText(r.id, 40) || uid(), label: sanitizeText(r.label, 40) || '场次', date: sanitizeText(r.date, 20) || todayStr() }));
    if (!rounds.length) rounds = [{ id: 'r1', label: '第 1 轮', date: todayStr() }];
    const id = uid(); const hostId = uid();
    db.interviews[id] = normalizeInterview({
      id, code: genCode(), name, positions: sanitizeText(b.positions, 200),
      dimensions: dims, rounds, activeRound: rounds[0].id, createdAt: Date.now(), hostId,
      blind: !!b.blind,
      judges: [{ id: hostId, nickname: sanitizeText(b.hostName, 20) || '主持人', isHost: true, joinedAt: Date.now() }],
      candidates: [], scores: {},
    });
    persist();
    send(res, 200, { ok: true, interviewId: id, code: db.interviews[id].code, judgeId: hostId, dimensions: dims, rounds });
  },

  'POST /api/join': async (req, res) => {
    const b = await readBody(req);
    const iv = findByCode(b.code);
    if (!iv) return send(res, 404, { ok: false, error: '口令无效，请核对主持人给的 6 位加入码' });
    const nickname = sanitizeText(b.nickname, 20);
    if (!nickname) return send(res, 400, { ok: false, error: '请输入你的昵称' });
    const judgeId = uid();
    iv.judges.push({ id: judgeId, nickname, isHost: false, joinedAt: Date.now() });
    persist();
    send(res, 200, { ok: true, interviewId: iv.id, judgeId, name: iv.name });
  },

  'GET /api/state': (req, res, q) => {
    const iv = normalizeInterview(findById(q.get('id')));
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    send(res, 200, { ok: true, interview: publicInterview(iv), summary: summarize(iv) });
  },

  'POST /api/round': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const r = { id: uid(), label: sanitizeText(b.label, 40) || ('第 ' + (iv.rounds.length + 1) + ' 轮'), date: sanitizeText(b.date, 20) || todayStr() };
    iv.rounds.push(r);
    if (b.activate !== false) iv.activeRound = r.id;
    persist();
    send(res, 200, { ok: true, round: r });
  },
  'POST /api/round/activate': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    if (!iv.rounds.some((r) => r.id === b.roundId)) return send(res, 400, { ok: false, error: '场次不存在' });
    iv.activeRound = b.roundId; persist();
    send(res, 200, { ok: true });
  },

  'POST /api/candidate': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const name = sanitizeText(b.name, 40);
    if (!name) return send(res, 400, { ok: false, error: '候选人姓名不能为空' });
    const c = { id: uid(), name, info: sanitizeText(b.info, 300), createdAt: Date.now() };
    iv.candidates.push(c); iv.scores[c.id] = {};
    persist();
    send(res, 200, { ok: true, candidate: c });
  },
  'POST /api/candidate/delete': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    iv.candidates = iv.candidates.filter((c) => c.id !== b.candidateId);
    delete iv.scores[b.candidateId]; persist();
    send(res, 200, { ok: true });
  },

  // 人工录用标记（决策归人）
  'POST /api/candidate/decision': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === b.candidateId);
    if (!c) return send(res, 400, { ok: false, error: '候选人不存在' });
    const allow = { none: '', hire: '录用', hold: '待定', reject: '淘汰' };
    const key = allow[b.decision] !== undefined ? b.decision : 'none';
    c.decision = allow[key];
    // 同步决策台所需的 binId/dept，保证面试间/排行/报告/决策台四处一致
    const firstBin = (iv.bins || [])[0];
    if (key === 'reject') { c.binId = '__reject__'; c.dept = ''; }
    else if (key === 'hire') {
      const inHire = c.binId && c.binId !== '__reject__' && (iv.bins || []).some((x) => x.id === c.binId);
      if (!inHire) { c.binId = firstBin ? firstBin.id : null; c.dept = firstBin ? firstBin.name : ''; }
    } else { c.binId = null; c.dept = ''; } // none / hold(待定) 回到待定池
    persist();
    send(res, 200, { ok: true, decision: c.decision, binId: c.binId });
  },

  // 部门篓管理：增/改名/删（删除时其成员回到待定池）
  'POST /api/bins': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    let bins = (Array.isArray(b.bins) ? b.bins : [])
      .map((x) => ({ id: sanitizeText(x.id, 40) || uid(), name: sanitizeText(x.name, 20) || '录取' }))
      .filter((x) => x.name);
    if (!bins.length) bins = [{ id: 'b_hire', name: '录取' }];
    const ids = bins.map((x) => x.id);
    (iv.candidates || []).forEach((c) => {
      if (c.binId && c.binId !== '__reject__' && ids.indexOf(c.binId) < 0) { c.binId = null; c.decision = ''; c.dept = ''; }
      else if (c.binId && c.binId !== '__reject__') { const bb = bins.find((x) => x.id === c.binId); if (bb) c.dept = bb.name; }
    });
    iv.bins = bins; persist();
    send(res, 200, { ok: true, bins });
  },

  // 把候选人分配到某个篓（互斥）：binId = null(待定) | '__reject__'(淘汰) | 部门篓id(录用)
  'POST /api/assign': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === b.candidateId);
    if (!c) return send(res, 400, { ok: false, error: '候选人不存在' });
    const binId = b.binId || null;
    if (binId === '__reject__') { c.binId = '__reject__'; c.decision = '淘汰'; c.dept = ''; }
    else if (binId) {
      const bb = (iv.bins || []).find((x) => x.id === binId);
      if (!bb) return send(res, 400, { ok: false, error: '部门篓不存在' });
      c.binId = bb.id; c.decision = '录用'; c.dept = bb.name;
    } else { c.binId = null; c.decision = ''; c.dept = ''; }
    persist();
    send(res, 200, { ok: true, binId: c.binId, decision: c.decision, dept: c.dept });
  },

  // 简历（仅 Word .docx）存档与读取
  'POST /api/candidate/resume': async (req, res) => {
    const b = await readBody(req, 14e6);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === b.candidateId);
    if (!c) return send(res, 400, { ok: false, error: '候选人不存在' });
    const data = String(b.dataBase64 || '');
    const fname = sanitizeText(b.filename, 120) || 'resume.docx';
    if (!/\.docx$/i.test(fname)) return send(res, 400, { ok: false, error: '简历仅支持 Word (.docx) 格式' });
    if (!data) return send(res, 400, { ok: false, error: '缺少文件内容' });
    const size = Math.floor(data.length * 3 / 4);
    if (size > 10e6) return send(res, 400, { ok: false, error: '文件过大（上限 10MB）' });
    c.resume = { name: fname, data: data, size: size, at: Date.now() };
    persist();
    send(res, 200, { ok: true, resume: { name: c.resume.name, size: c.resume.size, at: c.resume.at } });
  },
  // 分片上传简历：绕开平台反向代理 ~1MB 请求体上限（413），每片远小于该值，服务端重组
  'POST /api/resume/chunk': async (req, res) => {
    const b = await readBody(req, 2e6);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === b.candidateId);
    if (!c) return send(res, 400, { ok: false, error: '候选人不存在' });
    const upId = String(b.uploadId || '');
    const total = Number(b.total) || 0;
    const idx = Number(b.index) || 0;
    if (!upId || total <= 0) return send(res, 400, { ok: false, error: '分片参数错误' });
    let u = _uploads[upId];
    if (!u) {
      const now = Date.now();
      for (const k of Object.keys(_uploads)) { if (now - _uploads[k].at > 30 * 60 * 1000) delete _uploads[k]; }
      u = _uploads[upId] = { filename: sanitizeText(b.filename, 120) || 'resume.docx', total: total, parts: Object.create(null), got: 0, at: now };
    }
    if (!(idx in u.parts)) { u.parts[idx] = String(b.dataBase64 || ''); u.got++; }
    if (u.got >= u.total) {
      let full = '';
      for (let i = 0; i < u.total; i++) full += (u.parts[i] || '');
      delete _uploads[upId];
      if (!full) return send(res, 400, { ok: false, error: '缺少文件内容' });
      const fname = /\.docx$/i.test(u.filename) ? u.filename : (u.filename + '.docx');
      const size = Math.floor(full.length * 3 / 4);
      if (size > 10e6) return send(res, 400, { ok: false, error: '文件过大（上限 10MB）' });
      c.resume = { name: fname, data: full, size: size, at: Date.now() };
      persist();
      return send(res, 200, { ok: true, done: true, resume: { name: c.resume.name, size: c.resume.size, at: c.resume.at } });
    }
    send(res, 200, { ok: true, done: false, got: u.got, total: u.total });
  },
  'GET /api/candidate/resume': (req, res, q) => {
    const iv = findById(q.get('interviewId'));
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === q.get('candidateId'));
    if (!c || !c.resume) return send(res, 404, { ok: false, error: '该候选人未上传简历' });
    send(res, 200, { ok: true, filename: c.resume.name, dataBase64: c.resume.data, size: c.resume.size });
  },
  'POST /api/candidate/resume/delete': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const c = iv.candidates.find((x) => x.id === b.candidateId);
    if (c) delete c.resume;
    persist();
    send(res, 200, { ok: true });
  },

  // 建场后编辑维度与权重（保留已有维度 id 以不丢分）
  'POST /api/dimensions': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    let dims = (Array.isArray(b.dimensions) ? b.dimensions : [])
      .map((d) => ({ id: sanitizeText(d.id, 40) || uid(), label: sanitizeText(d.label, 40) || '维度', weight: Math.max(0, Number(d.weight) || 0) }))
      .filter((d) => d.label);
    if (!dims.length) return send(res, 400, { ok: false, error: '至少保留一个维度' });
    iv.dimensions = dims; persist();
    send(res, 200, { ok: true, dimensions: dims });
  },

  // 盲评开关
  'POST /api/settings': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    if (typeof b.blind === 'boolean') iv.blind = b.blind;
    persist();
    send(res, 200, { ok: true, blind: !!iv.blind });
  },

  // 保存 AI 配置到服务端（绑定本场面试，重开自动记住；Key 不下发前端）
  'POST /api/aiset': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const base = sanitizeText(b.base, 200);
    const key = sanitizeText(b.key, 200);
    if (!base && !key && !iv.aiCfg) { send(res, 200, { ok: true, aiStatus: aiStatus(iv) }); return; }
    const cur = iv.aiCfg || {};
    iv.aiCfg = {
      base: base || cur.base || '',
      model: sanitizeText(b.model, 60) || cur.model || '',
      protocol: sanitizeText(b.protocol, 20) || cur.protocol || 'auto',
      key: key || cur.key || '', // 留空则沿用已存 Key
    };
    if (!iv.aiCfg.base && !iv.aiCfg.key) delete iv.aiCfg;
    persist();
    send(res, 200, { ok: true, aiStatus: aiStatus(iv) });
  },

  // 移除误加入的评委（含其评分）
  'POST /api/judge/delete': async (req, res) => {
    const b = await readBody(req);
    const iv = findById(b.interviewId);
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const j = iv.judges.find((x) => x.id === b.judgeId);
    if (!j) return send(res, 400, { ok: false, error: '评委不存在' });
    if (j.isHost) return send(res, 400, { ok: false, error: '不能移除主持人' });
    iv.judges = iv.judges.filter((x) => x.id !== b.judgeId);
    for (const candId of Object.keys(iv.scores)) { if (iv.scores[candId]) delete iv.scores[candId][b.judgeId]; }
    persist();
    send(res, 200, { ok: true });
  },

  'POST /api/score': async (req, res) => {
    const b = await readBody(req);
    const iv = normalizeInterview(findById(b.interviewId));
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    const cand = iv.candidates.find((c) => c.id === b.candidateId);
    const judge = iv.judges.find((j) => j.id === b.judgeId);
    const isGeneral = b.dimId === '__general__';
    const dim = isGeneral ? { id: '__general__' } : iv.dimensions.find((d) => d.id === b.dimId);
    const roundId = b.roundId && iv.rounds.some((r) => r.id === b.roundId) ? b.roundId : iv.activeRound;
    if (!cand || !judge || !dim) return send(res, 400, { ok: false, error: '参数错误' });
    let value = b.value;
    value = (value === '' || value == null || isNaN(Number(value))) ? null : Math.max(0, Math.min(DIM_SCALE, Number(value)));
    const cj = (iv.scores[cand.id][judge.id] = iv.scores[cand.id][judge.id] || {});
    const cr = (cj[roundId] = cj[roundId] || {});
    const prev = cr[dim.id] || {};
    cr[dim.id] = {
      value: isGeneral ? null : (value === null ? (prev.value === undefined ? null : prev.value) : value),
      note: b.note !== undefined ? sanitizeText(b.note, 2000) : (prev.note || ''),
      updatedAt: Date.now(),
    };
    persist();
    send(res, 200, { ok: true });
  },

  'POST /api/import': async (req, res) => {
    const b = await readBody(req, 45e6);
    const src = b.interview;
    if (!src || !src.id) return send(res, 400, { ok: false, error: '导入数据格式不正确' });
    let iv = normalizeInterview(JSON.parse(JSON.stringify(src)));
    if (findById(iv.id)) iv.id = uid();
    if (!iv.code || findByCode(iv.code)) iv.code = genCode();
    db.interviews[iv.id] = iv;
    persist();
    send(res, 200, { ok: true, interviewId: iv.id, code: iv.code, hostId: iv.hostId });
  },

  // 轻量导出（不含简历文件，仅元信息）
  'GET /api/export': (req, res, q) => {
    const iv = normalizeInterview(findById(q.get('id')));
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    send(res, 200, { ok: true, exportedAt: new Date().toISOString(), interview: publicInterview(iv), summary: summarize(iv) });
  },

  // 完整备份（含简历文件 base64、决策、部门篓、评分、备注）——用于换机/重开恢复
  'GET /api/backup': (req, res, q) => {
    const iv = normalizeInterview(findById(q.get('id')));
    if (!iv) return send(res, 404, { ok: false, error: '面试不存在' });
    send(res, 200, {
      ok: true, kind: 'interview-desk-backup', version: 1,
      exportedAt: new Date().toISOString(),
      interview: iv, summary: summarize(iv),
    });
  },

  // AI 转发：服务端代发，绕开浏览器 CORS；Key 仅本次透传、不落库
  'POST /api/ai': async (req, res) => {
    const b = await readBody(req);
    const stored = (findById(b.interviewId) || {}).aiCfg || {};
    const base = String(b.base || stored.base || '').replace(/\/+$/, '');
    const key = String(b.key || stored.key || '');
    const model = String(b.model || stored.model || '');
    const prompt = String(b.prompt || '');
    if (!base || !key) return send(res, 400, { ok: false, error: '未填写接口地址或 Key' });
    let proto = b.protocol || stored.protocol || 'auto';
    if (proto === 'auto') proto = /anthropic/i.test(base) ? 'anthropic' : 'openai';
    try {
      let url, headers, body;
      if (proto === 'anthropic') {
        url = base.replace(/\/v1\/messages$/, '') + '/v1/messages';
        headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        body = { model: model || 'claude-3-5-haiku-latest', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] };
      } else {
        url = base.replace(/\/chat\/completions$/, '') + '/chat/completions';
        headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + key };
        body = { model: model || 'gpt-4o-mini', temperature: 0.3, messages: [{ role: 'user', content: prompt }] };
      }
      const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const j = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return send(res, 502, { ok: false, error: '上游 ' + upstream.status + '：' + ((j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 160)) });
      let text = '';
      if (proto === 'anthropic') text = (j.content && j.content[0] && j.content[0].text) || '';
      else text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      send(res, 200, { ok: true, text });
    } catch (e) {
      send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  },
};

/* --------------------------- 磁盘快照（尽力持久） --------------------------- */
const SNAPSHOT = path.join(__dirname, 'data.snapshot.json');
function persist() { try { fs.writeFileSync(SNAPSHOT, JSON.stringify({ interviews: db.interviews })); } catch (e) {} }
function restore() {
  try {
    if (fs.existsSync(SNAPSHOT)) {
      const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      if (raw && raw.interviews) for (const [k, v] of Object.entries(raw.interviews)) db.interviews[k] = normalizeInterview(v);
    }
  } catch (e) {}
}

/* ----------------------------- 静态文件服务 ----------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel).replace(/\.\./g, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 兜底：非静态资源路径（无扩展名）一律返回首页，避免地址栏杂字符导致 not found
      if (!ext) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(b2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${u.pathname}`;
  if (u.pathname.startsWith('/api/')) {
    const h = routes[key];
    if (!h) return send(res, 404, { ok: false, error: 'no such api' });
    try { await h(req, res, u.searchParams); } catch (e) { send(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  return serveStatic(req, res, u.pathname);
});

restore();
server.listen(PORT, HOST, () => console.log(`面评台 server listening on http://${HOST}:${PORT}`));
