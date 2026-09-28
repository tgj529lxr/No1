/**
 * check-workflows.js —— GitHub Actions 工作流 YAML 结构校验（零依赖）
 *
 * 不引入 yaml 依赖，只做「够用的结构性检查」，用于 CI 配置提交前的自查：
 *   1. 不允许用 Tab 缩进；
 *   2. 流程控制行必须是 2 空格整数倍缩进；
 *   3. 顶层必须包含 name / on / jobs；
 *   4. 每个 job 必须包含 runs-on 与 steps；
 *   5. 每个 step 必须有 name，且具备 uses 或 run 之一（不能两个都没有，也不能同时写）；
 *   6. 按白名单检查关键 step 是否齐全。
 *
 * 用法：node tests/check-workflows.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

/** 每个工作流必须包含的 step 名称片段（模糊匹配，便于后续改名仍能通过）。 */
const REQUIRED_STEPS = {
  'build-apk.yml': [
    'checkout',
    'setup-node',
    'setup-java',
    'setup-android',
    'cap sync',
    'AndroidManifest',
    'assembleDebug',
    'upload-artifact'
  ],
  'deploy-pages.yml': [
    'checkout',
    'setup-node',
    'npm run build',
    'configure-pages',
    'upload-pages-artifact',
    'deploy-pages'
  ]
};

const REQUIRED_TOP_KEYS = ['name', 'on', 'jobs'];

/**
 * 把 YAML 文本拆成「结构行」，并顺带标注块标量（| / >）内部的行。
 * @param {string} text YAML 原文
 * @returns {{lines: Array<Object>, errors: string[]}} 解析结果
 */
function parseLines(text) {
  /** @type {Array<Object>} */
  const lines = [];
  /** @type {string[]} */
  const errors = [];

  const raw = text.replace(/\r\n/g, '\n').split('\n');
  let blockScalarIndent = -1; // >=0 表示正处于某个块标量内部

  raw.forEach(function (originalLine, index) {
    const lineNo = index + 1;

    if (originalLine.trim() === '' || originalLine.trimStart().startsWith('#')) {
      return; // 空行与注释行不参与结构校验
    }
    if (/\t/.test(originalLine.slice(0, originalLine.search(/\S|$/)))) {
      errors.push('第 ' + lineNo + ' 行：禁止使用 Tab 缩进');
    }

    const indent = originalLine.length - originalLine.trimStart().length;

    if (blockScalarIndent >= 0) {
      if (indent > blockScalarIndent) {
        return; // 属于块标量正文，跳过
      }
      blockScalarIndent = -1; // 缩进回到 key 层级或更浅，块标量结束
    }

    if (indent % 2 !== 0) {
      errors.push('第 ' + lineNo + ' 行：缩进不是 2 的整数倍（indent=' + indent + '）');
    }

    let body = originalLine.trim();
    let isListItem = false;
    if (body.startsWith('- ')) {
      isListItem = true;
      body = body.slice(2);
    } else if (body === '-') {
      isListItem = true;
      body = '';
    }

    const matched = /^([A-Za-z0-9_-]+):(.*)$/.exec(body);
    if (!matched) {
      lines.push({ lineNo: lineNo, indent: indent, key: null, raw: body, listItem: isListItem });
      return;
    }

    const key = matched[1];
    const value = matched[2].trim();

    if (/^[|>][-+]?$/.test(value)) {
      blockScalarIndent = indent; // 后续更深的缩进都是脚本正文
    } else if (/^[|>][-+]?\s+/.test(value)) {
      errors.push('第 ' + lineNo + ' 行：块标量指示符后不允许跟随内容');
    }

    lines.push({
      lineNo: lineNo,
      indent: indent,
      key: key,
      value: value,
      raw: body,
      listItem: isListItem
    });
  });

  return { lines: lines, errors: errors };
}

/**
 * 收集某个 key 在指定缩进层级下的所有子 key（只看直接子节点）。
 * @param {Array<Object>} lines 结构行
 * @param {number} startIndex 父节点所在下标
 * @param {number} childIndent 子节点缩进
 * @returns {Array<Object>} 子节点列表
 */
function childrenOf(lines, startIndex, childIndent) {
  /** @type {Array<Object>} */
  const children = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent < childIndent) {
      break;
    }
    if (line.indent === childIndent && line.key) {
      children.push(line);
    }
  }
  return children;
}

/**
 * 校验单个工作流文件。
 * @param {string} fileAbs 文件绝对路径
 * @returns {Object} 校验报告
 */
function checkWorkflow(fileAbs) {
  const name = path.basename(fileAbs);
  const text = fs.readFileSync(fileAbs, 'utf8');
  const parsed = parseLines(text);
  const lines = parsed.lines;
  const errors = parsed.errors.slice();

  const topKeys = lines.filter(function (l) { return l.indent === 0 && l.key; })
    .map(function (l) { return l.key; });

  REQUIRED_TOP_KEYS.forEach(function (key) {
    if (topKeys.indexOf(key) === -1) {
      errors.push('缺少顶层字段：' + key);
    }
  });

  const jobsIndex = lines.findIndex(function (l) { return l.indent === 0 && l.key === 'jobs'; });
  /** @type {Array<Object>} */
  const jobs = [];
  if (jobsIndex !== -1) {
    childrenOf(lines, jobsIndex, 2).forEach(function (jobLine) {
      const jobChildren = childrenOf(lines, lines.indexOf(jobLine), 4);
      const jobKeys = jobChildren.map(function (l) { return l.key; });
      if (jobKeys.indexOf('runs-on') === -1) {
        errors.push('job `' + jobLine.key + '` 缺少 runs-on');
      }
      if (jobKeys.indexOf('steps') === -1) {
        errors.push('job `' + jobLine.key + '` 缺少 steps');
      }

      const stepsLine = jobChildren.find(function (l) { return l.key === 'steps'; });
      if (stepsLine) {
        const stepsIndex = lines.indexOf(stepsLine);
        // steps 的子项是 "- key: ..." 形式：列表项缩进 +2，列表项内部字段再 +2
        const firstItem = lines.slice(stepsIndex + 1).find(function (l) {
          return l.indent > stepsLine.indent && l.listItem;
        });
        const itemIndent = firstItem ? firstItem.indent : stepsLine.indent + 2;
        const itemBodyIndent = itemIndent + 2;

        /** @type {Array<Object>} */
        const stepLines = [];
        for (let i = stepsIndex + 1; i < lines.length; i += 1) {
          const l = lines[i];
          if (l.indent < itemIndent) {
            break;
          }
          if (l.indent === itemIndent && l.listItem && l.key === 'name') {
            stepLines.push(l);
          }
        }
        stepLines.forEach(function (stepLine) {
          const idx = lines.indexOf(stepLine);
          const bodyKeys = [];
          for (let i = idx + 1; i < lines.length; i += 1) {
            const l = lines[i];
            if (l.indent < itemBodyIndent) {
              break;
            }
            if (l.indent === itemBodyIndent && l.key) {
              bodyKeys.push(l.key);
            }
          }
          const hasUses = bodyKeys.indexOf('uses') !== -1;
          const hasRun = bodyKeys.indexOf('run') !== -1;
          if (!hasUses && !hasRun) {
            errors.push('step `' + stepLine.value + '` 既没有 uses 也没有 run');
          }
          if (hasUses && hasRun) {
            errors.push('step `' + stepLine.value + '` 同时写了 uses 和 run');
          }
          stepLine.stepBodyKeys = bodyKeys;
        });

        const allStepText = stepLines
          .map(function (l) { return (l.value || '') + ' ' + (l.stepBodyKeys || []).join(' '); })
          .join(' | ')
          .toLowerCase();
        const stepContents = text.toLowerCase();
        (REQUIRED_STEPS[name] || []).forEach(function (needle) {
          if (allStepText.indexOf(needle.toLowerCase()) === -1 &&
              stepContents.indexOf(needle.toLowerCase()) === -1) {
            errors.push('缺少关键步骤 / 关键字：' + needle);
          }
        });

        jobs.push({
          name: jobLine.key,
          runsOn: (jobChildren.find(function (l) { return l.key === 'runs-on'; }) || {}).value || '',
          steps: stepLines.map(function (l) {
            return (l.value || '').replace(/^"|"$/g, '') +
              ' [' + ((l.stepBodyKeys || []).indexOf('uses') !== -1 ? 'uses' : 'run') + ']';
          })
        });
      }
    });
  }

  if (!jobs.length && jobsIndex !== -1) {
    errors.push('jobs 下没有解析到任何 job');
  }

  return { name: name, errors: errors, jobs: jobs };
}

/**
 * 程序入口。
 * @returns {void}
 */
function main() {
  if (!fs.existsSync(WORKFLOW_DIR)) {
    console.error('[check-workflows] 目录不存在：' + WORKFLOW_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(WORKFLOW_DIR)
    .filter(function (f) { return f.endsWith('.yml') || f.endsWith('.yaml'); });

  if (!files.length) {
    console.error('[check-workflows] 没有找到任何工作流文件');
    process.exit(1);
  }

  let failed = 0;
  files.forEach(function (file) {
    const report = checkWorkflow(path.join(WORKFLOW_DIR, file));
    console.log('\n=== ' + report.name + ' ===');
    report.jobs.forEach(function (job) {
      console.log('job: ' + job.name + '  (runs-on: ' + job.runsOn + ')');
      job.steps.forEach(function (step, idx) {
        console.log('  ' + String(idx + 1).padStart(2, '0') + '. ' + step);
      });
    });
    if (report.errors.length) {
      failed += 1;
      console.log('结果：FAIL');
      report.errors.forEach(function (e) { console.log('  ✗ ' + e); });
    } else {
      console.log('结果：PASS（结构完整，' + report.jobs.length + ' 个 job）');
    }
  });

  console.log('\n[check-workflows] 共 ' + files.length + ' 个文件，失败 ' + failed + ' 个');
  process.exit(failed === 0 ? 0 : 1);
}

main();
