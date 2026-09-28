/**
 * run-tests.js —— 考勤表助手 index.html 质量验证套件
 * 用法： node tests/run-tests.js
 * 不修改 index.html；如需修 bug 会单独说明。
 */
'use strict';

/* 可选：node tests/run-tests.js --html dist/index.html
   默认仍为仓库根目录 index.html，保持历史行为不变。 */
(function () {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--html');
  if (i !== -1 && argv[i + 1]) process.env.APP_HTML = argv[i + 1];
})();

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadApp } = require('./harness');

const results = [];
function ok(id, name, cond, detail) {
  results.push({ id, name, pass: !!cond, detail: detail || '' });
}
function eq(id, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(id, name, a === e, '期望 ' + e + ' / 实际 ' + a);
}

/* ============================ 加载应用 ============================ */
let app;
try {
  app = loadApp();
  ok('S00', '内联脚本可在 Node 沙箱中加载并执行', true);
} catch (e) {
  ok('S00', '内联脚本可在 Node 沙箱中加载并执行', false, e.message);
  console.error(e);
  process.exit(1);
}
const A = app.api;
const elc = (sel) => app.elCache.get(sel);

/** 重置为一份干净的全局 state */
function freshState(overrides) {
  const s = A.defaultState();
  Object.assign(s, overrides || {});
  A._setState(s);
  return s;
}

/* ============================ 1. 周次换算 ============================ */
freshState();
eq('W01', 'weekOfDate(2026-08-17) === 1（第1周周一）', A.weekOfDate('2026-08-17'), 1);
eq('W02', 'weekOfDate(2026-09-14) === 5（第5周周一）', A.weekOfDate('2026-09-14'), 5);
eq('W03', 'weekOfDate(2026-09-19) === 5（第5周周六仍属第5周）', A.weekOfDate('2026-09-19'), 5);
eq('W04', 'weekOfDate(2026-09-18) === 5（第5周周五）', A.weekOfDate('2026-09-18'), 5);
// 周定义为 周一~周日，故第5周 = 09-14(一) ~ 09-20(日)
eq('W05', 'weekOfDate(2026-09-20) === 5（第5周周日仍属第5周）', A.weekOfDate('2026-09-20'), 5);
eq('W05b', 'weekOfDate(2026-09-21) === 6（次周周一进入第6周）', A.weekOfDate('2026-09-21'), 6);
eq('W06', 'weekMonday(1) === 2026-08-17', A.weekMonday(1), '2026-08-17');
eq('W07', 'weekMonday(5) === 2026-09-14', A.weekMonday(5), '2026-09-14');

{
  const ds = A.weekDays(5);
  eq('W08', 'weekDays(5) 首日 = 2026-09-14', ds[0].date, '2026-09-14');
  eq('W09', 'weekDays(5) 周五 = 2026-09-18', ds[4].date, '2026-09-18');
  eq('W10', 'weekDays(5) 共 7 天，末日 = 2026-09-20（周日）', ds[6].date, '2026-09-20');
  eq('W11', 'weekDays(5) 周一 dow = 1 且标签「星期一」', [ds[0].dow, ds[0].label], [1, '星期一']);
  eq('W12', 'weekDays(5) 周五 dow = 5 且标签「星期五」', [ds[4].dow, ds[4].label], [5, '星期五']);
  eq('W13', 'weekDays(5) dow 序列 1..7', ds.map(d => d.dow).join(','), '1,2,3,4,5,6,7');
  eq('W14', '第5周周一~周五日期序列', ds.slice(0, 5).map(d => d.date).join(','),
    '2026-09-14,2026-09-15,2026-09-16,2026-09-17,2026-09-18');
}
{
  // 真实日历对齐：开学日必须是周一，否则「星期二」列会与真实星期错位
  eq('W15', 'dayOfWeek(2026-08-17) === 1（开学日确为周一）', A.dayOfWeek('2026-08-17'), 1);
  eq('W16', 'dayOfWeek(2026-09-14) === 1（第5周周一确为周一）', A.dayOfWeek('2026-09-14'), 1);
  eq('W17', 'dayOfWeek(2026-09-15) === 2（09-15 确为周二）', A.dayOfWeek('2026-09-15'), 2);
  eq('W18', 'dayOfWeek(2026-09-18) === 5（09-18 确为周五）', A.dayOfWeek('2026-09-18'), 5);
}

/* ============================ 2. 节次表达式解析 ============================ */
eq('P01', "parsePeriods('3')   → [3]", A.parsePeriods('3'), [3]);
eq('P02', "parsePeriods('5-6') → [5,6]", A.parsePeriods('5-6'), [5, 6]);
eq('P03', "parsePeriods('1,2') → [1,2]", A.parsePeriods('1,2'), [1, 2]);
eq('P04', "parsePeriods('1-2,7') → [1,2,7]", A.parsePeriods('1-2,7'), [1, 2, 7]);
eq('P05', "parsePeriods('')   → []", A.parsePeriods(''), []);
eq('P06', "parsePeriods('11') → []（越界丢弃）", A.parsePeriods('11'), []);
eq('P07', "parsePeriods('3-12') → [3..10]（上限裁剪）", A.parsePeriods('3-12'), [3, 4, 5, 6, 7, 8, 9, 10]);
eq('P08', "parsePeriods('9,10') → [9,10]", A.parsePeriods('9,10'), [9, 10]);
eq('P09', "parsePeriods('5－6') 全角横杠 → [5,6]", A.parsePeriods('5－6'), [5, 6]);

/* ============================ 3. 默认数据正确性 ============================ */
{
  const sch = A.defaultSchedule();
  const flat = {};
  Object.keys(sch).forEach(dow => sch[dow].forEach(it => {
    A.parsePeriods(it.p).forEach(p => { flat[dow + '-' + p] = it; });
  }));
  const at = (k) => flat[k] ? flat[k].course + ' | ' + flat[k].place : null;
  eq('C01', '周一第3节 = 实变函数 @A2-A203', at('1-3'), '实变函数 | 大学城南校区 A2-A203');
  eq('C02', '周一第5节 = 习概论 @A2-D233', at('1-5'), '习近平新时代中国特色社会主义思想概论 | A2-D233');
  eq('C03', '周一第6节 = 习概论 @A2-D233', at('1-6'), '习近平新时代中国特色社会主义思想概论 | A2-D233');
  eq('C04', '周二第1节 = 大学物理实验A类 @A11-A508', at('2-1'), '大学物理实验A类（电磁学实验室2） | A11-A508');
  eq('C05', '周二第2节 = 大学物理实验A类 @A11-A508', at('2-2'), '大学物理实验A类（电磁学实验室2） | A11-A508');
  eq('C06', '周二第5节 = 近世代数 @A2-A203', at('2-5'), '近世代数 | A2-A203');
  eq('C07', '周二第7节 = 概率论 @A2-A203', at('2-7'), '概率论 | A2-A203');
  eq('C08', '周三第3节 = 实变函数 @A2-A203', at('3-3'), '实变函数 | A2-A203');
  eq('C09', '周三第5、6节 = 近世代数 @A2-A203', [at('3-5'), at('3-6')], ['近世代数 | A2-A203', '近世代数 | A2-A203']);
  eq('C10', '周四第1、2节 = 大学物理b @A2-B207', [at('4-1'), at('4-2')], ['大学物理b | A2-B207', '大学物理b | A2-B207']);
  eq('C11', '周四第5、6节 = 习概论 @A2-C122', [at('4-5'), at('4-6')],
    ['习近平新时代中国特色社会主义思想概论 | A2-C122', '习近平新时代中国特色社会主义思想概论 | A2-C122']);
  eq('C12', '周五第1、2节 = 概率论 @A2-A203', [at('5-1'), at('5-2')], ['概率论 | A2-A203', '概率论 | A2-A203']);
  eq('C13', '周五第3、4节 = 大学物理b @A2-B207', [at('5-3'), at('5-4')], ['大学物理b | A2-B207', '大学物理b | A2-B207']);

  const per = A.defaultPeriods();
  eq('C14', '节次1 = 08:30-09:15', per[0].start + '-' + per[0].end, '08:30-09:15');
  eq('C15', '节次2 = 09:25-10:10', per[1].start + '-' + per[1].end, '09:25-10:10');
  eq('C16', '节次5 = 14:30-15:15', per[4].start + '-' + per[4].end, '14:30-15:15');
  eq('C17', '节次10 = 19:55-20:40', per[9].start + '-' + per[9].end, '19:55-20:40');

  const hol = A.defaultHolidays();
  eq('C18', '默认节假日共 8 条（中秋1 + 国庆7）', hol.length, 8);
  eq('C19', '含 2026-09-25 中秋节', hol.filter(h => h.date === '2026-09-25').map(h => h.name), ['中秋节']);
  eq('C20', '含 2026-10-01~10-07 国庆节', hol.filter(h => h.name === '国庆节').map(h => h.date),
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
}
{
  freshState();
  const schMap = A.buildScheduleMap();
  eq('H01', 'hasClass 周一第3节 = true', A.hasClass('2026-09-14', 1, 3, schMap), true);
  eq('H02', 'hasClass 周一第1节 = false', A.hasClass('2026-09-14', 1, 1, schMap), false);
  eq('H03', 'hasClass 周二第7节 = true', A.hasClass('2026-09-15', 2, 7, schMap), true);
  eq('H04', 'holidayOf(2026-09-25) = 中秋节', A.holidayOf('2026-09-25'), '中秋节');
  eq('H05', 'holidayOf(2026-10-05) = 国庆节', A.holidayOf('2026-10-05'), '国庆节');
  eq('H06', 'holidayOf(2026-09-15) = null（非假日）', A.holidayOf('2026-09-15'), null);
  eq('H07', '节假日当天 hasClass = false（09-25 周五第1节本有课）',
    A.hasClass('2026-09-25', 5, 1, schMap), false);
}

/* ============================ 4. 自动标记 ============================ */
const STU = ['张X', '李四', '王五'];

/** 构造请假记录并计算第5周自动标记 */
function autoMarksFor(leave) {
  const s = freshState({ students: STU.slice(), week: 5 });
  s.leaves = [Object.assign({
    id: 'L1', name: '张X', sid: '', college: '', className: '',
    type: '病假', approve: '通过',
    start: '2026-09-15T08:30', end: '2026-09-15T10:10', days: '1天', raw: ''
  }, leave)];
  return { marks: A.computeAutoMarks(5), idx: A.findStudentIndex('张X'), state: s };
}

{
  const r = autoMarksFor({});
  eq('A01', '「张X」在名单中索引 = 0', r.idx, 0);
  eq('A02', '病假 09-15 08:30~10:10 通过 → 命中第5周 Tuesday 第1、2节',
    Object.keys(r.marks).sort(), ['0-2-1', '0-2-2']);
  eq('A03', '周二第1节 = ○', r.marks['0-2-1'], '○');
  eq('A04', '周二第2节 = ○', r.marks['0-2-2'], '○');
  ok('A05', '周二第5节未被误标', !('0-2-5' in r.marks), '实际键: ' + Object.keys(r.marks).sort().join(','));
  ok('A06', '其他学生（李四/王五）不被连带标记',
    !Object.keys(r.marks).some(k => /^[12]-/.test(k)), '实际: ' + Object.keys(r.marks).join(','));
}
{
  const r = autoMarksFor({ approve: '驳回' });
  eq('A07', '审批=驳回 → 不产生任何自动标记', Object.keys(r.marks).length, 0);
}
{
  const r = autoMarksFor({ approve: '不同意' });
  eq('A08', '审批=不同意 → 不产生任何自动标记', Object.keys(r.marks).length, 0);
}
{
  const r = autoMarksFor({ approve: '待定' });
  eq('A09', '审批=待定 → 不产生任何自动标记', Object.keys(r.marks).length, 0);
}
{
  const r = autoMarksFor({ start: '2026-09-25T08:30', end: '2026-09-25T10:10' });
  eq('A10', '日期改到 2026-09-25（中秋节）→ 不标记', Object.keys(r.marks).length, 0);
}
{
  const r = autoMarksFor({ start: '2026-10-01T08:30', end: '2026-10-01T10:10' });
  eq('A11', '日期改到 2026-10-01（国庆）→ 不标记', Object.keys(r.marks).length, 0);
}
{
  const r = autoMarksFor({ start: '2026-09-15T08:30', end: '2026-09-15T15:15' });
  eq('A12', '09-15 08:30~15:15 → 命中第1、2、5节',
    Object.keys(r.marks).sort(), ['0-2-1', '0-2-2', '0-2-5']);
}
{
  const s = freshState({ students: STU.slice(), week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', type: '事假', approve: '通过', start: '2026-09-22T08:30', end: '2026-09-22T10:10' }];
  eq('A13', '第6周(09-22)的假不会串到第5周', Object.keys(A.computeAutoMarks(5)).length, 0);
  eq('A14', '第6周(09-22)的假正确落在第6周',
    Object.keys(A.computeAutoMarks(6)).sort(), ['0-2-1', '0-2-2']);
}
{
  const s = freshState({ students: ['李四'], week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', approve: '通过', start: '2026-09-15T08:30', end: '2026-09-15T10:10' }];
  eq('A15', '请假人不在名单 → 不标记', Object.keys(A.computeAutoMarks(5)).length, 0);
}
{
  const r = autoMarksFor({ start: '2026-09-15T10:30', end: '2026-09-15T11:15' });
  eq('A16', '无课时段（周二第3节）→ 不标记', Object.keys(r.marks).length, 0);
}
{
  // 边界：恰好衔接不算重叠（10:10 结束 vs 第2节 09:25 开始 → 仍算重叠）
  const r = autoMarksFor({ start: '2026-09-15T10:10', end: '2026-09-15T10:30' });
  eq('A17', '仅覆盖课间(10:10~10:30) → 不标记任何节', Object.keys(r.marks).length, 0);
}
{
  // 跨天请假应覆盖多天
  const s = freshState({ students: ['张X'], week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', approve: '通过', start: '2026-09-14T00:00', end: '2026-09-18T23:59' }];
  const keys = Object.keys(A.computeAutoMarks(5)).sort();
  // 本周有课单元格总数 = 周一3 + 周二4 + 周三3 + 周四4 + 周五4 = 18
  eq('A18', '整周请假(09-14~09-18) → 命中全部 18 节有课单元格', keys.length, 18);
  ok('A19', '整周请假覆盖周一至周五', keys.some(k => k.startsWith('0-1-')) && keys.some(k => k.startsWith('0-5-')),
    keys.join(','));
}

/* ============================ 5. 时间写法兼容 ============================ */
const RAW_TPL = (timeLine) =>
  '请假条\n' +
  '姓名：张三  学号：2024TEST\n' +
  '学院：数据科学与信息工程学院  班级：24数学与应用数学2班\n' +
  '请假类型：病假\n' +
  '请假时间：' + timeLine + '\n' +
  '请假天数：1天\n' +
  '审批结果：通过\n';

function parseTime(timeLine) {
  const t = A.normalizeText(RAW_TPL(timeLine));
  const f = { start: '', end: '' };
  A.parseLeaveRange(t, f);
  return f;
}
{
  const f = parseTime('2026-09-17 08:30 至 2026-09-17 13:40');
  eq('T01', '写法A 完整起止 → start = 2026-09-17T08:30', f.start, '2026-09-17T08:30');
  eq('T02', '写法A 完整起止 → end   = 2026-09-17T13:40', f.end, '2026-09-17T13:40');
}
{
  const f = parseTime('2026-09-17 08:30~13:40');
  eq('T03', '写法B 省略第二个日期 → start = 2026-09-17T08:30', f.start, '2026-09-17T08:30');
  eq('T04', '写法B 省略第二个日期 → end   = 2026-09-17T13:40', f.end, '2026-09-17T13:40');
}
{
  const f = parseTime('2026-09-17 至 2026-09-18');
  eq('T05', '写法C 纯日期区间 → start = 2026-09-17T00:00', f.start, '2026-09-17T00:00');
  eq('T06', '写法C 纯日期区间 → end   = 2026-09-18T23:59', f.end, '2026-09-18T23:59');
}
{
  const f = parseTime('2026-09-17');
  eq('T07', '写法D 单个纯日期 → start = 2026-09-17T00:00', f.start, '2026-09-17T00:00');
  eq('T08', '写法D 单个纯日期 → end   = 2026-09-17T23:59', f.end, '2026-09-17T23:59');
}
{
  const f = parseTime('2026年9月17日 08:30 至 2026年9月17日 13:40');
  eq('T09', '写法E 中文年月日 → start = 2026-09-17T08:30', f.start, '2026-09-17T08:30');
  eq('T10', '写法E 中文年月日 → end   = 2026-09-17T13:40', f.end, '2026-09-17T13:40');
}
{
  const full = A.extractFields(RAW_TPL('2026-09-17 08:30~13:40'));
  eq('T11', '字段抽取：姓名 = 张三', full.name, '张三');
  eq('T12', '字段抽取：学号 = 2024TEST', full.sid, '2024TEST');
  eq('T13', '字段抽取：班级 = 24数学与应用数学2班', full.className, '24数学与应用数学2班');
  eq('T14', '字段抽取：学院 = 数据科学与信息工程学院', full.college, '数据科学与信息工程学院');
  eq('T15', '字段抽取：类型 = 病假', full.type, '病假');
  eq('T16', '字段抽取：审批 = 通过', full.approve, '通过');
  eq('T17', '字段抽取：天数 = 1', full.days, '1');
}
{
  const rej = A.extractFields(RAW_TPL('2026-09-17').replace('审批结果：通过', '审批结果：驳回'));
  eq('T18', '审批=驳回 文本 → approve 归一为「驳回」', rej.approve, '驳回');
}
{
  // 纯日期请假应覆盖整天有课节次：09-17 周四 → 第1、2、5、6节
  const s = freshState({ students: ['张三'], week: 5 });
  s.leaves = [{ id: 'L1', name: '张三', approve: '通过', start: '2026-09-17T00:00', end: '2026-09-17T23:59' }];
  eq('T19', '纯日期请假(09-17 周四) → 命中第1、2、5、6节',
    Object.keys(A.computeAutoMarks(5)).sort(), ['0-4-1', '0-4-2', '0-4-5', '0-4-6']);
}

/* ============================ 6. 手动标记循环 / 覆盖 / 删除 ============================ */
{
  const s = freshState({ students: STU.slice(), week: 5 });
  const seq = [A.getMark(5, 0, 1, 3, {})];
  for (let i = 0; i < 5; i++) { A.cycleMark(0, 1, 3); seq.push(A.getMark(5, 0, 1, 3, {})); }
  eq('M01', '手动循环 空→○→+→—→Δ→空', seq, ['', '○', '+', '—', 'Δ', '']);
}
{
  const s = freshState({ students: STU.slice(), week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', approve: '通过', start: '2026-09-15T08:30', end: '2026-09-15T10:10' }];
  const auto = A.computeAutoMarks(5);
  eq('M02', '自动标记为 ○', A.getMark(5, 0, 2, 1, auto), '○');
  A.cycleMark(0, 2, 1);
  eq('M03', '手动点1次 → +（覆盖自动 ○）', A.getMark(5, 0, 2, 1, A.computeAutoMarks(5)), '+');
  A.cycleMark(0, 2, 1);
  eq('M04', '手动点2次 → —', A.getMark(5, 0, 2, 1, A.computeAutoMarks(5)), '—');
  A.cycleMark(0, 2, 1);
  eq('M05', '手动点3次 → Δ', A.getMark(5, 0, 2, 1, A.computeAutoMarks(5)), 'Δ');
  A.cycleMark(0, 2, 1);
  eq('M06', '手动点4次 → 空（手动显式清空，屏蔽自动 ○）',
    A.getMark(5, 0, 2, 1, A.computeAutoMarks(5)), '');
  A.cycleMark(0, 2, 1);
  eq('M07', '手动点5次 → 回到 ○', A.getMark(5, 0, 2, 1, A.computeAutoMarks(5)), '○');
}
{
  const s = freshState({ students: ['甲', '乙', '丙', '丁'], week: 5 });
  s.marks['w5'] = { '0-1-3': '○', '1-2-5': '+', '2-3-1': '—', '3-4-6': 'Δ' };
  A.deleteStudentRow(1);                                        // 删除「乙」
  eq('M08', '删除第2行后名单 = [甲,丙,丁]', s.students, ['甲', '丙', '丁']);
  eq('M09', '甲(原0)标记仍在第0行', s.marks['w5']['0-1-3'], '○');
  eq('M10', '丙(原2)标记前移到第1行', s.marks['w5']['1-3-1'], '—');
  eq('M11', '丁(原3)标记前移到第2行', s.marks['w5']['2-4-6'], 'Δ');
  eq('M12', '被删行(乙)的标记已清除', s.marks['w5']['1-2-5'], undefined);
  eq('M13', '无残留越界行索引', Object.keys(s.marks['w5']).filter(k => /^3-/.test(k)), []);
  eq('M14', '标记总数 4 → 3', Object.keys(s.marks['w5']).length, 3);
}
{
  const s = freshState({ students: ['甲', '乙', '丙'], week: 5 });
  s.marks['w5'] = { '0-1-3': '○', '1-2-5': '+', '2-3-1': '—' };
  A.deleteStudentRow(0);
  eq('M15', '删除首行后名单 = [乙,丙]', s.students, ['乙', '丙']);
  eq('M16', '删除首行后标记整体前移', [s.marks['w5']['0-2-5'], s.marks['w5']['1-3-1']], ['+', '—']);
}
{
  const s = freshState({ students: ['甲', '乙', '丙'], week: 5 });
  s.marks['w5'] = { '0-1-3': '○', '2-3-1': '—' };
  A.deleteStudentRow(2);
  eq('M17', '删除末行后名单 = [甲,乙]', s.students, ['甲', '乙']);
  eq('M18', '删除末行后其余标记不变', s.marks['w5']['0-1-3'], '○');
  eq('M19', '删除末行后无残留', Object.keys(s.marks['w5']).length, 1);
}
{
  // 删除后自动标记应随新索引重算（不串行）
  const s = freshState({ students: ['甲', '乙', '丙'], week: 5 });
  s.leaves = [{ id: 'L1', name: '丙', approve: '通过', start: '2026-09-15T08:30', end: '2026-09-15T10:10' }];
  eq('M20', '删除前「丙」(idx2)被标记', Object.keys(A.computeAutoMarks(5)).sort(), ['2-2-1', '2-2-2']);
  A.deleteStudentRow(0);                                        // 删掉「甲」，丙变 idx1
  eq('M21', '删除首行后自动标记随新索引重算到 idx1',
    Object.keys(A.computeAutoMarks(5)).sort(), ['1-2-1', '1-2-2']);
}

/* ============================ 7. 静态检查 ============================ */
{ /* node --check */
  const tmp = path.join(os.tmpdir(), 'inline-' + Date.now() + '.js');
  fs.writeFileSync(tmp, app.code, 'utf8');
  let err = '';
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) { err = (e.stderr || '').toString().trim(); }
  fs.unlinkSync(tmp);
  ok('S01', '内联 JS 通过 node --check 语法校验', !err, err);
}
{ /* DOM id 引用 vs 定义 */
  const html = app.html;
  const defined = new Set();
  const dre = /\sid\s*=\s*["']([^"']+)["']/g;
  let m; while ((m = dre.exec(html)) !== null) defined.add(m[1]);

  const referenced = new Set();
  const rre = /\$\(\s*['"]#([\w-]+)['"]\s*\)/g;
  while ((m = rre.exec(app.code)) !== null) referenced.add(m[1]);
  const rre2 = /querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g;
  while ((m = rre2.exec(app.code)) !== null) referenced.add(m[1]);

  const missing = Array.from(referenced).filter(id => !defined.has(id));
  ok('S02', 'JS 中引用的 #id 均已在 HTML 中定义（共 ' + referenced.size + ' 个引用）',
    missing.length === 0, '缺失: ' + missing.join(', '));
}
{ /* 标签平衡 */
  const html = app.html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
  const stack = [];
  const errs = [];
  const tre = /<(\/?)([a-zA-Z!][\w:-]*)\b([^>]*)>/g;
  let m;
  while ((m = tre.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (VOID.has(tag) || attrs.trim().endsWith('/')) continue;
    if (!closing) stack.push({ tag, at: m.index });
    else {
      if (!stack.length) { errs.push('多余的 </' + tag + '> @' + m.index); continue; }
      const top = stack.pop();
      if (top.tag !== tag) errs.push('不匹配: <' + top.tag + '> 被 </' + tag + '> 关闭 @' + m.index);
    }
  }
  stack.forEach(s => errs.push('未闭合 <' + s.tag + '> @' + s.at));
  ok('S03', 'HTML 标签闭合平衡', errs.length === 0, errs.slice(0, 6).join(' | '));
}
{ /* 未定义函数调用粗检 */
  const code = app.code;
  const declared = new Set();
  let m;
  const dre = /function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = dre.exec(code)) !== null) declared.add(m[1]);
  const dre2 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = dre2.exec(code)) !== null) declared.add(m[1]);
  const dre3 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = dre3.exec(code)) !== null) declared.add(m[1]);
  // 解构 / 逗号声明
  const dre4 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*,/g;
  while ((m = dre4.exec(code)) !== null) declared.add(m[1]);

  // 函数形参（含回调形参、箭头函数形参）
  const paramSources = [];
  let pm;
  const pf1 = /function\s*[A-Za-z0-9_$]*\s*\(([^)]*)\)/g;
  while ((pm = pf1.exec(code)) !== null) paramSources.push(pm[1]);
  const pf2 = /=\s*(?:async\s*)?(?:\(([^)]*)\)|\b([A-Za-z_$][\w$]*))\s*=>/g;
  while ((pm = pf2.exec(code)) !== null) paramSources.push(pm[1] || pm[2] || '');
  paramSources.forEach(function (group) {
    group.split(',').forEach(function (one) {
      const idm = /([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(one.trim());
      if (idm) declared.add(idm[1]);
    });
  });

  const BUILTIN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
    'function', 'else', 'do', 'try', 'new', 'delete', 'void', 'in', 'of', 'await', 'async',
    'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
    'RegExp', 'Error', 'Map', 'Set', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    // 浏览器宿主全局（离线改造后新增的图像预处理依赖）
    'Image', 'ImageBitmap', 'createImageBitmap', 'OffscreenCanvas', 'FileReader',
    'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
    'Int32Array', 'Float32Array', 'Float64Array', 'DataView', 'ArrayBuffer',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'alert', 'confirm', 'prompt',
    'encodeURIComponent', 'decodeURIComponent', 'URL', 'Blob', 'FileReader', 'XLSX', 'Tesseract',
    'console', 'document', 'window', 'localStorage', 'require', 'module', 'exports', 'globalThis']);
  const called = new Set();
  const cre = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = cre.exec(code)) !== null) called.add(m[2]);
  const props = new Set();
  const propRe = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = propRe.exec(code)) !== null) props.add(m[1]);

  const undef = Array.from(called).filter(n =>
    !declared.has(n) && !BUILTIN.has(n) && !props.has(n));
  ok('S04', '内联 JS 中无明显未定义的函数调用', undef.length === 0, '疑似: ' + undef.join(', '));
}
{
  /* 资源引入方式：新版为「本地 vendor 离线」，旧版为「CDN 在线」，二者其一即可。
     严格禁止远程外链的断言放在 tests/test-offline.js（只对 dist 生效）。 */
  const html = app.html;
  const localTess = /<script[^>]+src=["'][^"']*vendor\/tesseract\/tesseract\.min\.js["']/i.test(html);
  const localXlsx = /<script[^>]+src=["'][^"']*vendor\/xlsx\.full\.min\.js["']/i.test(html);
  const cdnTess = /tesseract\.js@5/.test(html);
  const cdnXlsx = /xlsx@0\.18\.5/.test(html);
  ok('S05', 'OCR 引擎已引入（本地 vendor/tesseract 或 CDN tesseract.js@5 二选一）',
    localTess || cdnTess, 'local=' + localTess + ' cdn=' + cdnTess);
  ok('S06', 'Excel 组件已引入（本地 vendor/xlsx 或 CDN xlsx@0.18.5 二选一）',
    localXlsx || cdnXlsx, 'local=' + localXlsx + ' cdn=' + cdnXlsx);
  const wildRefs = html.match(
    /(?:href|src)\s*=\s*["'](?!https?:|#|data:|\.\/|vendor\/|manifest\.webmanifest|icons\/)[^"']+\.(?:css|js)["']/gi) || [];
  ok('S07', '外链 css/js 均为受控来源（CDN https 或本地相对路径）',
    wildRefs.length === 0, '越界引用: ' + wildRefs.join(', '));
  eq('S08', '考勤符号顺序 ["", "○", "+", "—", "Δ"]', A.SYMBOLS, ['', '○', '+', '—', 'Δ']);
  eq('S09', 'SYMBOL_NAME 映射正确', A.SYMBOL_NAME, { '○': '请假', '+': '迟到', '—': '早退', 'Δ': '旷课' });
  eq('S10', '默认第1周周一 = 2026-08-17', A.defaultState().termStart, '2026-08-17');
  eq('S11', '默认总周数 = 20', A.defaultState().weeks, 20);
  ok('S12', 'HTML 含注释行模板文案（A6-308）', /A6-308/.test(html));
}

/* ============================ 8. 边界 / 渲染 ============================ */
function tbodyRows() {
  const html = elc('#tableHost').innerHTML;
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  return (body.match(/<tr>/g) || []).length;
}
{
  const names = []; for (let i = 1; i <= 20; i++) names.push('学生' + i);
  freshState({ students: names, headcount: 20, week: 5 });
  A.renderSheet();
  eq('B01', '20 名学生 → 表格 20 行（非固定 15 行）', tbodyRows(), 20);
}
{
  const names = []; for (let i = 1; i <= 6; i++) names.push('学' + i);
  freshState({ students: names, headcount: 6, week: 5 });
  A.renderSheet();
  eq('B02', '6 名学生 → 表格 6 行', tbodyRows(), 6);
}
{
  freshState({ students: [], headcount: 0, week: 5 });
  let threw = null;
  try { A.renderSheet(); } catch (e) { threw = e.message; }
  ok('B03', '空名单（0 人）渲染不抛异常', !threw, threw || '');
  eq('B04', '空名单（0 人）→ 0 行', tbodyRows(), 0);
}
{
  freshState({ students: [''], headcount: 1, week: 5 });
  A.renderSheet();
  eq('B05', '名单 1 个空位 → 1 行', tbodyRows(), 1);
}
{
  // 名单 20 人但 headcount 仍为 49 → 应取较大值 49
  const names = []; for (let i = 1; i <= 20; i++) names.push('学' + i);
  freshState({ students: names, headcount: 49, week: 5 });
  A.renderSheet();
  eq('B06', '名单20人 + 应到49人 → 49 行（保留手填空行）', tbodyRows(), 49);
}
{
  freshState({ students: ['甲'], headcount: 1, week: 5 });
  A.renderSheet();
  const html = elc('#tableHost').innerHTML;
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  eq('B07', '表头两行', head.split('<tr').length - 1, 2);
  eq('B08', '第一行含 5 个星期表头', (head.match(/<th[^>]*day-head[^>]*>/g) || []).length, 5);
  const pRow = head.slice(head.indexOf('p-head-row'));
  eq('B09', '第二行含 50 个节次表头（5天×10节）', (pRow.match(/<th/g) || []).length, 50);
  ok('B10', '表头含「负责人签字」', /负责人签字/.test(head));
  ok('B11', '表头含「序号」「姓名」', /序号/.test(head) && /姓名/.test(head));
  eq('B12', '每行 53 个单元格（1+1+50+1）',
    (html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>')).match(/<td/g) || []).length, 53);
}
{
  freshState({ students: ['甲'], week: 5 });
  A.renderSheet();
  const title = elc('#sheetTitle').textContent;
  const sub = elc('#sheetSub').textContent;
  ok('B13', '标题含「上课考勤表」', /上课考勤表/.test(title), title);
  ok('B14', '副标题含「第   5   周」', /第\s*5\s*周/.test(sub), sub);
  ok('B15', '副标题含 2026 年 09 月 14 日 ~ 09 月 18 日',
    /2026/.test(sub) && /09/.test(sub) && /14/.test(sub) && /18/.test(sub), sub);
  ok('B16', '副标题含班级与人数', /24数学与应用数学2班/.test(sub) && /49/.test(sub), sub);
}
{
  freshState({ students: ['甲', '张X'], week: 5 });
  const s = freshState({ students: ['甲', '张X'], week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', type: '病假', approve: '通过', start: '2026-09-15T08:30', end: '2026-09-15T10:10' }];
  A.renderSheet();
  const html = elc('#tableHost').innerHTML;
  ok('B17', '渲染结果含 s-leave 样式（自动 ○ 已上色）', /s-leave/.test(html));
  ok('B18', '渲染结果含 has-class 有课单元格', /has-class/.test(html));
  ok('B19', '特殊情况说明含请假记录', /张X/.test(elc('#specialNote').textContent),
    elc('#specialNote').textContent);
}
{
  freshState({ students: ['甲'], week: 6, headcount: 1 });
  A.renderSheet();
  const html = elc('#tableHost').innerHTML;
  ok('B20', '第6周渲染含 holiday 单元格（09-25 中秋）', /class="[^"]*holiday/.test(html));
  ok('B21', '第6周表头标注「中秋节放假」', /中秋节放假/.test(html));
}
{
  freshState({ students: ['甲'], week: 5 });
  A.renderWeekSelect();
  const opts = elc('#weekSel').innerHTML;
  ok('B22', '周下拉渲染 20 个选项', (opts.match(/<option/g) || []).length, 20);
  ok('B23', '第5周选项标签为 09-14 ~ 09-18', /第 5 周（09-14 ~ 09-18）/.test(opts),
    (opts.match(/第 5 周[^<]*/) || [''])[0]);
}
{ /* XSS 转义 */
  freshState({ students: ['<img src=x onerror=alert(1)>'], headcount: 1, week: 5 });
  A.renderSheet();
  const html = elc('#tableHost').innerHTML;
  ok('B24', '学生姓名做 HTML 转义（防 XSS）', !/<img src=x/.test(html) && /&lt;img/.test(html),
    html.slice(html.indexOf('<tbody>'), html.indexOf('<tbody>') + 200));
}

/* ============================ 9. localStorage ============================ */
{
  app.store.clear();
  const s = freshState({ students: ['甲', '乙'], week: 7 });
  s.marks['w7'] = { '0-1-3': '○' };
  s.leaves = [{ id: 'L9', name: '甲', type: '事假', approve: '通过', start: '2026-10-05T08:30', end: '2026-10-05T10:10' }];
  A.saveState();
  ok('L01', 'saveState 写入 localStorage', app.store.has(A.STORAGE_KEY));
  const back = A.loadState();
  eq('L02', '回读学生名单', back.students, ['甲', '乙']);
  eq('L03', '回读当前周', back.week, 7);
  eq('L04', '回读手动标记', back.marks['w7'], { '0-1-3': '○' });
  eq('L05', '回读请假记录条数', back.leaves.length, 1);
  eq('L06', '回读学期起始日', back.termStart, '2026-08-17');
  eq('L07', '回读课表条目数', Object.keys(back.schedule).length, 5);
}
{
  app.store.set(A.STORAGE_KEY, '{{{ not json');
  const bad = A.loadState();
  ok('L08', 'localStorage 脏数据(JSON损坏) → 回退默认值不崩溃',
    bad && bad.termStart === '2026-08-17', String(bad && bad.termStart));
}
{
  app.store.set(A.STORAGE_KEY, JSON.stringify({ week: 'abc', students: null, headcount: -3 }));
  const bad = A.normalizeState(JSON.parse(app.store.get(A.STORAGE_KEY)));
  eq('L09', '非法 week 被纠正为 1', bad.week, 1);
  eq('L10', 'null 名单回退 49 空行', bad.students.length, 49);
  eq('L11', '负数应到人数回退 49', bad.headcount, 49);
  app.store.clear();
}

/* ============================ 10. 导出 Excel（真实 xlsx 回读） ============================ */
function grabWorkbook() {
  const XLSX = app.XLSX;
  const orig = XLSX.writeFile;
  let captured = null, err = null;
  XLSX.writeFile = function (wb) { captured = wb; };
  try { A.exportExcel(); } catch (e) { err = e; }
  XLSX.writeFile = orig;
  return { captured, err };
}
{
  const s = freshState({ students: ['张X', '李四'], headcount: 2, week: 5 });
  s.leaves = [{ id: 'L1', name: '张X', type: '病假', approve: '通过', start: '2026-09-15T08:30', end: '2026-09-15T10:10' }];
  A.renderSheet();                                   // 先让 #specialNote 有内容
  const { captured, err } = grabWorkbook();
  ok('E01', 'exportExcel 执行无异常', !err, err ? err.message : '');
  ok('E02', 'exportExcel 生成了工作簿', !!captured);

  if (captured) {
    const XLSX = app.XLSX;
    const ws = captured.Sheets[captured.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const flat = rows.map(r => r.join('|')).join('\n');
    ok('E03', 'Excel 行1 含「上课考勤表」', /上课考勤表/.test(String(rows[0][0])), String(rows[0][0]));
    ok('E04', 'Excel 行2 含「第 5 周」与 2026 年 09 月 14 日 ~ 09 月 18 日',
      /第\s*5\s*周/.test(String(rows[1][0])) && /2026/.test(String(rows[1][0])) &&
      /14/.test(String(rows[1][0])) && /18/.test(String(rows[1][0])), String(rows[1][0]));
    ok('E05', 'Excel 含学生「张X」', /张X/.test(flat));
    ok('E06', 'Excel 含学生「李四」', /李四/.test(flat));
    eq('E07', 'Excel 列数 = 53（序号+姓名+50节+签字）',
      XLSX.utils.decode_range(ws['!ref']).e.c + 1, 53);

    const ri = rows.findIndex(r => String(r[1]).trim() === '张X');
    ok('E08', '定位到「张X」数据行', ri > 0, 'rowIdx=' + ri);
    if (ri > 0) {
      const row = rows[ri];
      // 列布局：0=序号 1=姓名；周二 = 第2个 block → 起始列 2+10=12
      eq('E09', '序号列 = 1', String(row[0]).trim(), '1');
      eq('E10', '第5周周二第1节 = ○', String(row[12 + 0]).trim(), '○');
      eq('E11', '第5周周二第2节 = ○', String(row[12 + 1]).trim(), '○');
      eq('E12', '第5周周二第5节 = 空（未误标）', String(row[12 + 4]).trim(), '');
      eq('E13', '第5周周一第3节 = 空（非请假时段）', String(row[2 + 2]).trim(), '');
    }
    const lrow = rows.findIndex(r => String(r[1]).trim() === '李四');
    eq('E14', '未请假学生「李四」整行无标记',
      rows[lrow].slice(2, 52).filter(v => String(v).trim() !== '').length, 0);

    ok('E15', 'Excel 含注释行「注：考勤符号」', /注：考勤符号/.test(flat));
    ok('E16', 'Excel 注释行含四种符号说明', /○/.test(flat) && /\+/.test(flat) && /Δ/.test(flat));
    ok('E17', 'Excel 含「负责人签字」', /负责人签字/.test(flat));
    ok('E18', 'Excel 含「特殊情况说明」', /特殊情况说明/.test(flat));
    ok('E19', 'Excel 含「班主任签字」「班委会签字」', /班主任签字/.test(flat) && /班委会签字/.test(flat));
    ok('E20', 'Excel 已设置合并单元格', Array.isArray(ws['!merges']) && ws['!merges'].length > 5,
      'merges=' + (ws['!merges'] || []).length);
  }
}
{
  // 手动标记也应导出
  const s = freshState({ students: ['甲', '乙'], headcount: 2, week: 5 });
  s.marks['w5'] = { '1-3-5': '+' };
  A.renderSheet();
  const { captured } = grabWorkbook();
  if (captured) {
    const XLSX = app.XLSX;
    const rows = XLSX.utils.sheet_to_json(captured.Sheets[captured.SheetNames[0]], { header: 1, defval: '' });
    const ri = rows.findIndex(r => String(r[1]).trim() === '乙');
    // 周三 = 第3个 block → 起始列 2+20=22；第5节 → +4
    eq('E21', '手动标记「+」导出到 周三第5节', String(rows[ri][22 + 4]).trim(), '+');
  } else { ok('E21', '手动标记导出', false, '未捕获工作簿'); }
}
{
  // 真实落盘再回读：验证导出的 .xlsx 文件可被标准解析器读回且内容一致
  const s = freshState({ students: ['甲', '乙'], headcount: 2, week: 5 });
  s.marks['w5'] = { '0-1-3': '○' };
  A.renderSheet();
  const XLSX = app.XLSX;
  let captured = null;
  const orig = XLSX.writeFile;
  XLSX.writeFile = function (wb) { captured = wb; };
  A.exportExcel();
  XLSX.writeFile = orig;
  if (captured) {
    const buf = XLSX.write(captured, { type: 'buffer', bookType: 'xlsx' });
    ok('E22', '导出的工作簿可序列化为合法 xlsx 字节流（>2KB）', buf && buf.length > 2048,
      'bytes=' + (buf ? buf.length : 0));
    const rb = XLSX.read(buf, { type: 'buffer' });
    const rows2 = XLSX.utils.sheet_to_json(rb.Sheets[rb.SheetNames[0]], { header: 1, defval: '' });
    const ri = rows2.findIndex(r => String(r[1]).trim() === '甲');
    eq('E23', '落盘再回读：周一第3节仍为 ○', String(rows2[ri][2 + 2]).trim(), '○');
    eq('E24', '落盘再回读：合并单元格信息保留',
      Array.isArray(rb.Sheets[rb.SheetNames[0]]['!merges']), true);
  } else {
    ok('E22', '导出序列化', false, '未捕获工作簿');
  }
}

/* ============================ 输出 ============================ */
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log('\n==================== 测试结果 ====================');
results.forEach(r => {
  console.log((r.pass ? 'PASS ' : 'FAIL ') + r.id + ' | ' + r.name +
    (r.pass ? '' : '\n        >>> ' + r.detail));
});
console.log('\n--------------------------------------------------');
console.log('通过率: ' + pass + '/' + results.length + ' PASS (' +
  (pass / results.length * 100).toFixed(1) + '%)');
if (fail.length) {
  console.log('\n失败项 (' + fail.length + '):');
  fail.forEach(r => console.log('  - [' + r.id + '] ' + r.name + '\n      期望/实际: ' + r.detail));
}
console.log('\nIS_PASS=' + (fail.length === 0 ? 'PASS' : 'FAIL'));
